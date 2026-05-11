#!/usr/bin/env bash
#
# org-create.sh — boot one Fulcrum-per-org container, end-to-end.
#
# Renders the Compose template, brings up the stack, polls /health, then
# provisions Cloudflare DNS + tunnel ingress + Access Group + Access App so
# https://<slug>.<base-domain> is reachable behind SSO.
#
# Pass --skip-cloudflare to stop after the container is healthy (useful for
# local validation before CF creds are configured on the host).
#
# Usage:
#     ./org-create.sh <slug> [--owner alice@acme.com] [--skip-cloudflare]
#
# Environment (set in ~/.zshrc):
#     GOOGLE_CLIENT_ID            — Divinci-AI Google OAuth client
#     GOOGLE_CLIENT_SECRET        — Divinci-AI Google OAuth secret
#     FULCRUM_SAAS_BASE_DOMAIN    — defaults to "fulcrum.divinci.ai"
#     FULCRUM_SAAS_IMAGE          — defaults to "divinci-ai/fulcrum:dev"
#     FULCRUM_SAAS_ROOT           — defaults to "/opt/fulcrum-saas" (on GCE);
#                                   "./fulcrum-saas-state" for local testing
#     CLOUDFLARE_API_TOKEN        — required unless --skip-cloudflare
#     CLOUDFLARE_ACCOUNT_ID       — required unless --skip-cloudflare
#     CLOUDFLARE_ZONE_ID          — required unless --skip-cloudflare
#     CLOUDFLARE_TUNNEL_ID        — required unless --skip-cloudflare
#
# Exit codes:
#     0  success
#     1  bad usage / missing env
#     2  stack failed to come up
#     3  Cloudflare API failure

set -euo pipefail

# -------- args --------
OWNER=""
SKIP_CLOUDFLARE=0
SLUG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --skip-cloudflare) SKIP_CLOUDFLARE=1; shift ;;
    --*) echo "unknown flag: $1" >&2; exit 1 ;;
    *) if [[ -z "$SLUG" ]]; then SLUG="$1"; shift; else echo "extra arg: $1" >&2; exit 1; fi ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  echo "usage: $0 <slug> [--owner alice@acme.com] [--skip-cloudflare]" >&2
  exit 1
fi

if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "error: slug must match ^[a-z][a-z0-9-]{1,30}$" >&2
  exit 1
fi

# -------- env --------
: "${GOOGLE_CLIENT_ID:?must be set — see deploy/saas/provisioning/README.md}"
: "${GOOGLE_CLIENT_SECRET:?must be set — see deploy/saas/provisioning/README.md}"

BASE_DOMAIN="${FULCRUM_SAAS_BASE_DOMAIN:-divinci.ai}"
IMAGE="${FULCRUM_SAAS_IMAGE:-divinci-ai/fulcrum:dev}"
ROOT="${FULCRUM_SAAS_ROOT:-/opt/fulcrum-saas}"
# Per-org hostnames are flat — `fulcrum-<slug>.divinci.ai`. The two-level
# scheme `<slug>.fulcrum.divinci.ai` is more readable but requires
# Cloudflare Advanced Certificate Manager ($10/mo per zone) since free
# Universal SSL only covers `*.divinci.ai` (one level deep). Flat naming
# stays inside the free cert and avoids per-tenant cert ops.
PUBLIC_SUBDOMAIN="fulcrum-${SLUG}"
HOSTNAME="${PUBLIC_SUBDOMAIN}.${BASE_DOMAIN}"
CONTAINER="fulcrum-${SLUG}"
STACK_FILE="${ROOT}/stacks/${SLUG}.yaml"
DATA_DIR="${ROOT}/data/${SLUG}"

# This script lives at deploy/saas/provisioning/org-create.sh, so the template
# is two dirs up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../docker-compose.tenant.template.yaml"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 1
fi

# -------- preflight --------
echo "[1/6] preflight — checking slug is free"
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container $CONTAINER already exists" >&2
  exit 1
fi
if [[ -d "$DATA_DIR" ]]; then
  echo "error: data dir $DATA_DIR already exists — refusing to overwrite" >&2
  exit 1
fi

# -------- render --------
echo "[2/6] rendering compose template → $STACK_FILE"
mkdir -p "${ROOT}/stacks" "$DATA_DIR"
# The Fulcrum container runs as the `bun` user (UID 1000 inside the image).
# When the host data dir is created here by root (via sudo), the in-container
# bun process can't mkdir /data/.fulcrum and crashes on first boot. Chown the
# host directory to the container's UID so the bind mount works.
chown -R 1000:1000 "$DATA_DIR"
ORG_SLUG="$SLUG" \
GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
TENANT_SLUG="$SLUG" \
PUBLIC_HOSTNAME="$HOSTNAME" \
  envsubst '${ORG_SLUG} ${TENANT_SLUG} ${GOOGLE_CLIENT_ID} ${GOOGLE_CLIENT_SECRET} ${PUBLIC_HOSTNAME}' \
  < "$TEMPLATE" \
  > "$STACK_FILE"

# The template references a shared docker network; create it if absent so the
# very first org create works.
if ! docker network inspect fulcrum-gateway >/dev/null 2>&1; then
  echo "      creating fulcrum-gateway docker network"
  docker network create fulcrum-gateway >/dev/null
fi

# -------- boot --------
echo "[3/6] docker compose up -d"
# --project-directory keeps the relative ./data/<slug> mount in the template
# resolving against $ROOT, not the script's cwd.
docker compose -f "$STACK_FILE" --project-directory "$ROOT" up -d

# -------- health --------
echo "[4/6] waiting for /health on $CONTAINER (60s max)"
for i in {1..30}; do
  if docker exec "$CONTAINER" wget -qO- http://localhost:7777/health >/dev/null 2>&1; then
    echo "      healthy"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo "error: $CONTAINER never became healthy. Recent logs:" >&2
    docker logs --tail 50 "$CONTAINER" >&2
    exit 2
  fi
done

# -------- cloudflare --------
if [[ "$SKIP_CLOUDFLARE" -eq 1 ]]; then
  echo "[5/6] cloudflare provisioning — skipped (--skip-cloudflare)"
else
  echo "[5/6] cloudflare provisioning"
  # shellcheck source=./_cf-api.sh
  source "${SCRIPT_DIR}/_cf-api.sh"
  if [[ -z "$OWNER" ]]; then
    echo "error: --owner <email> is required when not using --skip-cloudflare" >&2
    exit 1
  fi
  # CF helpers compute hostname as `${arg1}.${FULCRUM_SAAS_BASE_DOMAIN}`, so
  # we pass PUBLIC_SUBDOMAIN (e.g. "fulcrum-acme") not the bare slug.
  cf_dns_ensure_cname "$PUBLIC_SUBDOMAIN"
  cf_tunnel_ensure_ingress "$PUBLIC_SUBDOMAIN" "$CONTAINER"
  # cf_access_app_ensure now takes the owner email directly (see _cf-api.sh
  # for why we skip Groups). Multi-member orgs become a follow-up.
  cf_access_app_ensure "$PUBLIC_SUBDOMAIN" "$OWNER"
fi

# -------- done --------
echo "[6/6] done"
PUBLIC_URL="https://${HOSTNAME}"
if [[ "$SKIP_CLOUDFLARE" -eq 1 ]]; then
  PUBLIC_URL="(skipped — re-run without --skip-cloudflare)"
fi

cat <<EOF

  Org slug   : $SLUG
  Container  : $CONTAINER
  Data dir   : $DATA_DIR
  Public URL : $PUBLIC_URL

  Inspect    : docker logs -f $CONTAINER
  Add user   : ./org-adduser.sh $SLUG <email>
  Tear down  : ./org-destroy.sh $SLUG --yes-really

EOF
