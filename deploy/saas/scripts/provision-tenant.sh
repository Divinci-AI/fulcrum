#!/usr/bin/env bash
# provision-tenant.sh — spin up a new Fulcrum tenant (D-10 PR 2)
#
# Idempotent. Re-running with the same slug picks up where it left off
# (existing CF objects detected by name match, existing data dir
# preserved). Use teardown-tenant.sh to remove.
#
# Usage:
#   ./scripts/provision-tenant.sh --slug=acme --owner=owner@divinci.ai
#   ./scripts/provision-tenant.sh --slug=foo --owner=ceo@foo.com \
#       --domain=foo.fulcrum.divinci.ai
#
# Required env vars (~/.zshrc):
#   GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
#   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_ZONE_ID
#     (CF token must currently verify as "active" — see RUNBOOK §8)
#
# Flags:
#   --slug=<slug>     Required. Tenant slug. Becomes the container name,
#                     data dir, stack file name, and DNS subdomain.
#   --owner=<email>   Required. Email of the tenant admin (added to the
#                     Access policy).
#   --domain=<host>   Optional. Public hostname. Default:
#                     <slug>.fulcrum.divinci.ai
#   --skip-cf         Skip every Cloudflare API call. Use when the token
#                     is temporarily 401 (per RUNBOOK §8) and you just
#                     want to render+start the container.
#   --dry-run         Print the actions; don't execute.
#   --help|-h

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# --- Defaults & args ---
SLUG=""
OWNER=""
DOMAIN=""
SKIP_CF=0
DRY_RUN=0

usage() {
  sed -n '2,/^source /p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^source /d'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --slug=*)   SLUG="${arg#*=}" ;;
    --owner=*)  OWNER="${arg#*=}" ;;
    --domain=*) DOMAIN="${arg#*=}" ;;
    --skip-cf)  SKIP_CF=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    --help|-h)  usage 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage 1 ;;
  esac
done

[ -n "$SLUG" ]  || die "Missing --slug. Try --help."
[ -n "$OWNER" ] || die "Missing --owner. Try --help."
validate_slug "$SLUG"
DOMAIN="${DOMAIN:-fulcrum-${SLUG}.divinci.ai}"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[1;35m[dry-run]\033[0m %s\n' "$*" >&2
  else
    eval "$@"
  fi
}

# --- Sanity checks on operator env ---
[ -n "${GOOGLE_CLIENT_ID:-}" ]     || die "GOOGLE_CLIENT_ID not in env"
[ -n "${GOOGLE_CLIENT_SECRET:-}" ] || die "GOOGLE_CLIENT_SECRET not in env"

if [ "$SKIP_CF" -eq 0 ]; then
  if ! cf_check_token; then
    warn "CLOUDFLARE_API_TOKEN not valid (per /user/tokens/verify). Re-run with --skip-cf or rotate per RUNBOOK §8."
    die "Aborting before any state changes."
  fi
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID not in env"
  [ -n "${CLOUDFLARE_ZONE_ID:-}" ]    || die "CLOUDFLARE_ZONE_ID not in env"
fi

REPO_ROOT="$(fulcrum_repo_root)"
TEMPLATE="$REPO_ROOT/deploy/saas/docker-compose.tenant.sidecar.template.yaml"
[ -f "$TEMPLATE" ] || die "Sidecar template not found at $TEMPLATE"

log "Provisioning tenant slug=$SLUG owner=$OWNER domain=$DOMAIN"

# --- Step 1: idempotent CF Access App + Policy ---
TUNNEL_TOKEN=""
if [ "$SKIP_CF" -eq 0 ]; then
  log "Looking up existing CF Access app for $DOMAIN…"
  EXISTING_APP_ID=$(cf_api GET \
    "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" \
    | jq -r --arg d "$DOMAIN" '.result[] | select(.domain == $d) | .id' | head -n1)
  if [ -n "$EXISTING_APP_ID" ]; then
    log "Reusing existing Access app $EXISTING_APP_ID"
    APP_ID="$EXISTING_APP_ID"
  else
    log "Creating CF Access app for $DOMAIN…"
    APP_PAYLOAD=$(jq -n --arg n "Fulcrum ${SLUG}" --arg d "$DOMAIN" \
      '{name: $n, domain: $d, type: "self_hosted", session_duration: "24h"}')
    APP_ID=$(run "cf_api POST '/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps' '$APP_PAYLOAD' | jq -r '.result.id'")
  fi

  log "Creating Access policy: include $OWNER…"
  POLICY_PAYLOAD=$(jq -n --arg n "Allow ${SLUG} owner" --arg e "$OWNER" \
    '{name: $n, decision: "allow", include: [{email: {email: $e}}]}')
  run "cf_api POST '/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${APP_ID}/policies' '$POLICY_PAYLOAD' >/dev/null"

  log "Creating Cloudflare Tunnel…"
  TUNNEL_PAYLOAD=$(jq -n --arg n "fulcrum-${SLUG}" \
    '{name: $n, config_src: "cloudflare"}')
  TUNNEL_RESPONSE=$(run "cf_api POST '/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel' '$TUNNEL_PAYLOAD'")
  TUNNEL_ID=$(echo "$TUNNEL_RESPONSE" | jq -r '.result.id')
  TUNNEL_TOKEN=$(echo "$TUNNEL_RESPONSE" | jq -r '.result.token')

  log "Configuring tunnel ingress: $DOMAIN → http://fulcrum:7777…"
  INGRESS_PAYLOAD=$(jq -n --arg h "$DOMAIN" \
    '{config: {ingress: [{hostname: $h, service: "http://fulcrum:7777"}, {service: "http_status:404"}]}}')
  run "cf_api PUT '/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations' '$INGRESS_PAYLOAD' >/dev/null"

  log "Creating DNS CNAME $DOMAIN → ${TUNNEL_ID}.cfargotunnel.com…"
  DNS_PAYLOAD=$(jq -n --arg n "$DOMAIN" --arg c "${TUNNEL_ID}.cfargotunnel.com" \
    '{type: "CNAME", name: $n, content: $c, proxied: true}')
  run "cf_api POST '/zones/${CLOUDFLARE_ZONE_ID}/dns_records' '$DNS_PAYLOAD' >/dev/null"
else
  warn "--skip-cf: no CF Access app, no tunnel, no DNS. You will need to wire these manually before the tenant is reachable."
  warn "TUNNEL_TOKEN will be empty in the rendered compose file; cloudflared sidecar will not start."
fi

# --- Step 2: render the compose template + push to the host ---
TMP_STACK=$(mktemp -t "fulcrum-stack-${SLUG}-XXXXXX.yaml")
trap "rm -f '$TMP_STACK'" EXIT

log "Rendering compose template → $TMP_STACK"
TENANT_SLUG="$SLUG" \
  FULCRUM_TENANT_DOMAIN="$DOMAIN" \
  GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID}" \
  GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET}" \
  CLOUDFLARED_TUNNEL_TOKEN="${TUNNEL_TOKEN}" \
  FULCRUM_SAAS_ROOT="/opt/fulcrum-saas" \
  envsubst < "$TEMPLATE" > "$TMP_STACK"

log "Uploading stack file to GCE host…"
run "gce_scp '$TMP_STACK' '${GCE_INSTANCE}:/tmp/${SLUG}.yaml'"
run "gce_ssh 'sudo mkdir -p /opt/fulcrum-saas/stacks && sudo mv /tmp/${SLUG}.yaml /opt/fulcrum-saas/stacks/${SLUG}.yaml && sudo mkdir -p /opt/fulcrum-saas/data/${SLUG}'"

# --- Step 3: bring up the stack ---
log "Bringing up container $SLUG…"
run "gce_ssh 'FULCRUM_SAAS_ROOT=/opt/fulcrum-saas docker compose -p fulcrum-saas --project-directory /opt/fulcrum-saas -f /opt/fulcrum-saas/stacks/${SLUG}.yaml up -d'"

# --- Step 4: wait healthy ---
log "Waiting for fulcrum-${SLUG} to become healthy…"
for i in $(seq 1 30); do
  STATUS=$(gce_ssh "docker inspect -f '{{.State.Health.Status}}' fulcrum-${SLUG} 2>/dev/null || echo missing")
  log "  [$i] health: $STATUS"
  if [ "$STATUS" = "healthy" ]; then break; fi
  sleep 3
done

if [ "$STATUS" = "healthy" ]; then
  log "✓ Tenant $SLUG provisioned. Public URL: https://${DOMAIN}"
else
  warn "Tenant container reached state '$STATUS' (not 'healthy'). Inspect with: gce_ssh 'docker logs fulcrum-${SLUG}'"
  exit 1
fi
