# Operator quickstart

One-screen task index. Each row links to "what to run" + "where it
lives". Read RUNBOOK.md when you need the why or the recovery path.

## Day-to-day

| I want to… | Run |
|---|---|
| Deploy a code change to acme | `./deploy/saas/scripts/build-deploy.sh` |
| Deploy + skip e2e | `./deploy/saas/scripts/build-deploy.sh --skip-e2e` |
| Recreate the container (image already on host) | `./deploy/saas/scripts/build-deploy.sh --skip-build --skip-stream` |
| See what's running on the host | `./deploy/saas/scripts/list-tenants.sh` |
| Same, machine-readable | `./deploy/saas/scripts/list-tenants.sh --json` |
| Back up a tenant | `./deploy/saas/scripts/backup-tenant.sh --slug=acme` |
| Back up + pull tarball locally | `./deploy/saas/scripts/backup-tenant.sh --slug=acme --dest=./backup.tar.gz` |
| Rotate backups (keep 10 newest) | `./deploy/saas/scripts/backup-tenant.sh --slug=acme --keep=10` |
| Restore from a backup | `./deploy/saas/scripts/restore-tenant.sh --slug=acme --from=./backup.tar.gz` |
| Run prod e2e | `bunx playwright test --config=e2e/playwright.config.ts --project=prod` |

## Tenant lifecycle

| I want to… | Run |
|---|---|
| Spin up a new tenant | `./deploy/saas/scripts/provision-tenant.sh --slug=foo --owner=ceo@foo.com` |
| Same, but CF token is 401 | append `--skip-cf` and wire CF manually (RUNBOOK §8) |
| Dry-run first | append `--dry-run` |
| Migrate a tenant from host-cloudflared to sidecar | `./deploy/saas/scripts/cutover-to-sidecar.sh --slug=foo` |
| Stop a tenant but keep its data | `./deploy/saas/scripts/teardown-tenant.sh --slug=foo` |
| Wipe a tenant entirely | `./deploy/saas/scripts/teardown-tenant.sh --slug=foo --purge` |
| Wipe data only (keep CF resources) | `./deploy/saas/scripts/teardown-tenant.sh --slug=foo --rm-data` |
| Wipe CF resources only (keep data) | `./deploy/saas/scripts/teardown-tenant.sh --slug=foo --rm-cf` |

## In-app user management (no CLI needed)

| I want to… | Where |
|---|---|
| Invite a teammate | Settings → Members → "Invite a member" |
| Promote / demote | Settings → Members → toggle the Admin switch on their row |
| Mint a CLI API token | Settings → API tokens → "Mint a new token" |
| Set the CF Access App + Policy IDs | Settings → Integrations → Access App / Access Policy |

## Operator CLI (talks to a remote tenant)

| I want to… | Run |
|---|---|
| Log in (one-time per laptop) | `fulcrum login --url=https://acme.fulcrum.divinci.ai --token=fulc_...` |
| List members | `fulcrum users list` |
| Invite a member | `fulcrum users invite teammate@divinci.ai` |
| Invite as admin | `fulcrum users invite teammate@divinci.ai --admin` |
| Promote a member to admin | `fulcrum users promote teammate@divinci.ai` |
| Demote an admin | `fulcrum users demote teammate@divinci.ai` |
| Set a tenant config key | `fulcrum config set integrations.cloudflareAccessAppId 8c9dfd22-…` |

## Periodic / scheduled

| I want to… | How |
|---|---|
| Daily backup at 02:00 | `crontab -e` → `0 2 * * * /path/to/build-deploy.sh… etc` (placeholder; backup-tenant.sh is the building block) |
| Rotate CF token | RUNBOOK §8 (manual; ~12-month cadence) |
| CASA submission | `deploy/saas/CASA-PREP.md` (manual; multi-month timeline) |

## When things go wrong

| Symptom | First step |
|---|---|
| `acme` container won't start | `gcloud compute ssh fulcrum-saas-1 --command='docker logs fulcrum-acme \| tail -50'` |
| `Cloudflare API error: 9109` | RUNBOOK §8 (rotate token) |
| Tenant unhealthy after recreate | RUNBOOK §7 Step 3 (rollback) |
| Lost local Fulcrum CLI auth | re-run `fulcrum login --url=… --token=…`; tokens are in Settings → API tokens |
| Need to add a non-Divincian email to CF Access | Today: Cloudflare dashboard (Access App → Policy → Include → add Email). After D-8 PR 5 is exercised: handled automatically by `fulcrum users invite …`. |

## Where everything lives

```
deploy/saas/
├── RUNBOOK.md                                  # full operator manual
├── QUICKSTART.md                               # this file
├── CASA-PREP.md                                # CASA submission checklist
├── docker-compose.tenant.template.yaml         # legacy host-cloudflared template
├── docker-compose.tenant.sidecar.template.yaml # multi-tenant sidecar template
└── scripts/
    ├── _lib.sh                  # shared helpers (gce_ssh, cf_api, validate_slug)
    ├── build-deploy.sh          # day-to-day: build → stream → recreate → e2e
    ├── provision-tenant.sh      # spin up a new tenant
    ├── teardown-tenant.sh       # stop / wipe a tenant
    ├── cutover-to-sidecar.sh    # one-time legacy → sidecar migration
    ├── list-tenants.sh          # human-readable / JSON table
    ├── backup-tenant.sh         # WAL-safe SQLite + fnox + age tarball
    └── restore-tenant.sh        # inverse of backup
```
