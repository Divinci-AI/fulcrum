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

```sh
# One-time: create a PAT at https://github.com/settings/tokens with
# write:packages, then:
echo "$GHCR_PAT" | docker login ghcr.io -u mikeumus --password-stdin

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

---

## §6 — Teardown

```sh
./org-destroy.sh acme --yes-really
# Retype "acme" when prompted.
# A tarball lands in /opt/fulcrum-saas/backups/destroyed/acme-YYYYMMDDTHHMMSSZ.tar.zst
```

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
  users. Plan 2–6 months of lead time + $500–$4,500/yr.

---

## Troubleshooting

**"cloudflare API error: 9109 Invalid or missing API token"**
The token in `CLOUDFLARE_API_TOKEN` either lacks one of the three required
permissions or has expired. Re-create at
https://dash.cloudflare.com/profile/api-tokens.

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
