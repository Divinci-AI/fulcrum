#!/usr/bin/env bash
# cutover-to-sidecar.sh — migrate a tenant from host-cloudflared to
# the sidecar pattern (D-10 PR 2). One-time per tenant; required
# when N>1 tenants share a host because the legacy template publishes
# host port 7777, which collides.
#
# Sequence (with operator approval at each gate):
#   1. Sanity-check that the tenant currently uses the legacy template
#   2. Create a new Cloudflare Tunnel + token + ingress config
#   3. Re-render with sidecar template, push to host
#   4. Stop legacy container, start sidecar pair, wait healthy
#   5. Remove the tenant's entry from host systemd cloudflared (manual
#      step printed at end — we don't touch host systemd from this script)
#
# Usage:
#   ./scripts/cutover-to-sidecar.sh --slug=acme
#   ./scripts/cutover-to-sidecar.sh --slug=acme --dry-run
#   ./scripts/cutover-to-sidecar.sh --help

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

SLUG=""
DRY_RUN=0

usage() {
  sed -n '2,/^source /p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^source /d'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --slug=*)  SLUG="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage 1 ;;
  esac
done

[ -n "$SLUG" ] || die "Missing --slug."
validate_slug "$SLUG"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[1;35m[dry-run]\033[0m %s\n' "$*" >&2
  else
    eval "$@"
  fi
}

REPO_ROOT="$(fulcrum_repo_root)"
SIDECAR_TEMPLATE="$REPO_ROOT/deploy/saas/docker-compose.tenant.sidecar.template.yaml"
[ -f "$SIDECAR_TEMPLATE" ] || die "Sidecar template not found at $SIDECAR_TEMPLATE"

# --- Preflight ---
log "Preflight checks for tenant=$SLUG"

if ! cf_check_token; then
  die "CLOUDFLARE_API_TOKEN not valid. Rotate per RUNBOOK §8, then re-run."
fi
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID not in env"
[ -n "${GOOGLE_CLIENT_ID:-}" ]      || die "GOOGLE_CLIENT_ID not in env"
[ -n "${GOOGLE_CLIENT_SECRET:-}" ]  || die "GOOGLE_CLIENT_SECRET not in env"

# Sanity-check the host has the legacy stack (otherwise nothing to migrate)
LEGACY=$(gce_ssh "test -f /opt/fulcrum-saas/stacks/${SLUG}.yaml && grep -c 'ports:' /opt/fulcrum-saas/stacks/${SLUG}.yaml || echo 0")
if [ "${LEGACY:-0}" -eq 0 ]; then
  die "No legacy host-cloudflared stack found for slug=$SLUG. Already on sidecar?"
fi
log "Confirmed legacy stack on host (port-publish detected)."

DOMAIN="${DOMAIN:-fulcrum-${SLUG}.divinci.ai}"

# --- Create a new tunnel for the tenant (the existing one is owned by
# host systemd cloudflared; better to leave it alone and create a
# clean per-tenant one). ---
log "Creating new tunnel fulcrum-${SLUG}-sidecar…"
TUNNEL_PAYLOAD=$(jq -n --arg n "fulcrum-${SLUG}-sidecar" \
  '{name: $n, config_src: "cloudflare"}')
TUNNEL_RESPONSE=$(run "cf_api POST '/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel' '$TUNNEL_PAYLOAD'")
TUNNEL_ID=$(echo "$TUNNEL_RESPONSE" | jq -r '.result.id')
TUNNEL_TOKEN=$(echo "$TUNNEL_RESPONSE" | jq -r '.result.token')

log "Configuring tunnel ingress: $DOMAIN → http://fulcrum:7777…"
INGRESS_PAYLOAD=$(jq -n --arg h "$DOMAIN" \
  '{config: {ingress: [{hostname: $h, service: "http://fulcrum:7777"}, {service: "http_status:404"}]}}')
run "cf_api PUT '/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations' '$INGRESS_PAYLOAD' >/dev/null"

# --- Render the sidecar stack ---
TMP_STACK=$(mktemp -t "fulcrum-stack-${SLUG}-sidecar-XXXXXX.yaml")
trap "rm -f '$TMP_STACK'" EXIT

log "Rendering sidecar template → $TMP_STACK"
TENANT_SLUG="$SLUG" \
  FULCRUM_TENANT_DOMAIN="$DOMAIN" \
  GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID}" \
  GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET}" \
  CLOUDFLARED_TUNNEL_TOKEN="${TUNNEL_TOKEN}" \
  FULCRUM_SAAS_ROOT="/opt/fulcrum-saas" \
  envsubst < "$SIDECAR_TEMPLATE" > "$TMP_STACK"

log "Uploading sidecar stack to host…"
run "gce_scp '$TMP_STACK' '${GCE_INSTANCE}:/tmp/${SLUG}-sidecar.yaml'"

# --- Cutover ---
log "Stopping legacy container…"
run "gce_ssh 'docker stop fulcrum-${SLUG} && docker rm fulcrum-${SLUG}'"

log "Swapping stack file…"
run "gce_ssh 'sudo mv /opt/fulcrum-saas/stacks/${SLUG}.yaml /opt/fulcrum-saas/stacks/${SLUG}.yaml.legacy.bak && sudo mv /tmp/${SLUG}-sidecar.yaml /opt/fulcrum-saas/stacks/${SLUG}.yaml'"

log "Bringing up sidecar pair…"
run "gce_ssh 'FULCRUM_SAAS_ROOT=/opt/fulcrum-saas docker compose -p fulcrum-saas --project-directory /opt/fulcrum-saas -f /opt/fulcrum-saas/stacks/${SLUG}.yaml up -d'"

log "Waiting for fulcrum-${SLUG} to become healthy…"
for i in $(seq 1 30); do
  STATUS=$(gce_ssh "docker inspect -f '{{.State.Health.Status}}' fulcrum-${SLUG} 2>/dev/null || echo missing")
  log "  [$i] health: $STATUS"
  if [ "$STATUS" = "healthy" ]; then break; fi
  sleep 3
done

if [ "$STATUS" != "healthy" ]; then
  warn "Sidecar container failed to become healthy."
  warn "Rollback: gce_ssh 'docker compose ... down && sudo mv /opt/fulcrum-saas/stacks/${SLUG}.yaml.legacy.bak /opt/fulcrum-saas/stacks/${SLUG}.yaml' then re-run docker compose up"
  exit 1
fi

log "✓ Sidecar cutover complete for $SLUG. Public URL: https://${DOMAIN}"
log ""
log "Manual follow-up (cannot be automated from this script):"
log "  1. SSH to ${GCE_INSTANCE} and edit /etc/cloudflared/config.yml (or"
log "     equivalent host cloudflared config) to remove the ingress entry"
log "     for ${DOMAIN}."
log "  2. systemctl restart cloudflared on the host."
log "  3. Confirm https://${DOMAIN} still resolves (the new sidecar tunnel"
log "     now serves it; the old host tunnel no longer matters)."
log "  4. Once happy: rm /opt/fulcrum-saas/stacks/${SLUG}.yaml.legacy.bak"
