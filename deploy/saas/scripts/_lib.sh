#!/usr/bin/env bash
# Shared helpers for the deploy/saas/scripts/* family (D-10 PR 2).
# Source from siblings: `source "$(dirname "$0")/_lib.sh"`.
#
# Conventions:
#   - All helpers exit non-zero on failure unless documented as "soft"
#   - `log` and `die` go to stderr; `cf_*` helpers print JSON to stdout
#     so they're pipe-friendly
#   - Operator env (~/.zshrc) provides GCP_PROJECT, GCE_INSTANCE,
#     GCE_ZONE, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
#     CLOUDFLARE_ZONE_ID

set -euo pipefail

# --- Coloured logging ---
log()  { printf '\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
warn() { printf '\033[1;33m[%s WARN]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die()  { printf '\033[1;31m[%s ERROR]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

# --- GCE wrappers (consistent project + zone every time) ---
GCP_PROJECT="${GCP_PROJECT:-fulcrum-mike-2026}"
GCE_INSTANCE="${GCE_INSTANCE:-fulcrum-saas-1}"
GCE_ZONE="${GCE_ZONE:-us-central1-a}"

gce_ssh() {
  gcloud compute ssh "$GCE_INSTANCE" \
    --project="$GCP_PROJECT" \
    --zone="$GCE_ZONE" \
    --command="$1"
}

gce_scp() {
  gcloud compute scp \
    --project="$GCP_PROJECT" \
    --zone="$GCE_ZONE" \
    "$@"
}

# --- Cloudflare API helpers ---
# All cf_* functions exit non-zero on HTTP error and print the response
# body to stdout. On success they print the response body for the caller
# to parse with jq.

cf_check_token() {
  # Soft check — returns 0 if the token is currently valid, 1 otherwise.
  # Doesn't die — callers decide whether to proceed without CF auth.
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || return 1
  local status
  status=$(curl -fsS \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>/dev/null \
    | jq -r '.result.status // empty')
  [ "$status" = "active" ]
}

cf_api() {
  # cf_api <METHOD> <PATH> [data]
  # PATH starts with /; we prefix the base.
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -fsS \
      -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$data" \
      "https://api.cloudflare.com/client/v4${path}"
  else
    curl -fsS \
      -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4${path}"
  fi
}

# --- Repo root resolution (works from any caller) ---
fulcrum_repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  cd "$script_dir/../../.." && pwd
}

# --- Slug validation ---
# Lowercase alphanumeric + dashes only; must start with a letter.
# Matches a typical DNS subdomain rule.
validate_slug() {
  local slug="$1"
  if ! [[ "$slug" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]]; then
    die "Slug must be lowercase alphanumeric + dashes, start with a letter, 2-32 chars: '$slug'"
  fi
}
