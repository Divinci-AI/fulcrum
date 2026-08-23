# Fulcrum SaaS — Operator Runbook

> Status: **first-customer playbook**. Walk this top-to-bottom to get
> `acme.fulcrum.divinci.ai` reachable. Subsequent customers skip everything
> in §1–§3 and run only §4's `org-create.sh`.

The scripts in `provisioning/` and the `Dockerfile` at the repo root assume
you've completed §1–§3 once. The pieces I (Claude) cannot do for you require
either interactive browser SSO (gcloud auth, docker registry login) or a
billable GCP project — those are the manual steps. Everything else is one
command.

---

## §1 — Push the image to a registry

You'll pull this image to the GCE host (and any future hosts). Two options;
pick one.

### Option A: GitHub Container Registry (recommended for early stages)

Free, no GCP setup needed, lives next to your code.

Two ways to push:

#### A.1 — Automated CI (preferred once Actions billing is unblocked)

`.github/workflows/docker-image.yml` builds multi-arch (linux/amd64 +
linux/arm64) and pushes on every merge to main. Tags emitted:
- `:dev` (floating, used by `acme.yaml`)
- `:v<package.json version>` (versioned)
- `:sha-<7-char>` (immutable, for rollback)

No operator action needed beyond `git merge`. **LIVE since 2026-08-23** —
this paragraph used to say the workflow was dormant on Actions billing; that
is no longer true. See §7 for the pull-based deploy it enables.

#### A.2 — Manual push (current path while Actions billing is blocked)

```sh
# One-time: create a PAT at https://github.com/settings/tokens with
# write:packages, then:
echo "$GHCR_PAT" | docker login ghcr.io -u mikeumus --password-stdin

# Build for the target arch (GCE host is amd64; building from Apple
# Silicon needs --platform linux/amd64 or the container fails to
# exec on the host — see Gotcha in saas memory).
docker build --platform linux/amd64 -t divinci-ai/fulcrum:dev .

# Tag the local image
docker tag divinci-ai/fulcrum:dev ghcr.io/divinci-ai/fulcrum:dev
docker tag divinci-ai/fulcrum:dev ghcr.io/divinci-ai/fulcrum:latest

# Push
docker push ghcr.io/divinci-ai/fulcrum:dev
docker push ghcr.io/divinci-ai/fulcrum:latest

# Make the image readable by the GCE host's pull token:
# https://github.com/orgs/Divinci-AI/packages/container/fulcrum/settings
# → Manage Actions access OR set visibility to Public
```

Or, when network egress is the bottleneck, use the
`docker save | gzip | ssh | docker load` stream from §7.

Set `FULCRUM_SAAS_IMAGE=ghcr.io/divinci-ai/fulcrum:dev` in the GCE host's
zshrc.

### Option B: GCP Artifact Registry

Native to your GCP infra; pay for storage and pull egress.

```sh
# One-time setup
gcloud config set project <your-divinci-ai-project>
gcloud artifacts repositories create fulcrum \
    --repository-format=docker \
    --location=us-central1 \
    --description="Fulcrum SaaS container images"
gcloud auth configure-docker us-central1-docker.pkg.dev

# Tag + push
REPO=us-central1-docker.pkg.dev/<your-divinci-ai-project>/fulcrum/fulcrum
docker tag divinci-ai/fulcrum:dev $REPO:dev
docker tag divinci-ai/fulcrum:dev $REPO:latest
docker push $REPO:dev
docker push $REPO:latest
```

Set `FULCRUM_SAAS_IMAGE=us-central1-docker.pkg.dev/.../fulcrum:dev` on the
GCE host.

---

## §2 — Provision the GCE host

One Compute Engine VM, Docker installed, `cloudflared` running. This is the
host that will eventually run every tenant container.

```sh
gcloud config set project <your-divinci-ai-project>

# Recommended starting size — fine for ~30 small orgs.
# Bump CPU/RAM later by `gcloud compute instances set-machine-type`.
gcloud compute instances create fulcrum-saas-1 \
    --zone=us-central1-a \
    --machine-type=e2-standard-4 \
    --image-family=ubuntu-2404-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=100GB \
    --boot-disk-type=pd-balanced \
    --tags=cloudflare-tunnel \
    --metadata-from-file=startup-script=gce-startup.sh   # see below

# SSH in
gcloud compute ssh fulcrum-saas-1 --zone=us-central1-a
```

`gce-startup.sh` (in this directory once you've copied the snippet below
locally) installs Docker, jq, zstd, cloudflared, and clones the Fulcrum repo
on first boot:

```sh
#!/bin/bash
set -euxo pipefail
apt-get update
apt-get install -y docker.io docker-compose-plugin jq zstd curl git
systemctl enable --now docker
usermod -aG docker ubuntu

# cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared

# Repo (read-only)
sudo -u ubuntu git clone https://github.com/Divinci-AI/fulcrum.git /opt/fulcrum-saas-src
ln -s /opt/fulcrum-saas-src/deploy/saas/provisioning /usr/local/lib/fulcrum-provisioning

# Persistent state lives in /opt/fulcrum-saas
mkdir -p /opt/fulcrum-saas/{stacks,data,backups/destroyed,tunnel}
chown -R ubuntu:ubuntu /opt/fulcrum-saas
```

After SSHing in:

1. **Authenticate the host's tunnel** (browser-only step):
   ```sh
   cloudflared tunnel login
   cloudflared tunnel create fulcrum-saas-1
   # Note the tunnel ID it prints — you'll need it in §3.
   ```
2. **Install systemd unit** so the tunnel survives reboots:
   ```sh
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   ```
3. **Authenticate the registry pull** (so the host can pull the image):
   - GHCR option: `echo $GHCR_PAT | docker login ghcr.io -u <user> --password-stdin`
   - Artifact Registry option:
     `gcloud auth configure-docker us-central1-docker.pkg.dev --quiet`
     (uses the VM's attached service account; grant it
     `roles/artifactregistry.reader` first)
4. **Pull the image**:
   ```sh
   docker pull $FULCRUM_SAAS_IMAGE
   ```

---

## §3 — Configure the host's zshrc

On the GCE host, the operator account (`ubuntu` by default) needs these env
vars set in `~/.bashrc` or `~/.zshrc`. Replace placeholders with real values.

```sh
# Image
export FULCRUM_SAAS_IMAGE="ghcr.io/divinci-ai/fulcrum:dev"   # or your AR path
export FULCRUM_SAAS_ROOT="/opt/fulcrum-saas"
export FULCRUM_SAAS_BASE_DOMAIN="fulcrum.divinci.ai"

# Cloudflare API token — create at https://dash.cloudflare.com/profile/api-tokens
# with these permissions (no need for "Edit zone DNS" on every zone — scope to
# fulcrum.divinci.ai only):
#   • Zone   • DNS         • Edit   (Specific Zone → fulcrum.divinci.ai)
#   • Account• Access:Apps • Edit
#   • Account• Cloudflare Tunnel • Edit
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."        # Divinci-AI Cloudflare account
export CLOUDFLARE_ZONE_ID="..."           # for fulcrum.divinci.ai
export CLOUDFLARE_TUNNEL_ID="..."         # from `cloudflared tunnel create`

# Bundled Google OAuth — same values that customers' Fulcrum containers
# inherit. Phase 1 branch makes the Settings UI hide credential inputs
# automatically when both are set.
export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
```

Sanity check:
```sh
source ~/.zshrc   # or relog
echo "$CLOUDFLARE_API_TOKEN" | head -c 8 && echo "..."
curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/user/tokens/verify" \
    | jq .result.status
# expect: "active"
```

---

## §4 — Provision the first org

On the GCE host:

```sh
cd /usr/local/lib/fulcrum-provisioning   # the symlink the startup script set up
./org-create.sh acme --owner $YOUR_EMAIL
```

Expected output:
```
[1/6] preflight — checking slug is free
[2/6] rendering compose template → /opt/fulcrum-saas/stacks/acme.yaml
[3/6] docker compose up -d
[4/6] waiting for /health on fulcrum-acme (60s max)
      healthy
[5/6] cloudflare provisioning
      DNS: created CNAME acme.fulcrum.divinci.ai
      Tunnel: added ingress acme.fulcrum.divinci.ai → fulcrum-acme:7777
      Access Group: created org-acme (...)
      Access App: created acme.fulcrum.divinci.ai (...) gated by org-acme
[6/6] done

  Public URL : https://acme.fulcrum.divinci.ai
```

Visit `https://acme.fulcrum.divinci.ai` — Cloudflare Access challenges with
SSO, you sign in as `$YOUR_EMAIL`, Fulcrum loads. You're in.

---

## §5 — Add more users / more orgs

```sh
./org-adduser.sh acme bob@acme.com
./org-rmuser.sh  acme bob@acme.com
./org-create.sh  bobsco --owner ceo@bobsco.io
```

Removal takes effect on Bob's next request (~60s session invalidation).
Adding a user requires no Fulcrum-side change.

### Which compose template to use

There are two templates in `deploy/saas/`:

| Template | When |
|---|---|
| `docker-compose.tenant.template.yaml` | **Single-tenant only.** Publishes the container port to host loopback (`127.0.0.1:7777`); the host's systemd `cloudflared` service routes the public URL there. This is what the current `acme` stack uses. |
| `docker-compose.tenant.sidecar.template.yaml` | **Multi-tenant.** Runs cloudflared as a per-tenant sidecar container on a per-tenant docker network. No host port is published, so N tenants coexist without port-7777 collisions. Each tenant needs its own Cloudflare Tunnel + token. |

When the second tenant comes online, also migrate `acme` to the
sidecar template in the same cutover. Steps:

1. Create a fresh Cloudflare Tunnel for acme; copy its token.
2. Stop the host's systemd `cloudflared` service (or remove the
   acme ingress from its config).
3. Re-render `stacks/acme.yaml` from the sidecar template, including
   `CLOUDFLARED_TUNNEL_TOKEN=<token>`.
4. `docker compose -f stacks/acme.yaml up -d --force-recreate`.
5. Confirm `acme.fulcrum.divinci.ai` still resolves end-to-end.

---

## §6 — Teardown

```sh
./org-destroy.sh acme --yes-really
# Retype "acme" when prompted.
# A tarball lands in /opt/fulcrum-saas/backups/destroyed/acme-YYYYMMDDTHHMMSSZ.tar.zst
```

---

## §7 — Redeploy an existing tenant on a new image build

After merging changes to main, push the new image and recreate each
tenant's container against it. The data bind-mount is preserved across
recreate (the bind source is on the host filesystem, outside the
container layer), so SQLite + fnox config survive.

### The fastest path (since 2026-08-23): pull the CI-built image

`.github/workflows/docker-image.yml` is **no longer dormant** — the note in §1
saying it waits on Actions billing is stale. It builds linux/amd64 +
linux/arm64 on every push to main and pushes three tags. Verified on run
32622211861 (commit b285ee53):

```
ghcr.io/divinci-ai/fulcrum:dev
ghcr.io/divinci-ai/fulcrum:v<package.json version>
ghcr.io/divinci-ai/fulcrum:sha-<7-char>       # immutable — use this to roll back
```

So the deploy is a pull, not a build:

```sh
gcloud compute ssh fulcrum-saas-1 --zone=us-central1-a --project=fulcrum-mike-2026 \
  --command='sudo docker pull ghcr.io/divinci-ai/fulcrum:dev \
             && sudo docker tag ghcr.io/divinci-ai/fulcrum:dev divinci-ai/fulcrum:dev'
# then Step 2 below (stop / rm / compose up / wait healthy)
```

The retag preserves the un-namespaced reference the compose template expects.

**The host needs a `read:packages` credential — the package is private.**
Without it the pull fails `error from registry: unauthorized`. Mint a CLASSIC
PAT with `read:packages` and NOTHING else (fine-grained PATs still do not work
with GHCR), then, from a terminal — never inside an agent session, and never
via `echo`, which appends a newline to the secret:

```sh
printf '%s' 'THE_TOKEN' | gcloud compute ssh fulcrum-saas-1 \
  --zone=us-central1-a --project=fulcrum-mike-2026 \
  --command='sudo docker login ghcr.io -u mikeumus --password-stdin'
```

That writes the token (base64, not encrypted) into `/root/.docker/config.json`.
It is long-lived on a VM that stays up for months — set an expiry and put the
date somewhere you will see it, because when it lapses deploys fail at the pull
with the same `unauthorized` and nothing announces why.

⚠️ **Do NOT make the package public to avoid the credential.** The image
contains the whole application and the repo is PolyForm Perimeter licensed —
publishing the image publishes the product.

**The alternative worth considering:** the VM's service account already carries
`devstorage.read_only`, so it can pull from **GCP Artifact Registry** with no
static credential at all — nothing to store, rotate, or leak. The cost is
wiring GitHub Actions to authenticate to GCP via Workload Identity Federation.
Not done; recorded here so the trade is visible rather than re-derived.

⚠️ **Why the CI push used to fail** (and how to recognise it again): OCI labels
are INHERITED from the base image, and `oven/bun` sets
`org.opencontainers.image.source=https://github.com/oven-sh/bun`. Our package
was therefore linked to **oven-sh/bun**, and `Divinci-AI/fulcrum`'s
GITHUB_TOKEN had no rights over it — the build succeeded and the push died
`denied: permission_denied: read_package`. Fixed by stamping our own label in
the Dockerfile (b285ee53) plus granting the repo Write under the package's
*Manage Actions access*. If you add another image built `FROM` a labelled base,
expect the same and stamp the label from the start.

### The build-it-yourself path: `scripts/build-deploy.sh`

```sh
# Full deploy of acme — build, stream, recreate, e2e
./deploy/saas/scripts/build-deploy.sh

# Just recreate the container against an already-loaded image
./deploy/saas/scripts/build-deploy.sh --skip-build --skip-stream

# Different tenant slug
./deploy/saas/scripts/build-deploy.sh --tenant=foo

# Skip prod e2e (e.g. for off-hours deploys)
./deploy/saas/scripts/build-deploy.sh --skip-e2e
```

The script wraps the manual Steps 1-2 below into one invocation +
also does the recreate + healthcheck + Playwright run that Steps 2-3
otherwise require you to type by hand. See `--help` for the full
flag list.

The manual steps remain documented below for the cases where the
script isn't enough — e.g. building from a non-default working tree,
debugging a specific stage, or initial host bring-up.

### Step 1: get the image onto the host

**Preferred — registry pull:**

```sh
# On dev machine, after `docker build`:
docker tag divinci-ai/fulcrum:dev ghcr.io/divinci-ai/fulcrum:dev
docker tag divinci-ai/fulcrum:dev ghcr.io/divinci-ai/fulcrum:v$(jq -r .version package.json)
docker push ghcr.io/divinci-ai/fulcrum:dev
docker push ghcr.io/divinci-ai/fulcrum:v$(jq -r .version package.json)

# On the GCE host:
docker pull ghcr.io/divinci-ai/fulcrum:dev
docker tag ghcr.io/divinci-ai/fulcrum:dev divinci-ai/fulcrum:dev
```

The retag preserves the un-namespaced reference the compose template
expects. **Caveat**: the host needs read access to the GHCR package —
either make the package public, or put a PAT with `read:packages` into
`~/.docker/config.json` on the host (`docker login ghcr.io -u <user>
--password-stdin <<< $PAT`).

**Fallback — stream the image directly (no registry):**

When the host can't pull (auth gap, registry outage, large diff over
expensive egress), stream from dev to host:

```sh
docker save divinci-ai/fulcrum:dev | gzip -1 \
  | gcloud compute ssh fulcrum-saas-1 --zone=us-central1-a \
      --command='gunzip | docker load'
```

Takes a while (~30 min for a 3 GB compressed image over residential
upload). The image rehydrates with a *new* image ID on the host — the
content digest (`sha256:...` from `docker push` output) is the only
stable cross-host identifier. Track that, not the ID.

### Step 2: recreate the tenant container

```sh
docker stop fulcrum-<slug>
docker rm   fulcrum-<slug>
FULCRUM_SAAS_ROOT=/opt/fulcrum-saas \
  docker compose -p fulcrum-saas --project-directory /opt/fulcrum-saas \
      -f /opt/fulcrum-saas/stacks/<slug>.yaml up -d

# Wait for health (server runs DB migrations on startup, can take ~10s):
for i in {1..15}; do
  s=$(docker inspect -f '{{.State.Health.Status}}' fulcrum-<slug> 2>/dev/null)
  echo "$i: $s"; [ "$s" = "healthy" ] && break; sleep 2
done

curl -fsS http://127.0.0.1:7777/health   # local probe
```

`--project-directory` is no longer strictly required because the
template now uses absolute paths (PR #14+), but pass it anyway for
backward-compat with older rendered stacks/*.yaml files.

### Step 3: rollback if needed

Docker keeps the previous image as a dangling reference until pruned.
Find its ID and retag:

```sh
docker images divinci-ai/fulcrum --filter dangling=true \
    --format '{{.ID}} {{.CreatedSince}}'
# e.g.  2771ae667330  11 hours ago
docker tag 2771ae667330 divinci-ai/fulcrum:dev   # alias back to the old build
# Then repeat Step 2's stop/rm/up cycle.
```

### Step 4: prune (after you're sure the new image works)

```sh
docker image prune -f                           # remove dangling images
docker image prune -a --filter "until=168h" -f  # 7-day TTL on older builds
```

Skip this until at least one full day of successful operation — keeps
rollback cheap.

---

## §8 — Rotate `CLOUDFLARE_API_TOKEN`

The token in operator's `~/.zshrc` needs rotation periodically (the
current one is **expired**, returning 401 on `/user/tokens/verify` —
this blocks future programmatic CF management, including D-8 PR 5 which
adds per-user invites to a CF Access policy).

### Step 1 — create the replacement

1. Open https://dash.cloudflare.com/profile/api-tokens.
2. Click **"Create Token"** → **"Custom token"** at the bottom.
3. Name: `fulcrum-saas-<YYYY-MM>` (date the month you created it).
4. Permissions (exact four):
   - **Zone** › **DNS** › **Edit** — *Specific Zone → divinci.ai*
   - **Account** › **Access: Apps and Policies** › **Edit** — *Specific account → Divinci-AI*
   - **Account** › **Cloudflare Tunnel** › **Edit** — *Specific account → Divinci-AI*
   - **Account** › **Email Sending** › **Edit** — *Specific account → Divinci-AI*
     (D-10 PR 8 — enables auto-sent invite emails. Optional; only
     needed if you flip the "Auto-send invite emails via Cloudflare"
     toggle in Settings → Integrations.)
5. **TTL**: leave blank for non-expiring (preferred — rotation is manual
   and we'd rather rotate on incident-response than discover the token
   has silently died). If your org policy forbids non-expiring, choose
   12+ months.
6. **Client IP filtering**: skip — the GCE host's egress IP can change
   on instance recreate, and locking it down adds an outage mode for
   no real security gain (the token is already a bearer secret).
7. Confirm and **copy the token value once**. Cloudflare never shows it again.

### Step 2 — verify before swapping

Before touching production env, sanity-check the new token from the
operator's machine:

```sh
NEW_TOKEN="<paste fresh token>"
curl -fsS -H "Authorization: Bearer $NEW_TOKEN" \
    https://api.cloudflare.com/client/v4/user/tokens/verify \
    | jq .result.status
# expect: "active"
```

If that returns `"active"`, the permissions are correct. If it returns
4xx, re-check the three permission scopes in step 1.4.

### Step 3 — swap on the operator's shell

```sh
# Edit ~/.zshrc — replace the existing CLOUDFLARE_API_TOKEN export
$EDITOR ~/.zshrc

# Reload
source ~/.zshrc

# Re-verify post-swap
curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    https://api.cloudflare.com/client/v4/user/tokens/verify \
    | jq .result.status
```

### Step 4 — swap on the GCE host

Same procedure on the GCE host's `~/.zshrc` if any scripts there read
the token directly. The Fulcrum container reads it from fnox-managed
config, not the host env, so only the host-side ops scripts need it.

### Step 5 — revoke the old token

Back in the CF dashboard → API Tokens → find the expired/superseded
row → **Roll**. Don't delete blindly without verifying §4 first: if the
new token is broken, you want the option to revert.

### When to rotate

- **Reactive**: any time `/user/tokens/verify` returns non-`"active"`.
- **Proactive**: every 12 months on a calendar reminder, or whenever
  an operator with token access leaves the project.

---

## §9 — Cloudflare Access policy invites (D-8 PR 5, planned)

D-8 PR 5 will wire `POST /api/users` to also add the invited email to
a CF Access policy's `include` list, so admins don't have to round-trip
to the Cloudflare dashboard for each non-Divincian invite. Requires §8
completed first because the call needs an active `CLOUDFLARE_API_TOKEN`.

Until PR 5 lands, the workflow is:
1. Admin invites teammate via `fulcrum users invite teammate@…` (D-8 PR 3b)
2. Operator manually adds teammate's email to the CF Access App's
   policy include list at
   https://one.dash.cloudflare.com/{account}/access/apps

---

## §10 — Bounce / complaint ingest (D-11)

CF Email Sending (beta) doesn't push delivery events as webhooks.
The bounce-handling wire is: outbound DSN bounces → CF Email
Routing on the sending domain → an Email Worker that parses the
DSN/ARF → POST to `/api/email-events` → `email_send_events` table
→ Members UI red badge.

End-to-end requires three pieces wired:

1. **Server side** (Settings → Integrations):
   - Enable "Auto-send invite emails via Cloudflare"
   - Set the "Bounce secret" — paste output of `openssl rand -hex 32`
   - Save. Settings → "cfBounceIngestConfigured" flag flips true.
2. **Worker side** (`deploy/saas/workers/email-bounce-router/`):
   - `wrangler secret put FULCRUM_INGEST_URL` ←
     `https://<tenant>.fulcrum.divinci.ai/api/email-events`
   - `wrangler secret put FULCRUM_INGEST_SECRET` ← same value as
     the "Bounce secret" from step 1
   - `wrangler deploy`
3. **Routing side** (Cloudflare dashboard):
   - Email Routing → enable on the sending domain (publishes MX records)
   - Email Routing → Email Workers tab → bind
     `fulcrum-email-bounce-router` as the catch-all destination

Once all three are in place, a bounce on a typo'd invite address
arrives as a `bounced` event within seconds; the Members row
sprouts a red `bounced` badge with the SMTP reason in its
tooltip.

Full per-step walkthrough:
`deploy/saas/workers/email-bounce-router/README.md`

---

## What's still missing (post-§6)

- **Litestream sidecar** for continuous SQLite replication to R2. Design is
  in `backups/README.md`; not yet wired into the compose template.
- **`org-list.sh`** — list all org stacks on the host with member counts.
  Trivial follow-up; not in this branch.
- **Multi-host load balancing** — single GCE host until ~50 orgs. After that,
  swap to GKE; the compose template is container-native so the lift is
  k8s manifests.
- **CASA submission** — required before we cross 100 total Google-OAuth
  users. Plan 2–6 months of lead time + $500–$4,500/yr. **Prep checklist
  at `deploy/saas/CASA-PREP.md`** — work it before engaging an assessor.

---

## Troubleshooting

**"cloudflare API error: 9109 Invalid or missing API token"**
The token in `CLOUDFLARE_API_TOKEN` either lacks one of the three required
permissions or has expired. See §8 for the full rotation procedure.

**"`<slug>` never became healthy"**
`docker logs fulcrum-<slug>` shows what crashed. Most common: missing
`GOOGLE_CLIENT_ID`/`SECRET` env vars when the container expected them.

**SSO loop on `<slug>.fulcrum.divinci.ai`**
The Access Group is empty or you're not in it. Verify with
`./org-list-users.sh <slug>` (TODO — for now query the group directly via
the dashboard or `cf_access_group_list_emails` from `_cf-api.sh`).

**Image pulls fail on the GCE host**
Either you didn't `docker login` to the registry, or the image is private
and the VM's service account lacks `roles/artifactregistry.reader` (GCP) /
the GHCR package isn't visible to the org (GHCR).
