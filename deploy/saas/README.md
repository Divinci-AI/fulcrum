# Fulcrum-as-SaaS — Deployment Harness

> **Operator? Start at [QUICKSTART.md](./QUICKSTART.md)** — one-screen task
> index. RUNBOOK.md has the full procedures + recovery paths.

> Status: **design, decisions locked**. Implementation not yet started, but the
> open questions from the first draft have been answered. This doc reflects the
> architecture Divinci-AI is committing to.

## The constraint that shapes everything

The single-tenancy audit (2026-05-10) rated five of Fulcrum's subsystems at
"5/5 architectural rewrite" to convert to true multi-tenant in-process:

- Zero tenant columns across 21 database tables
- No auth middleware anywhere in the Hono app
- 40+ filesystem callsites hard-coded to `~/.fulcrum` / `os.homedir()`
- PTY manager + WebSocket broadcast are global singletons
- Background services poll the entire database with no tenant filter

Estimated effort for an in-process multi-tenant lift: **6–12 engineer-months**,
with high data-leakage risk on every missing `WHERE tenantId = ?`.

## The shape we adopt: container-per-tenant on Divinci-AI infra

Rather than rewrite Fulcrum, **one Fulcrum container per customer org**,
hosted on Divinci-AI's GCP, fronted by Cloudflare Zero Trust on Divinci-AI's
Cloudflare account. Each org gets `<slug>.fulcrum.divinci.ai`.

```
  acme.fulcrum.divinci.ai ─┐
                            │  ┌──────────────────────┐
  bobsco.fulcrum.divinci.ai├─→│ Cloudflare Zero Trust │
                            │  │  + cloudflared tunnel │──→ GCE host
  ... .fulcrum.divinci.ai  ─┘  │  + Access groups (org │     ┌──────────────┐
                                │    membership = group │     │ fulcrum-acme │
                                │    membership)        │     │ fulcrum-bob..│
                                └──────────────────────┘     │ fulcrum-...  │
                                                              │ (Docker      │
   ONE Divinci-AI Google OAuth client  ──→  shared via env    │  Compose)    │
   (CASA-verified once we exceed 100 users)                   └──────────────┘
```

## Decisions (2026-05-10)

| # | Question | Decision |
|---|---|---|
| a | CASA security assessment? | **Yes** — Divinci-AI commits to CASA when user count exceeds Google's 100-test-user cap. Until then, the Divinci-AI OAuth client stays in Testing mode and we onboard customers as test users. Budget $500–$4,500/yr + 2–6 mo lead time. |
| b | Gateway shape? | **Cloudflare Zero Trust.** Reuses Fulcrum's existing `cloudflared` integration (`cli/src/commands/expose.ts`), no auth code to maintain, free up to 50 users, then $7/user/mo. |
| c | Subdomain routing? | **`<org-slug>.fulcrum.divinci.ai`**, provisioned via the Cloudflare API. `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_ZONE_ID` exported in operator's `~/.zshrc`. See `provisioning/`. |
| d | Backup strategy? | **Litestream** continuous SQLite replication to **Cloudflare R2**, plus nightly `restic` snapshots of `~/.fulcrum/uploads/` and `~/.fulcrum/worktrees/`. See `backups/`. |
| e | Where hosted? | **Divinci-AI's GCP** (single Compute Engine host with Docker Compose to start, GKE when we outgrow it) and **Divinci-AI's Cloudflare account**. No customer infra at all. |
| f | User/org model? | **One CF Access group per org.** Adding a user = adding their email to the group via Cloudflare API. Removing = removing from group. Fulcrum itself stays unaware of users. See `provisioning/`. |

## The five pieces

### 1. Container image
Reuse the existing `fulcrum up` server build. Package as Docker image that:
- Honors `FULCRUM_DIR=/data/.fulcrum` so every filesystem operation lands in
  the per-tenant volume (no code changes — `server/lib/settings/paths.ts:86`
  already reads this env var).
- Reads `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for the bundled OAuth
  (Phase 1 branch enables this UX automatically).
- Exposes only port 7777 internally; never to the public.

Dockerfile lives at the repo root (TODO).

### 2. Per-org Compose template
`docker-compose.tenant.template.yaml` — parameterized by `${ORG_SLUG}`, mounts
`./data/${ORG_SLUG}/.fulcrum` as the data volume, joins the shared
`fulcrum-gateway` Docker network.

### 3. The gateway — Cloudflare Zero Trust
- One Cloudflare Tunnel on the GCE host, routes
  `<slug>.fulcrum.divinci.ai → fulcrum-<slug>:7777`.
- One Cloudflare Access Application per org, gated by an Access Group whose
  membership is "emails in this org".
- See `gateway/README.md`.

### 4. Provisioning
`provisioning/` — scripts that wrap the Cloudflare API for org and user
management:
- `org create <slug>` — DNS + tunnel rule + Access App + Access Group + Docker stack
- `org adduser <slug> <email>` — add to Access Group
- `org rmuser <slug> <email>` — remove from Access Group
- `org destroy <slug>` — tear it all down (with a confirmation prompt — this is destructive)

Uses `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID` from
operator's shell env (set in `~/.zshrc`).

### 5. Backups
`backups/` — Litestream continuous replication of every tenant SQLite to
Cloudflare R2, plus nightly `restic` snapshots of uploads/worktrees volumes.

## What this still doesn't solve

- **Org-level admin UI** — for v1, the operator runs `org adduser` from their
  shell. A web admin can come later.
- **Cross-org analytics** — needs a separate aggregator service (out of scope
  here).
- **Bursting beyond one GCE host** — single-host Compose is the bootstrap. When
  we have ~50+ orgs, migrate the orchestration to GKE; the per-org compose
  template is already container-native, so the lift is mostly k8s manifests.
- **Per-org code repos** — each org's Fulcrum container has its own
  `~/.fulcrum/worktrees`. Mounting org members' personal git repos into a
  shared container requires a different model and is explicitly out of scope.

## Implementation order when we're ready to build

1. `Dockerfile` for the Fulcrum container (smallest possible image, reuses
   existing build artifacts).
2. `provisioning/org-create.sh` for the happy path on one GCE host.
3. Cloudflare Tunnel + Access setup for a single test org.
4. Litestream wiring.
5. The first real customer (one we control, end-to-end).
6. CASA submission.
7. Public launch.
