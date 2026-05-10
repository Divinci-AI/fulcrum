#!/usr/bin/env bash
#
# org-destroy.sh — tear down one Fulcrum org. DESTRUCTIVE.
#
# Steps (with the data-snapshot first so we can never lose data due to a
# later CF/Docker failure):
#   1. tar.zst the data dir → ${FULCRUM_SAAS_ROOT}/backups/destroyed/
#   2. docker compose down -v   (removes container + named volumes)
#   3. Cloudflare: delete Access App, Access Group, tunnel ingress, DNS record
#   4. rm -rf ${FULCRUM_SAAS_ROOT}/data/<slug>
#   5. rm   ${FULCRUM_SAAS_ROOT}/stacks/<slug>.yaml
#
# Requires --yes-really AND retyping the slug to confirm. There is no undo
# button beyond the local tarball, which itself ages out after 90 days.
#
# Usage:
#     ./org-destroy.sh <slug> --yes-really
#     ./org-destroy.sh <slug> --yes-really --skip-cloudflare   (local-only undo)

set -euo pipefail

CONFIRMED=0
SKIP_CLOUDFLARE=0
SLUG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes-really) CONFIRMED=1; shift ;;
    --skip-cloudflare) SKIP_CLOUDFLARE=1; shift ;;
    --*) echo "unknown flag: $1" >&2; exit 1 ;;
    *) if [[ -z "$SLUG" ]]; then SLUG="$1"; shift; else echo "extra arg: $1" >&2; exit 1; fi ;;
  esac
done

if [[ -z "$SLUG" ]] || [[ "$CONFIRMED" -ne 1 ]]; then
  cat >&2 <<EOF
usage: $0 <slug> --yes-really [--skip-cloudflare]

This will permanently delete the org's container, data volume, Cloudflare
DNS / tunnel rule / Access App / Access Group. A timestamped tarball is
written to backups/destroyed/ first (90d retention).

You must pass --yes-really AND retype the slug when prompted.
EOF
  exit 1
fi

if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "error: slug must match ^[a-z][a-z0-9-]{1,30}$" >&2
  exit 1
fi

ROOT="${FULCRUM_SAAS_ROOT:-/opt/fulcrum-saas}"
CONTAINER="fulcrum-${SLUG}"
STACK_FILE="${ROOT}/stacks/${SLUG}.yaml"
DATA_DIR="${ROOT}/data/${SLUG}"
BACKUP_DIR="${ROOT}/backups/destroyed"

# -------- confirmation --------
echo "About to destroy: $SLUG"
echo "  Container : $CONTAINER"
echo "  Stack     : $STACK_FILE"
echo "  Data dir  : $DATA_DIR"
echo
read -r -p "Retype the slug ($SLUG) to confirm: " typed
if [[ "$typed" != "$SLUG" ]]; then
  echo "aborted — slug did not match"
  exit 1
fi

# -------- snapshot --------
if [[ -d "$DATA_DIR" ]]; then
  echo "[1/5] snapshotting data to backups/destroyed/"
  mkdir -p "$BACKUP_DIR"
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  TARBALL="${BACKUP_DIR}/${SLUG}-${TS}.tar.zst"
  if command -v zstd >/dev/null 2>&1; then
    tar -cf - -C "$ROOT/data" "$SLUG" | zstd -19 -q -o "$TARBALL"
  else
    # zstd not installed — fall back to gzip rather than refuse to back up.
    TARBALL="${BACKUP_DIR}/${SLUG}-${TS}.tar.gz"
    tar -czf "$TARBALL" -C "$ROOT/data" "$SLUG"
    echo "      (zstd missing — used gzip; install zstd for better compression)"
  fi
  echo "      backup → $TARBALL"
else
  echo "[1/5] no data dir to snapshot (already gone or never existed)"
fi

# -------- compose down --------
echo "[2/5] docker compose down -v"
if [[ -f "$STACK_FILE" ]]; then
  docker compose -f "$STACK_FILE" --project-directory "$ROOT" down -v || \
    echo "      (compose down returned non-zero; continuing)"
else
  docker rm -f "$CONTAINER" 2>/dev/null || true
fi

# -------- cloudflare --------
if [[ "$SKIP_CLOUDFLARE" -eq 1 ]]; then
  echo "[3/5] cloudflare teardown — skipped"
else
  echo "[3/5] cloudflare teardown"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=./_cf-api.sh
  source "${SCRIPT_DIR}/_cf-api.sh"
  BASE="${FULCRUM_SAAS_BASE_DOMAIN:-fulcrum.divinci.ai}"
  cf_access_app_delete "$SLUG"
  cf_access_group_delete "$SLUG"
  cf_tunnel_remove_ingress "$SLUG"
  cf_dns_delete "${SLUG}.${BASE}"
fi

# -------- filesystem --------
echo "[4/5] removing data dir"
rm -rf "$DATA_DIR"

echo "[5/5] removing rendered stack file"
rm -f "$STACK_FILE"

cat <<EOF

  Destroyed: $SLUG

  Backup tarball (90d retention):
    ${TARBALL:-(none — data dir was already absent)}

EOF
