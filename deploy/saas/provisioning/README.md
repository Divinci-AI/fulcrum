# Provisioning — orgs and users

> Status: **scripts not written yet**. This doc captures the shape they need
> to take.

A "Fulcrum org" maps to:
- One subdomain (`<slug>.fulcrum.divinci.ai`)
- One Cloudflare Tunnel ingress rule
- One Cloudflare Access Application
- One Cloudflare Access Group
- One Docker Compose stack (`docker-compose.tenant.template.yaml` rendered with `ORG_SLUG=<slug>`)
- One persistent volume directory (`./data/<slug>/`)

A "Fulcrum user" is just an email address in an Access Group. No Fulcrum
state.

## Operator setup (one-time, in `~/.zshrc`)

```sh
# Divinci-AI Cloudflare API credentials
export CLOUDFLARE_API_TOKEN="..."           # Token with Zone:DNS:Edit + Access:Edit + Tunnel:Edit
export CLOUDFLARE_ACCOUNT_ID="..."          # Divinci-AI Cloudflare account
export CLOUDFLARE_ZONE_ID="..."             # Zone for fulcrum.divinci.ai
export CLOUDFLARE_TUNNEL_ID="..."           # The tunnel running on the GCE host
export FULCRUM_SAAS_BASE_DOMAIN="fulcrum.divinci.ai"

# Bundled Google OAuth (Phase 1 branch) — passed into every org container
export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."

# Backups (see ../backups/)
export LITESTREAM_R2_ACCESS_KEY_ID="..."
export LITESTREAM_R2_SECRET_ACCESS_KEY="..."
export LITESTREAM_R2_ENDPOINT="https://<acct>.r2.cloudflarestorage.com"
```

The provisioning scripts read these from the operator's environment; nothing
is hard-coded in repo.

## Commands (planned API)

### `org create <slug> [--owner <email>]`
Provision a new org end-to-end.

Steps (with rollback on failure of any step):
1. Validate `<slug>` matches `^[a-z][a-z0-9-]{1,30}$` and isn't taken.
2. Render `docker-compose.tenant.template.yaml` to `./stacks/<slug>.yaml`.
3. `docker compose -f stacks/<slug>.yaml up -d` — boot the container.
4. Poll container `GET /api/health` until ready (max 60s).
5. Cloudflare API: create DNS CNAME `<slug>.fulcrum.divinci.ai → <tunnel>.cfargotunnel.com` (proxied).
6. Cloudflare API: append tunnel ingress rule routing the hostname to `http://fulcrum-<slug>:7777`. Reload tunnel.
7. Cloudflare API: create Access Group `org-<slug>` (initially empty unless `--owner` given).
8. Cloudflare API: create Access Application for the hostname, policy `require: group:org-<slug>`.
9. If `--owner <email>`: add to Access Group.
10. Print the URL.

### `org adduser <slug> <email>`
1. Fetch Access Group `org-<slug>` by name.
2. PATCH the group to include `<email>` (Cloudflare API: include rules append).
3. Idempotent: silent no-op if already a member.

### `org rmuser <slug> <email>`
1. Fetch Access Group `org-<slug>`.
2. PATCH to remove `<email>`.
3. Cloudflare invalidates the user's current session within ~60s; no app-side action needed.

### `org listusers <slug>`
List emails currently in `org-<slug>`. Useful for support/billing.

### `org list`
List every org Docker stack on this host plus its Access Group membership count.

### `org destroy <slug>`
Tear down the org. **Destructive** — requires `--yes-really`. Prompts for the
slug to be retyped.

Steps:
1. Snapshot the data volume to `./backups/destroyed/<slug>-<timestamp>.tar.zst`
   (keep 90 days, then prune).
2. `docker compose -f stacks/<slug>.yaml down -v`.
3. Cloudflare API: delete Access Application, delete Access Group, remove
   tunnel ingress rule, delete DNS record.
4. `rm -rf ./data/<slug>` (only after backup snapshot succeeded).
5. `rm stacks/<slug>.yaml`.

## Why scripts and not a web admin (yet)

For v0, the operator running these from their dev shell is fine: total volume
will be tens of orgs at most, and writing a web admin before we know the real
operating model is premature. Once we hit 10+ customers, a small admin UI is
a natural follow-up — same scripts, web frontend on top.

## Test plan when writing these

- Idempotency: every script can be re-run safely on a half-completed state.
- Rollback: failure mid-create leaves the system in either fully-created or
  fully-cleaned-up state, never half.
- Cloudflare API rate limits: 1200 req/5 min per token. Way more than we'll
  need; no batching required.

## What lives where on the GCE host

```
/opt/fulcrum-saas/
├── stacks/                  # rendered docker-compose files, one per org
├── data/                    # per-org persistent volumes
│   ├── acme/
│   │   └── .fulcrum/        # SQLite, fnox.toml, uploads, worktrees
│   └── bobsco/
├── backups/
│   ├── destroyed/           # tarballs of destroyed orgs (90d retention)
│   └── litestream/          # local Litestream replica before R2 upload
└── tunnel/
    └── config.yml           # cloudflared ingress rules, updated by provisioning
```
