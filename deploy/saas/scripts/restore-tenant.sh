#!/usr/bin/env bash
# restore-tenant.sh — restore a tenant from a backup tarball (D-10 PR 3)
#
# Inverse of backup-tenant.sh. Stops the container, unpacks the
# tarball into the tenant's data dir, restarts the container, waits
# healthy.
#
# Refuses to overwrite an existing tenant unless --force is passed
# — restore is destructive (replaces fulcrum.db, fnox.toml, age.txt).
#
# Usage:
#   ./scripts/restore-tenant.sh --slug=acme --from=/path/to/backup.tar.gz
#   ./scripts/restore-tenant.sh --slug=acme --from=host:/opt/fulcrum-saas/backups/acme/acme-20260518T...tar.gz
#   ./scripts/restore-tenant.sh --slug=acme --from=... --force
#   ./scripts/restore-tenant.sh --help

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

SLUG=""
SOURCE=""
FORCE=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --slug=*)  SLUG="${arg#*=}" ;;
    --from=*)  SOURCE="${arg#*=}" ;;
    --force)   FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,/^source /p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^source /d'
      exit 0
      ;;
    *) die "Unknown arg: $arg" ;;
  esac
done

[ -n "$SLUG" ]   || die "Missing --slug."
[ -n "$SOURCE" ] || die "Missing --from."
validate_slug "$SLUG"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[1;35m[dry-run]\033[0m %s\n' "$*" >&2
  else
    eval "$@"
  fi
}

# Resolve source: either a host: path (already on the GCE host) or a
# local path that needs to be scp'd up.
HOST_TARBALL="/tmp/fulcrum-restore-${SLUG}.tar.gz"
if [[ "$SOURCE" =~ ^host: ]]; then
  HOST_TARBALL="${SOURCE#host:}"
  log "Source is on host: $HOST_TARBALL"
else
  [ -f "$SOURCE" ] || die "Local source not found: $SOURCE"
  log "Uploading $SOURCE → $GCE_INSTANCE:$HOST_TARBALL"
  run "gce_scp '$SOURCE' '${GCE_INSTANCE}:${HOST_TARBALL}'"
fi

# Confirm the tenant exists (or use --force).
EXISTS=$(gce_ssh "test -d /opt/fulcrum-saas/data/${SLUG} && echo yes || echo no")
if [ "$EXISTS" = "yes" ] && [ "$FORCE" -ne 1 ]; then
  die "Tenant data dir exists for $SLUG. Restore is destructive. Pass --force to overwrite."
fi

log "Stopping fulcrum-${SLUG} for restore…"
run "gce_ssh 'docker stop fulcrum-${SLUG} 2>/dev/null || true; docker stop fulcrum-${SLUG}-cloudflared 2>/dev/null || true'"

log "Unpacking tarball into /opt/fulcrum-saas/data/${SLUG}/.fulcrum/…"
run "gce_ssh '
  set -e
  SLUG=${SLUG}
  HOST_TARBALL=${HOST_TARBALL}
  DATA_DIR=/opt/fulcrum-saas/data/\$SLUG/.fulcrum
  sudo mkdir -p \"\$DATA_DIR\" \"\$DATA_DIR/config\"
  # Stage outside the data dir so we can replace files atomically.
  STAGE=\$(mktemp -d -t fulcrum-restore-\$SLUG-XXXXXX)
  sudo tar -xzf \"\$HOST_TARBALL\" -C \"\$STAGE\"
  [ -f \"\$STAGE/fulcrum.db\" ]  && sudo mv \"\$STAGE/fulcrum.db\"  \"\$DATA_DIR/fulcrum.db\"
  [ -f \"\$STAGE/fnox.toml\" ]   && sudo mv \"\$STAGE/fnox.toml\"   \"\$DATA_DIR/config/fnox.toml\"
  [ -f \"\$STAGE/age.txt\" ]     && sudo mv \"\$STAGE/age.txt\"     \"\$DATA_DIR/age.txt\"
  # Remove leftover WAL/SHM — the restored db is a single-file
  # checkpoint from VACUUM INTO, so WAL/SHM from the previous run
  # would point at non-existent pages.
  sudo rm -f \"\$DATA_DIR/fulcrum.db-wal\" \"\$DATA_DIR/fulcrum.db-shm\"
  sudo rm -rf \"\$STAGE\"
'"

log "Restarting fulcrum-${SLUG}…"
run "gce_ssh 'FULCRUM_SAAS_ROOT=/opt/fulcrum-saas docker compose -p fulcrum-saas --project-directory /opt/fulcrum-saas -f /opt/fulcrum-saas/stacks/${SLUG}.yaml up -d'"

log "Waiting healthy…"
for i in $(seq 1 30); do
  STATUS=$(gce_ssh "docker inspect -f '{{.State.Health.Status}}' fulcrum-${SLUG} 2>/dev/null || echo missing")
  log "  [$i] health: $STATUS"
  if [ "$STATUS" = "healthy" ]; then break; fi
  sleep 3
done

if [ "$STATUS" = "healthy" ]; then
  log "✓ Restore of $SLUG complete."
else
  warn "Container reached state '$STATUS' after restore. Inspect with: gce_ssh 'docker logs fulcrum-${SLUG}'"
  exit 1
fi
