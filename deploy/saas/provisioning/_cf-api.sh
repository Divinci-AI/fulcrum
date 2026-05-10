# Shared Cloudflare API helpers for Fulcrum SaaS provisioning.
#
# Source this from org-*.sh scripts; do not run directly.
#
# Required env vars (typically set in operator's ~/.zshrc):
#   CLOUDFLARE_API_TOKEN     — token with Zone:DNS:Edit + Access:Edit + Tunnel:Edit
#   CLOUDFLARE_ACCOUNT_ID    — Divinci-AI Cloudflare account
#   CLOUDFLARE_ZONE_ID       — zone for FULCRUM_SAAS_BASE_DOMAIN
#   CLOUDFLARE_TUNNEL_ID     — the named tunnel on the GCE host
#   FULCRUM_SAAS_BASE_DOMAIN — defaults to fulcrum.divinci.ai
#
# All helpers exit non-zero on API errors. They are idempotent — calling
# them twice has the same effect as calling them once.

set -euo pipefail

# Guard against accidental direct invocation.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "error: _cf-api.sh is a library, source it from another script" >&2
  exit 1
fi

# Required external commands.
for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd is required (apt install jq / brew install jq)" >&2
    exit 1
  fi
done

: "${CLOUDFLARE_API_TOKEN:?must be set — see deploy/saas/provisioning/README.md}"
: "${CLOUDFLARE_ACCOUNT_ID:?must be set}"
: "${CLOUDFLARE_ZONE_ID:?must be set}"
: "${CLOUDFLARE_TUNNEL_ID:?must be set}"

FULCRUM_SAAS_BASE_DOMAIN="${FULCRUM_SAAS_BASE_DOMAIN:-fulcrum.divinci.ai}"

CF_API_BASE="https://api.cloudflare.com/client/v4"

# ----------------------------------------------------------------------------
# Low-level wrappers: curl + Authorization header + check for {success: false}
# ----------------------------------------------------------------------------

_cf() {
  # _cf <method> <path> [<json-body>]
  #
  # Prints the response body to stdout. Exits 3 with the error payload on
  # any non-success response (Cloudflare wraps every reply in
  # {"success": bool, "errors": [...], "result": ...}).
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local response

  if [[ -n "$body" ]]; then
    response=$(curl -fsS -X "$method" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "${CF_API_BASE}${path}")
  else
    response=$(curl -fsS -X "$method" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "${CF_API_BASE}${path}")
  fi

  local success
  success=$(echo "$response" | jq -r '.success // false')
  if [[ "$success" != "true" ]]; then
    echo "cloudflare API error on $method $path:" >&2
    echo "$response" | jq -r '.errors[]? | "  - " + (.code|tostring) + ": " + .message' >&2
    exit 3
  fi

  echo "$response"
}

# ----------------------------------------------------------------------------
# DNS record management
# ----------------------------------------------------------------------------

cf_dns_get_id() {
  # cf_dns_get_id <hostname>  → prints record ID, or empty if not found.
  local hostname="$1"
  _cf GET "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${hostname}&type=CNAME" \
    | jq -r '.result[0].id // empty'
}

cf_dns_ensure_cname() {
  # cf_dns_ensure_cname <subdomain>  (subdomain only, e.g. "acme")
  # Idempotent: skips if a record for the full hostname already exists.
  local subdomain="$1"
  local hostname="${subdomain}.${FULCRUM_SAAS_BASE_DOMAIN}"
  local existing
  existing=$(cf_dns_get_id "$hostname")
  if [[ -n "$existing" ]]; then
    echo "      DNS: $hostname already exists ($existing) — skipping"
    return 0
  fi
  local body
  body=$(jq -nc \
    --arg name "$subdomain" \
    --arg content "${CLOUDFLARE_TUNNEL_ID}.cfargotunnel.com" \
    '{type: "CNAME", name: $name, content: $content, proxied: true}')
  _cf POST "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" "$body" >/dev/null
  echo "      DNS: created CNAME $hostname"
}

cf_dns_delete() {
  # cf_dns_delete <hostname>  — no-op if record doesn't exist.
  local hostname="$1"
  local id
  id=$(cf_dns_get_id "$hostname")
  if [[ -z "$id" ]]; then
    echo "      DNS: $hostname not found — skipping"
    return 0
  fi
  _cf DELETE "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${id}" >/dev/null
  echo "      DNS: deleted $hostname"
}

# ----------------------------------------------------------------------------
# Tunnel ingress management
#
# Cloudflare's tunnel config is one big object containing an ingress list.
# Rules MUST end with a catch-all `{"service": "http_status:404"}`. New rules
# are inserted just before that catch-all.
# ----------------------------------------------------------------------------

_cf_tunnel_get_config() {
  _cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/configurations" \
    | jq '.result.config // {ingress: [{service: "http_status:404"}]}'
}

cf_tunnel_ensure_ingress() {
  # cf_tunnel_ensure_ingress <subdomain> <container-name>
  # Adds {hostname: <slug>.<base>, service: http://<container>:7777} just
  # before the catch-all 404, if not already present.
  local subdomain="$1"
  local container="$2"
  local hostname="${subdomain}.${FULCRUM_SAAS_BASE_DOMAIN}"
  local config new_config
  config=$(_cf_tunnel_get_config)

  # Already present?
  if echo "$config" | jq -e --arg h "$hostname" '.ingress[]? | select(.hostname == $h)' >/dev/null; then
    echo "      Tunnel: ingress for $hostname already present — skipping"
    return 0
  fi

  new_config=$(echo "$config" | jq \
    --arg hostname "$hostname" \
    --arg service "http://${container}:7777" \
    '
    .ingress = (
      (.ingress | map(select(.service != "http_status:404")))
      + [{hostname: $hostname, service: $service}]
      + [{service: "http_status:404"}]
    )
    ')

  local payload
  payload=$(jq -nc --argjson config "$new_config" '{config: $config}')
  _cf PUT "/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/configurations" "$payload" >/dev/null
  echo "      Tunnel: added ingress $hostname → ${container}:7777"
}

cf_tunnel_remove_ingress() {
  # cf_tunnel_remove_ingress <subdomain>  — no-op if not present.
  local subdomain="$1"
  local hostname="${subdomain}.${FULCRUM_SAAS_BASE_DOMAIN}"
  local config new_config
  config=$(_cf_tunnel_get_config)

  if ! echo "$config" | jq -e --arg h "$hostname" '.ingress[]? | select(.hostname == $h)' >/dev/null; then
    echo "      Tunnel: ingress for $hostname not found — skipping"
    return 0
  fi

  new_config=$(echo "$config" | jq --arg h "$hostname" '
    .ingress = (.ingress | map(select(.hostname != $h)))
  ')
  local payload
  payload=$(jq -nc --argjson config "$new_config" '{config: $config}')
  _cf PUT "/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/configurations" "$payload" >/dev/null
  echo "      Tunnel: removed ingress $hostname"
}

# ----------------------------------------------------------------------------
# Access Group management
# ----------------------------------------------------------------------------

cf_access_group_get_id() {
  # cf_access_group_get_id <name>  → prints group ID, or empty.
  local name="$1"
  _cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups?name=${name}" \
    | jq -r --arg n "$name" '.result[]? | select(.name == $n) | .id' \
    | head -n 1
}

cf_access_group_ensure() {
  # cf_access_group_ensure <slug> [<initial-owner-email>]
  # Creates an Access Group named "org-<slug>" with optional first member.
  # Returns: prints the group ID to stdout.
  local slug="$1"
  local owner="${2:-}"
  local name="org-${slug}"
  local id
  id=$(cf_access_group_get_id "$name")
  if [[ -n "$id" ]]; then
    echo "      Access Group: $name already exists ($id) — skipping" >&2
    echo "$id"
    return 0
  fi

  # Cloudflare requires a non-empty `include`. If no owner is given we use a
  # sentinel `email_domain: nobody.example` which excludes everyone until the
  # first real user is added via org-adduser.sh.
  local include_json
  if [[ -n "$owner" ]]; then
    include_json=$(jq -nc --arg e "$owner" '[{email: {email: $e}}]')
  else
    include_json='[{"email_domain":{"domain":"nobody.example"}}]'
  fi
  local body
  body=$(jq -nc --arg name "$name" --argjson include "$include_json" \
    '{name: $name, include: $include}')
  id=$(_cf POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups" "$body" \
        | jq -r '.result.id')
  echo "      Access Group: created $name ($id)" >&2
  echo "$id"
}

cf_access_group_delete() {
  local slug="$1"
  local name="org-${slug}"
  local id
  id=$(cf_access_group_get_id "$name")
  if [[ -z "$id" ]]; then
    echo "      Access Group: $name not found — skipping"
    return 0
  fi
  _cf DELETE "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups/${id}" >/dev/null
  echo "      Access Group: deleted $name"
}

cf_access_group_add_email() {
  # cf_access_group_add_email <slug> <email>  — idempotent.
  local slug="$1"
  local email="$2"
  local name="org-${slug}"
  local id
  id=$(cf_access_group_get_id "$name")
  if [[ -z "$id" ]]; then
    echo "error: Access Group $name not found. Run org-create first." >&2
    exit 1
  fi

  local group new_include payload
  group=$(_cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups/${id}")

  if echo "$group" | jq -e --arg e "$email" '.result.include[]? | select(.email.email == $e)' >/dev/null; then
    echo "      $email is already in $name — skipping"
    return 0
  fi

  # Drop the nobody.example sentinel if it's the only entry; otherwise just
  # append. This way the group transitions from "empty" to "has Alice"
  # without leaving stale rules.
  new_include=$(echo "$group" | jq --arg e "$email" '
    [.result.include[]? | select((.email_domain.domain // "") != "nobody.example")]
    + [{email: {email: $e}}]
  ')
  payload=$(jq -nc --arg name "$name" --argjson include "$new_include" \
    '{name: $name, include: $include}')
  _cf PUT "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups/${id}" "$payload" >/dev/null
  echo "      Added $email to $name"
}

cf_access_group_remove_email() {
  # cf_access_group_remove_email <slug> <email>  — idempotent.
  local slug="$1"
  local email="$2"
  local name="org-${slug}"
  local id
  id=$(cf_access_group_get_id "$name")
  if [[ -z "$id" ]]; then
    echo "error: Access Group $name not found" >&2
    exit 1
  fi

  local group new_include payload remaining
  group=$(_cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups/${id}")

  if ! echo "$group" | jq -e --arg e "$email" '.result.include[]? | select(.email.email == $e)' >/dev/null; then
    echo "      $email is not in $name — skipping"
    return 0
  fi

  new_include=$(echo "$group" | jq --arg e "$email" '
    [.result.include[]? | select(.email.email != $e)]
  ')
  # Keep at least one rule (Cloudflare rejects empty include). If removing
  # the last user, restore the nobody.example sentinel.
  remaining=$(echo "$new_include" | jq 'length')
  if [[ "$remaining" -eq 0 ]]; then
    new_include='[{"email_domain":{"domain":"nobody.example"}}]'
  fi
  payload=$(jq -nc --arg name "$name" --argjson include "$new_include" \
    '{name: $name, include: $include}')
  _cf PUT "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups/${id}" "$payload" >/dev/null
  echo "      Removed $email from $name"
}

cf_access_group_list_emails() {
  local slug="$1"
  local name="org-${slug}"
  local id
  id=$(cf_access_group_get_id "$name")
  if [[ -z "$id" ]]; then
    echo "error: Access Group $name not found" >&2
    exit 1
  fi
  _cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/groups/${id}" \
    | jq -r '.result.include[]? | .email.email // empty'
}

# ----------------------------------------------------------------------------
# Access Application management
# ----------------------------------------------------------------------------

cf_access_app_get_id() {
  local domain="$1"
  _cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps?domain=${domain}" \
    | jq -r --arg d "$domain" '.result[]? | select(.domain == $d) | .id' \
    | head -n 1
}

cf_access_app_ensure() {
  # cf_access_app_ensure <slug> <group-id>
  local slug="$1"
  local group_id="$2"
  local domain="${slug}.${FULCRUM_SAAS_BASE_DOMAIN}"
  local existing
  existing=$(cf_access_app_get_id "$domain")
  if [[ -n "$existing" ]]; then
    echo "      Access App: $domain already exists ($existing) — skipping"
    return 0
  fi

  # Two-step: create app, then create its policy. CF supports inline policies
  # on create but the schema is fiddly and varies by app type — splitting
  # the request is more reliable.
  local app_body app_id policy_body
  app_body=$(jq -nc \
    --arg name "Fulcrum: ${slug}" \
    --arg domain "$domain" \
    '{name: $name, domain: $domain, type: "self_hosted", session_duration: "24h"}')
  app_id=$(_cf POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" "$app_body" \
            | jq -r '.result.id')

  policy_body=$(jq -nc \
    --arg name "Members of org-${slug}" \
    --arg group "$group_id" \
    '{name: $name, decision: "allow", include: [{group: {id: $group}}]}')
  _cf POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${app_id}/policies" "$policy_body" >/dev/null
  echo "      Access App: created $domain ($app_id) gated by org-${slug}"
}

cf_access_app_delete() {
  local slug="$1"
  local domain="${slug}.${FULCRUM_SAAS_BASE_DOMAIN}"
  local id
  id=$(cf_access_app_get_id "$domain")
  if [[ -z "$id" ]]; then
    echo "      Access App: $domain not found — skipping"
    return 0
  fi
  _cf DELETE "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${id}" >/dev/null
  echo "      Access App: deleted $domain"
}
