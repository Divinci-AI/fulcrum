# Backups — design

> Status: **design only, no scripts yet**.

Per-org Fulcrum stores two classes of data:

1. **SQLite** (`<data>/.fulcrum/fulcrum.db`) — tasks, projects, repos,
   conversations, accounts, channel state. The crown jewels.
2. **Filesystem state** — `<data>/.fulcrum/uploads/`,
   `<data>/.fulcrum/worktrees/`, `<data>/.fulcrum/config/fnox.toml`,
   `<data>/.fulcrum/age.txt`. Large but mostly slow-changing.

The two have different change patterns and need different backup strategies.

## Strategy

### SQLite: Litestream → Cloudflare R2 (continuous)

[Litestream](https://litestream.io/) streams every WAL frame from SQLite to
an object store within seconds. Replicas are restorable to any point in the
retention window.

- **One Litestream sidecar per org container.** Same Docker network, watches
  `/data/.fulcrum/fulcrum.db`.
- **Destination**: Cloudflare R2 bucket `fulcrum-backups-sqlite`, prefixed
  by org slug: `s3://fulcrum-backups-sqlite/<slug>/`.
- **Retention**: 30 days at the WAL frame level, then snapshot pruned.
- **Recovery**: `litestream restore -o /data/.fulcrum/fulcrum.db.restored s3://.../<slug>/` and swap.

### Filesystem state: restic → Cloudflare R2 (nightly)

`fnox.toml` and `age.txt` rarely change; uploads and worktrees change daily
but aren't latency-sensitive. Nightly snapshot is fine.

- **One restic snapshot per org per night**, scheduled via cron on the GCE host.
- **Source**: `./data/<slug>/.fulcrum/` excluding `fulcrum.db*` (Litestream
  handles those).
- **Destination**: R2 bucket `fulcrum-backups-fs`, encrypted with a restic
  password stored in Cloudflare Secrets Manager.
- **Retention**: keep last 7 daily, last 4 weekly, last 6 monthly.

### Disaster recovery snapshots (every destroy + monthly full)

Whenever `org destroy` runs, we tarball `./data/<slug>/` to
`./backups/destroyed/<slug>-<timestamp>.tar.zst` before deleting. This is
local-only (90d retention) — it's an "undo button," not a real backup.

Once a month, a full GCE persistent-disk snapshot via GCP's snapshot API,
retained 6 months. Belt and suspenders.

## Why two backup tools

| Tool | What it handles | Why this and not the other |
|---|---|---|
| **Litestream** | SQLite, every WAL frame | Restic can't do continuous DB replication; a nightly snapshot is unacceptable RPO for a multi-tenant SaaS. |
| **restic** | Uploads, worktrees, fnox config | Litestream is SQLite-specific; restic does deduplicated encrypted snapshots of arbitrary directories. |

We could use one tool for everything (e.g. restic-only) but the RPO on the
DB would drop from "seconds" to "24 hours". Not acceptable for paying
customers.

## Test plan (when implementing)

1. Provision a test org, do some work in Fulcrum, capture the org's URL state.
2. `litestream restore` to a fresh DB; diff against the original.
3. Restore the restic snapshot to a fresh data dir; spin up a new container
   pointing at it; verify the org's state is identical.
4. Repeat with a deliberate failure injection (`docker kill` mid-write) to
   confirm the WAL replication survives the crash.

## What this doesn't cover

- **Cloudflare Tunnel config backups** — kept in Cloudflare's own state; we
  rely on Cloudflare's durability + version-control our `tunnel/config.yml`.
- **Cloudflare Access state** — also Cloudflare-managed. Org membership in
  Access Groups is the only thing we'd lose if Cloudflare lost their data;
  export the membership list to R2 weekly as a sanity copy.
- **Cross-region** — R2 is multi-region by default; no extra work needed
  unless we later add a Google-Cloud-only customer (then mirror to GCS).
