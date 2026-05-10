# Fulcrum-as-SaaS — Deployment Harness

> Status: **design skeleton** — no production code yet. This directory captures
> the architecture for hosting Fulcrum as a multi-tenant web service under
> Divinci-AI, and exists to anchor the conversation before implementation.

## The constraint that shapes everything

The single-tenancy audit (2026-05-10) rated five of Fulcrum's subsystems at
"5/5 architectural rewrite" to convert to true multi-tenant in-process:

- Zero tenant columns across 21 database tables
- No auth middleware anywhere in the Hono app
- 40+ filesystem callsites hard-coded to `~/.fulcrum` / `os.homedir()`
- PTY manager + WebSocket broadcast are global singletons
- Background services (`pr-monitor`, `git-watcher`, `googleCalendarManager`)
  poll the entire database with no tenant filter

Estimated effort to do that work properly: **6–12 engineer-months**, and the
risk profile is high — a single missing `WHERE tenantId = ?` is a data-leakage
incident.

## The shape we adopt instead: container-per-tenant

Rather than rewrite Fulcrum into a multi-tenant app, **we deploy one Fulcrum
instance per customer** behind an authenticating gateway.

```
                     ┌──────────────────────┐
   acme.fulcrum  ─┐  │                      │  ┌→ fulcrum (Docker container)
   divinci.ai     │  │  Auth Gateway        │  │   ~/.fulcrum (volume per tenant)
                  ├──┤  (Cloudflare Zero    ├──┤   SQLite, fnox, worktrees
   bobsco.fulcrum │  │   Trust or Hono      │  │   Background services
   divinci.ai    ─┘  │   proxy)             │  └→ fulcrum (Docker container)
                     │                      │
                     │  Single Divinci-AI   │  ┌→ ...
                     │  Google OAuth client │  │
                     └──────────────────────┘  └→ ...
```

### What this buys

| Concern | How this addresses it |
|---|---|
| Data isolation | Each tenant has their own filesystem volume + their own SQLite. No shared queries. |
| Auth | Gateway authenticates and routes; Fulcrum continues to assume "any caller on the port is authorized" since the port is only reachable via the gateway. |
| PTY/WS isolation | Each tenant's PTYs run in their own container's process space. |
| Background services | Each tenant's `pr-monitor` etc. only sees their own data. |
| Google OAuth | One Divinci-AI Google client provisioned via env vars (see Phase 1 branch). Each tenant container reads the same `GOOGLE_CLIENT_ID`/`SECRET` from env. Tokens stored per-tenant in each container's SQLite. |
| Code changes | **Almost none** in the Fulcrum app itself. Most work is operational. |

### What this costs

| Cost | Why |
|---|---|
| Per-tenant container overhead | One Fulcrum process + ~50–200 MB RAM idle per tenant. Pause/scale-down policies mitigate. |
| Operations complexity | Container orchestration, volume management, backup-per-tenant, upgrade rollouts. |
| Cross-tenant features | Anything truly multi-tenant (admin dashboard, shared search, etc.) needs to live in the gateway, not Fulcrum. |

## The four pieces

### 1. Container image
Reuse the existing `fulcrum up` server build. Package it as a Docker image
that respects `FULCRUM_DIR`, `FULCRUM_PORT`, and accepts
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` via env.

See `Dockerfile` (TBD) — for now, the closest reference is `cli/src/templates/`.

### 2. Per-tenant Compose template
A `docker-compose.tenant.yaml` parameterized by `${TENANT_SLUG}` that mounts
`./data/${TENANT_SLUG}/.fulcrum` as the volume and exposes only the internal
container port. See `docker-compose.tenant.template.yaml` for the skeleton.

### 3. The gateway
Two reasonable shapes — pick one before building:

- **Cloudflare Zero Trust** — auth + routing handled by Cloudflare; tenant
  containers only need to be reachable from CF Tunnel. Lowest ops, lowest code.
- **Hono auth proxy** — self-host a small Hono app that validates JWT/session
  and `fetch`-proxies to the right tenant container. More code, no CF
  dependency, full control of the auth UX.

See `gateway/README.md` for tradeoffs.

### 4. Tenant provisioning
A small CLI or admin endpoint that:
1. Creates `./data/<slug>/`
2. Runs `docker compose -f docker-compose.tenant.template.yaml up -d` with
   `TENANT_SLUG=<slug>`
3. Registers the new subdomain with the gateway
4. Optionally seeds initial admin user / settings

## What's *not* solved by container-per-tenant

- **Shared billing / admin dashboard** — needs a separate service that reads
  per-tenant usage and aggregates.
- **Cross-tenant analytics** — same.
- **Bursting beyond a single host** — once we have >N tenants on one box, we
  need k8s or similar. Compose is the bootstrap, not the destination.
- **Workspace customers with admin-disabled IMAP** — they still need OAuth.
  Solved by Phase 1's single Divinci-AI client; this directory doesn't change
  anything about that.

## Open questions before we build

1. Does Divinci-AI commit to the CASA security assessment once we exceed
   Google's 100-test-user cap? ($500–$4,500/yr + 2–6 mo lead time)
2. Cloudflare Zero Trust vs. self-hosted gateway?
3. Are tenants on dedicated subdomains (`acme.fulcrum.divinci.ai`) or paths
   (`fulcrum.divinci.ai/acme`)? Subdomain is simpler for Fulcrum's existing
   `redirect_uri` logic; paths require rewriting.
4. Backups: per-tenant volume snapshot, or shipped to an off-host store?

Until those are answered, this directory remains design.
