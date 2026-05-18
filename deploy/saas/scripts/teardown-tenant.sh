#!/usr/bin/env bash
# teardown-tenant.sh — remove a Fulcrum tenant (D-10 PR 2)
#
# Stops + removes the container, removes the stack file, optionally
# removes Cloudflare resources (Access app, tunnel, DNS) and the data
# directory. Defaults to KEEPING data + CF resources so accidental
# tearndowns don't lose state.
#
# Usage:
#   ./scripts/teardown-tenant.sh --slug=acme            # stop+rm container
#   ./scripts/teardown-tenant.sh --slug=acme --purge    # also remove data, CF, DNS
#   ./scripts/teardown-tenant.sh --slug=acme --rm-data  # data only
#   ./scripts/teardown-tenant.sh --slug=acme --rm-cf    # CF resources only
#   ./scripts/teardown-tenant.sh --slug=acme --dry-run
#   ./scripts/teardown-tenant.sh --help

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

SLUG=""
RM_DATA=0
RM_CF=0
DRY_RUN=0

usage() {
  sed -n '2,/^source /p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^source /d'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --slug=*)   SLUG="${arg#*=}" ;;
    --rm-data)  RM_DATA=1 ;;
    --rm-cf)    RM_CF=1 ;;
    --purge)    RM_DATA=1; RM_CF=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    --help|-h)  usage 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage 1 ;;
  esac
done

[ -n "$SLUG" ] || die "Missing --slug. Try --help."
validate_slug "$SLUG"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[1;35m[dry-run]\033[0m %s\n' "$*" >&2
  else
    eval "$@"
  fi
}

log "Tearing down tenant=$SLUG rm-data=$RM_DATA rm-cf=$RM_CF"

# --- Step 1: stop + remove the container, remove the stack file ---
log "Stopping container fulcrum-${SLUG}…"
run "gce_ssh 'docker stop fulcrum-${SLUG} 2>/dev/null || true; docker rm fulcrum-${SLUG} 2>/dev/null || true'"
run "gce_ssh 'docker stop fulcrum-${SLUG}-cloudflared 2>/dev/null || true; docker rm fulcrum-${SLUG}-cloudflared 2>/dev/null || true'"
run "gce_ssh 'sudo rm -f /opt/fulcrum-saas/stacks/${SLUG}.yaml'"

# --- Step 2: optionally remove data dir ---
if [ "$RM_DATA" -eq 1 ]; then
  log "Removing data dir /opt/fulcrum-saas/data/${SLUG}…"
  run "gce_ssh 'sudo rm -rf /opt/fulcrum-saas/data/${SLUG}'"
else
  log "Keeping data dir /opt/fulcrum-saas/data/${SLUG} (pass --rm-data to remove)"
fi

# --- Step 3: optionally remove CF resources ---
if [ "$RM_CF" -eq 1 ]; then
  if ! cf_check_token; then
    warn "CLOUDFLARE_API_TOKEN invalid — skipping CF cleanup. Remove resources manually in the dashboard."
  else
    DOMAIN="${SLUG}.fulcrum.divinci.ai"

    log "Looking up CF Access app for $DOMAIN…"
    APP_ID=$(cf_api GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" \
      | jq -r --arg d "$DOMAIN" '.result[] | select(.domain == $d) | .id' | head -n1)
    if [ -n "$APP_ID" ]; then
      log "Deleting Access app $APP_ID"
      run "cf_api DELETE '/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${APP_ID}' >/dev/null"
    fi

    log "Looking up tunnel fulcrum-${SLUG}…"
    TUNNEL_ID=$(cf_api GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel" \
      | jq -r --arg n "fulcrum-${SLUG}" '.result[] | select(.name == $n) | .id' | head -n1)
    if [ -n "$TUNNEL_ID" ]; then
      log "Deleting tunnel $TUNNEL_ID"
      run "cf_api DELETE '/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}' >/dev/null"
    fi

    log "Looking up DNS record for $DOMAIN…"
    DNS_ID=$(cf_api GET "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${DOMAIN}" \
      | jq -r '.result[0].id // empty')
    if [ -n "$DNS_ID" ]; then
      log "Deleting DNS record $DNS_ID"
      run "cf_api DELETE '/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${DNS_ID}' >/dev/null"
    fi
  fi
else
  log "Keeping CF resources (pass --rm-cf or --purge to remove)"
fi

log "✓ Teardown of $SLUG complete"
