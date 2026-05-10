#!/usr/bin/env bash
#
# org-create.sh — boot one Fulcrum-per-org container, end-to-end.
#
# This is the v0 happy path: it renders the Compose template, brings up the
# stack, waits for /health, and prints the local URL. Cloudflare DNS, tunnel
# ingress, and Access Group provisioning are stubbed at the bottom with the
# exact API endpoints to fill in once we're ready to expose to the public
# internet.
#
# Usage:
#     ./org-create.sh <slug>
#
# Environment (set in ~/.zshrc):
#     GOOGLE_CLIENT_ID            — Divinci-AI Google OAuth client
#     GOOGLE_CLIENT_SECRET        — Divinci-AI Google OAuth secret
#     FULCRUM_SAAS_BASE_DOMAIN    — defaults to "fulcrum.divinci.ai"
#     FULCRUM_SAAS_IMAGE          — defaults to "divinci-ai/fulcrum:dev"
#     FULCRUM_SAAS_ROOT           — defaults to "/opt/fulcrum-saas" (on GCE);
#                                   "./fulcrum-saas-state" for local testing
#
# Exit codes:
#     0  success
#     1  bad usage / missing env
#     2  stack failed to come up
#     3  Cloudflare API failure (when wired)

set -euo pipefail

# -------- args --------
if [[ $# -lt 1 ]]; then
  echo "usage: $0 <slug>" >&2
  exit 1
fi

SLUG="$1"

if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "error: slug must match ^[a-z][a-z0-9-]{1,30}$" >&2
  exit 1
fi

# -------- env --------
: "${GOOGLE_CLIENT_ID:?must be set — see deploy/saas/provisioning/README.md}"
: "${GOOGLE_CLIENT_SECRET:?must be set — see deploy/saas/provisioning/README.md}"

BASE_DOMAIN="${FULCRUM_SAAS_BASE_DOMAIN:-fulcrum.divinci.ai}"
IMAGE="${FULCRUM_SAAS_IMAGE:-divinci-ai/fulcrum:dev}"
ROOT="${FULCRUM_SAAS_ROOT:-/opt/fulcrum-saas}"
HOSTNAME="${SLUG}.${BASE_DOMAIN}"
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
ORG_SLUG="$SLUG" \
GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
TENANT_SLUG="$SLUG" \
  envsubst '${ORG_SLUG} ${TENANT_SLUG} ${GOOGLE_CLIENT_ID} ${GOOGLE_CLIENT_SECRET}' \
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

# -------- cloudflare (stub) --------
echo "[5/6] cloudflare provisioning (not yet wired)"
cat <<EOF
      → Skipped. To finish the public exposure when ready, fill in these
        Cloudflare API calls (creds from ~/.zshrc):

          POST /zones/\${CLOUDFLARE_ZONE_ID}/dns_records
            { "type": "CNAME", "name": "${SLUG}", "content": "\${CLOUDFLARE_TUNNEL_ID}.cfargotunnel.com", "proxied": true }

          PUT /accounts/\${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/\${CLOUDFLARE_TUNNEL_ID}/configurations
            → append { "hostname": "${HOSTNAME}", "service": "http://${CONTAINER}:7777" }

          POST /accounts/\${CLOUDFLARE_ACCOUNT_ID}/access/groups
            { "name": "org-${SLUG}", "include": [] }

          POST /accounts/\${CLOUDFLARE_ACCOUNT_ID}/access/apps
            { "name": "Fulcrum: ${SLUG}", "domain": "${HOSTNAME}",
              "policies": [{ "decision": "allow", "include": [{ "group": { "id": "<group-id>" } }] }] }
EOF

# -------- done --------
echo "[6/6] done"
cat <<EOF

  Container : $CONTAINER
  Data dir  : $DATA_DIR
  Local URL : http://localhost:7777    (only if no other container is on 7777)
  Public URL: https://${HOSTNAME}      (once CF wiring is added above)

  Inspect:    docker logs -f $CONTAINER
  Tear down:  docker compose -f $STACK_FILE down -v && rm -rf $DATA_DIR

EOF
