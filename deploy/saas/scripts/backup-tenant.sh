#!/usr/bin/env bash
# backup-tenant.sh — snapshot a tenant's data (D-10 PR 3)
#
# Uses `sqlite3 .backup` (hot copy that's WAL-safe) + tars together
# the database file, fnox config, and age key into one timestamped
# .tar.gz. Stored on the host under /opt/fulcrum-saas/backups/<slug>/.
# Local-disk only — no S3/R2 dependency until the operator asks.
#
# Usage:
#   ./scripts/backup-tenant.sh --slug=acme
#   ./scripts/backup-tenant.sh --slug=acme --dest=/path/to/local.tar.gz
#   ./scripts/backup-tenant.sh --slug=acme --keep=10   # rotate; keep N
#   ./scripts/backup-tenant.sh --help

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

SLUG=""
DEST=""
KEEP=0     # 0 = keep all

for arg in "$@"; do
  case "$arg" in
    --slug=*)  SLUG="${arg#*=}" ;;
    --dest=*)  DEST="${arg#*=}" ;;
    --keep=*)  KEEP="${arg#*=}" ;;
    --help|-h)
      sed -n '2,/^source /p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^source /d'
      exit 0
      ;;
    *) die "Unknown arg: $arg" ;;
  esac
done

[ -n "$SLUG" ] || die "Missing --slug. Try --help."
validate_slug "$SLUG"

# Default destination on the host. Operator can pull it down with
# gce_scp afterwards or set up an rsync cron.
HOST_BACKUP_DIR="/opt/fulcrum-saas/backups/${SLUG}"

TS=$(date -u +%Y%m%dT%H%M%SZ)
HOST_BACKUP_FILE="${HOST_BACKUP_DIR}/${SLUG}-${TS}.tar.gz"

log "Backing up tenant=$SLUG → ${HOST_BACKUP_FILE} (host)"

# Heredoc runs on the GCE host. Uses sqlite3 inside the container so
# we don't need a host-side sqlite install. The hot-backup approach
# is critical: a plain `cp fulcrum.db backup.db` can capture a
# write-in-flight and produce a corrupt copy.
gce_ssh "
set -euo pipefail
SLUG='${SLUG}'
TS='${TS}'
BACKUP_DIR='${HOST_BACKUP_DIR}'
BACKUP_FILE='${HOST_BACKUP_FILE}'
DATA_DIR=/opt/fulcrum-saas/data/\$SLUG

sudo mkdir -p \"\$BACKUP_DIR\"

# Stage in a temp dir on the host (tar can read straight from it).
STAGE=\$(mktemp -d -t fulcrum-backup-\$SLUG-XXXXXX)
trap \"sudo rm -rf '\$STAGE'\" EXIT

# 1. Hot-backup the SQLite database via the container (so we don't
#    need a host sqlite install and we hit the same on-disk path the
#    server uses).
docker exec fulcrum-\$SLUG \\
    bun -e \"
        const { Database } = require('bun:sqlite');
        const src = new Database('/data/.fulcrum/fulcrum.db', { readonly: true });
        // bun:sqlite exposes BACKUP via the raw fileControlGet/Run path;
        // simplest portable path is to write a VACUUM INTO that's
        // atomic and WAL-aware.
        src.run('VACUUM INTO ?', ['/data/.fulcrum/.backup.db']);
        console.log('backup written');
    \"

# 2. Copy the hot-backup file out, plus the fnox config + age key.
sudo cp \"\$DATA_DIR/.fulcrum/.backup.db\" \"\$STAGE/fulcrum.db\"
sudo rm -f \"\$DATA_DIR/.fulcrum/.backup.db\"
sudo cp \"\$DATA_DIR/.fulcrum/config/fnox.toml\" \"\$STAGE/fnox.toml\" 2>/dev/null || true
sudo cp \"\$DATA_DIR/.fulcrum/age.txt\" \"\$STAGE/age.txt\" 2>/dev/null || true

# 3. Tar + gzip into the destination.
sudo tar -czf \"\$BACKUP_FILE\" -C \"\$STAGE\" .
sudo chmod 0600 \"\$BACKUP_FILE\"
echo \"\$(du -h \"\$BACKUP_FILE\" | cut -f1) \$BACKUP_FILE\"
"

log "✓ Host backup written: $HOST_BACKUP_FILE"

# Rotation
if [ "$KEEP" -gt 0 ]; then
  log "Rotating: keeping the $KEEP newest backups on host…"
  gce_ssh "
    set -e
    cd '${HOST_BACKUP_DIR}'
    ls -1t *.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r sudo rm -v
  "
fi

# Optional local copy
if [ -n "$DEST" ]; then
  log "Copying to local destination: $DEST"
  mkdir -p "$(dirname "$DEST")"
  gce_scp "${GCE_INSTANCE}:${HOST_BACKUP_FILE}" "$DEST"
  log "✓ Local copy: $DEST"
fi

log "✓ Backup complete"
