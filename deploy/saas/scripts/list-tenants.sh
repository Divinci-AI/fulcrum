#!/usr/bin/env bash
# list-tenants.sh — show every Fulcrum tenant on the host (D-10 PR 3)
#
# Iterates /opt/fulcrum-saas/stacks/*.yaml on the GCE host and prints
# one row per tenant: slug, image SHA (short), container status,
# healthcheck, public URL, last backup timestamp.
#
# Usage:
#   ./scripts/list-tenants.sh             # human-readable table
#   ./scripts/list-tenants.sh --json      # JSON for piping into jq

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

FORMAT="table"

for arg in "$@"; do
  case "$arg" in
    --json)    FORMAT="json" ;;
    --help|-h)
      sed -n '2,/^source /p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^source /d'
      exit 0
      ;;
    *) die "Unknown arg: $arg" ;;
  esac
done

# Gather tenant data via a single SSH round-trip — the host iterates
# its own stacks dir and emits one TSV row per tenant. Cheaper than
# N round-trips.
RAW=$(gce_ssh '
set -e
shopt -s nullglob
for stack in /opt/fulcrum-saas/stacks/*.yaml; do
  slug=$(basename "$stack" .yaml)
  container="fulcrum-${slug}"
  image_sha=$(docker inspect -f "{{.Image}}" "$container" 2>/dev/null | sed "s|sha256:||" | cut -c1-12 || echo "-")
  status=$(docker inspect -f "{{.State.Status}}" "$container" 2>/dev/null || echo "missing")
  health=$(docker inspect -f "{{.State.Health.Status}}" "$container" 2>/dev/null || echo "-")
  url="https://${slug}.fulcrum.divinci.ai"
  backups_dir="/opt/fulcrum-saas/backups/${slug}"
  last_backup=$(ls -t "$backups_dir"/*.tar.gz 2>/dev/null | head -1 | xargs -r basename 2>/dev/null || echo "-")
  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$slug" "$image_sha" "$status" "$health" "$url" "$last_backup"
done
')

if [ -z "$RAW" ]; then
  log "No tenants found on host."
  exit 0
fi

if [ "$FORMAT" = "json" ]; then
  echo "$RAW" | awk -F'\t' '
    BEGIN { print "[" ; first=1 }
    {
      if (!first) print ","
      first=0
      printf "  {\"slug\": \"%s\", \"imageSha\": \"%s\", \"status\": \"%s\", \"health\": \"%s\", \"url\": \"%s\", \"lastBackup\": \"%s\"}",
        $1, $2, $3, $4, $5, $6
    }
    END { print "\n]" }
  '
else
  printf "\033[1m%-12s %-14s %-10s %-10s %-40s %s\033[0m\n" \
    "SLUG" "IMAGE" "STATUS" "HEALTH" "URL" "LAST BACKUP"
  echo "$RAW" | awk -F'\t' '
    {
      printf "%-12s %-14s %-10s %-10s %-40s %s\n", $1, $2, $3, $4, $5, $6
    }
  '
fi
