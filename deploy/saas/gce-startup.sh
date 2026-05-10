#!/usr/bin/env bash
#
# gce-startup.sh — first-boot setup for the Fulcrum SaaS GCE host.
#
# This runs once as root via GCE's startup-script metadata. It installs Docker
# + Compose plugin + jq + zstd + cloudflared + git, then prepares the on-disk
# layout the provisioning scripts assume (`/opt/fulcrum-saas/...`).
#
# Hand off to gcloud at instance creation time:
#     gcloud compute instances create fulcrum-saas-1 \
#         ... \
#         --metadata-from-file=startup-script=deploy/saas/gce-startup.sh
#
# After the script finishes (~3 minutes), SSH in and do the two remaining
# interactive steps that can't be automated (browser SSO required):
#   1. cloudflared tunnel login
#   2. cloudflared tunnel create fulcrum-saas-1
#   3. sudo cloudflared service install <TUNNEL-TOKEN>
#   4. sudo systemctl enable --now cloudflared
#
# Then `docker login` (or `gcloud auth configure-docker`) and `docker pull`
# the Fulcrum image. See deploy/saas/RUNBOOK.md §2 for the full walkthrough.

set -euxo pipefail

# Idempotency — startup-script can fire on reboot in some configurations.
if [[ -f /opt/fulcrum-saas/.bootstrapped ]]; then
  echo "already bootstrapped — skipping"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    zstd

# Docker (official repo for current Compose plugin)
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y --no-install-recommends \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-compose-plugin

systemctl enable --now docker

# Let the default `ubuntu` user run docker without sudo.
usermod -aG docker ubuntu

# cloudflared (official repo)
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y --no-install-recommends cloudflared

# Persistent state lives under /opt/fulcrum-saas, mounted on the boot disk.
mkdir -p /opt/fulcrum-saas/{stacks,data,backups/destroyed,tunnel}
chown -R ubuntu:ubuntu /opt/fulcrum-saas

# Clone the Fulcrum repo so the provisioning scripts are available on-host.
# Read-only; we never push from the host. Token-less HTTPS works as long as
# the Divinci-AI/fulcrum repo is public or the user runs `gh auth login` later.
sudo -u ubuntu git clone https://github.com/Divinci-AI/fulcrum.git /opt/fulcrum-saas-src || true

# Stable path for the scripts, in case the repo is moved later.
ln -sf /opt/fulcrum-saas-src/deploy/saas/provisioning /usr/local/lib/fulcrum-provisioning

# Sentinel so we don't redo any of this on reboot.
touch /opt/fulcrum-saas/.bootstrapped

echo "gce-startup.sh complete — SSH in and finish cloudflared tunnel setup (RUNBOOK §2)"
