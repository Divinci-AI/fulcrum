#!/usr/bin/env bash
#
# org-adduser.sh — grant a user access to one Fulcrum org.
#
# Adds <email> to the Cloudflare Access Group "org-<slug>". The next time
# they visit https://<slug>.<base-domain>, Cloudflare's SSO challenge will
# let them through.
#
# Idempotent: silent no-op if the email is already in the group.
#
# Usage:
#     ./org-adduser.sh <slug> <email>

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <slug> <email>" >&2
  exit 1
fi

SLUG="$1"
EMAIL="$2"

if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "error: slug must match ^[a-z][a-z0-9-]{1,30}$" >&2
  exit 1
fi
# Quick email sanity check — Cloudflare will reject malformed values anyway,
# but a clear error here saves a round-trip.
if ! [[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "error: not a valid email: $EMAIL" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_cf-api.sh
source "${SCRIPT_DIR}/_cf-api.sh"

cf_access_group_add_email "$SLUG" "$EMAIL"
