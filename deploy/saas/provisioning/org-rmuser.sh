#!/usr/bin/env bash
#
# org-rmuser.sh — revoke a user's access to one Fulcrum org.
#
# Removes <email> from the Cloudflare Access Group "org-<slug>". Cloudflare
# invalidates the user's current session within ~60s, so no Fulcrum-side
# action is needed.
#
# Idempotent: silent no-op if the email isn't in the group. If this removes
# the last member, the group transitions to a sentinel that excludes
# everyone (so the Access App keeps working but lets nobody in).
#
# Usage:
#     ./org-rmuser.sh <slug> <email>

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_cf-api.sh
source "${SCRIPT_DIR}/_cf-api.sh"

cf_access_group_remove_email "fulcrum-$SLUG" "$EMAIL"
