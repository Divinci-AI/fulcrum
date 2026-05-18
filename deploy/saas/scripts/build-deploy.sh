#!/usr/bin/env bash
# build-deploy.sh — one-shot Fulcrum deploy (D-10 PR 1)
#
# Replaces the four-step manual sequence:
#   1. docker build --platform linux/amd64 -t divinci-ai/fulcrum:dev .
#   2. docker save | gzip | gcloud compute ssh ... 'gunzip | docker load'
#   3. ssh ... 'docker stop/rm; docker compose up; wait healthy'
#   4. bunx playwright test --project=prod
#
# Usage:
#   ./scripts/build-deploy.sh                    # full deploy of acme
#   ./scripts/build-deploy.sh --tenant=foo       # different tenant slug
#   ./scripts/build-deploy.sh --skip-build       # reuse existing local image
#   ./scripts/build-deploy.sh --skip-e2e         # skip prod Playwright run
#   ./scripts/build-deploy.sh --skip-stream      # local image already on host
#   ./scripts/build-deploy.sh --prune            # also `docker image prune -f` on host after recreate
#   ./scripts/build-deploy.sh --help
#
# Requires the operator's `~/.zshrc` to export:
#   GCP_PROJECT     (default: fulcrum-mike-2026)
#   GCE_INSTANCE    (default: fulcrum-saas-1)
#   GCE_ZONE        (default: us-central1-a)
#   FULCRUM_E2E_PROD_URL  (default: https://fulcrum-acme.divinci.ai)
#   CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET  (for e2e; if absent, e2e auto-skips)

set -euo pipefail

# --- Defaults & arg parsing ---
TENANT="acme"
SKIP_BUILD=0
SKIP_STREAM=0
SKIP_E2E=0
# Default off so the operator keeps the previous image as a rollback
# candidate. Opt in with --prune once you're confident the new image
# is good (or just to free disk — every deploy adds ~3GB of layers
# and the 96GB GCE root fills in ~30 deploys without cleanup).
PRUNE=0
IMAGE_TAG="divinci-ai/fulcrum:dev"

GCP_PROJECT="${GCP_PROJECT:-fulcrum-mike-2026}"
GCE_INSTANCE="${GCE_INSTANCE:-fulcrum-saas-1}"
GCE_ZONE="${GCE_ZONE:-us-central1-a}"

usage() {
  sed -n '2,/^set -e/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^set -e/d'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --tenant=*)    TENANT="${arg#*=}" ;;
    --skip-build)  SKIP_BUILD=1 ;;
    --skip-stream) SKIP_STREAM=1 ;;
    --skip-e2e)    SKIP_E2E=1 ;;
    --prune)       PRUNE=1 ;;
    --image=*)     IMAGE_TAG="${arg#*=}" ;;
    --help|-h)     usage 0 ;;
    *)
      echo "Unknown arg: $arg" >&2
      usage 1
      ;;
  esac
done

# --- Locate repo root (script lives at deploy/saas/scripts/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

log() {
  printf '\033[1;36m[deploy %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"
}

# --- Step 1: build (amd64 explicitly so we don't ship arm64 to the GCE host) ---
if [ "$SKIP_BUILD" -eq 0 ]; then
  log "Building ${IMAGE_TAG} for linux/amd64 from ${REPO_ROOT}…"
  docker build --platform linux/amd64 -t "$IMAGE_TAG" "$REPO_ROOT"
  log "Build done."
else
  log "Skipping build (--skip-build); using existing local $IMAGE_TAG"
fi

# --- Step 2: stream image to GCE host ---
SSH_BASE=(gcloud compute ssh "$GCE_INSTANCE" --project="$GCP_PROJECT" --zone="$GCE_ZONE")

if [ "$SKIP_STREAM" -eq 0 ]; then
  log "Streaming image to $GCE_INSTANCE (this is the slow step — ~25-30 min over residential up)…"
  docker save "$IMAGE_TAG" | gzip -1 \
    | "${SSH_BASE[@]}" --command='gunzip | docker load'
  log "Stream done."
else
  log "Skipping stream (--skip-stream); image must already be on host"
fi

# --- Step 3: recreate the tenant container, wait healthy, probe /health ---
CONTAINER="fulcrum-${TENANT}"
log "Recreating $CONTAINER on host…"

# Pass tenant in via env on the remote side so we don't have to quote-wrap a
# variable inside the heredoc.
"${SSH_BASE[@]}" --command="export TENANT='${TENANT}'; bash -s" <<'REMOTE'
set -euo pipefail
CONTAINER="fulcrum-${TENANT}"
docker stop "$CONTAINER" 2>/dev/null || true
docker rm "$CONTAINER" 2>/dev/null || true
FULCRUM_SAAS_ROOT=/opt/fulcrum-saas \
  docker compose -p fulcrum-saas \
    --project-directory /opt/fulcrum-saas \
    -f "/opt/fulcrum-saas/stacks/${TENANT}.yaml" up -d
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
  echo "  [$i] health: $s"
  if [ "$s" = "healthy" ]; then break; fi
  sleep 3
done
curl -fsS http://127.0.0.1:7777/health
echo
REMOTE
log "Container healthy."

# --- Step 4: optional prod e2e ---
if [ "$SKIP_E2E" -eq 0 ]; then
  if ! command -v bunx >/dev/null 2>&1; then
    log "bunx not in PATH; skipping prod e2e. Install bun or rerun with --skip-e2e to silence this."
  elif [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
    log "CF_ACCESS_CLIENT_ID/SECRET unset — prod e2e would land on SSO. Skipping."
  else
    log "Running prod Playwright suite (against ${FULCRUM_E2E_PROD_URL:-https://fulcrum-acme.divinci.ai})…"
    bunx playwright test --config="$REPO_ROOT/e2e/playwright.config.ts" --project=prod
    log "Prod e2e green."
  fi
else
  log "Skipping prod e2e (--skip-e2e)"
fi

# --- Step 5: optional image prune on host ---
# Discovered the hard way deploying D-10 PR 8: 21 dangling images
# from this session's deploy cadence filled the 96GB root and the
# next docker load failed with "no space left on device". Defaults
# off so an operator keeps a rollback image; flip --prune on once
# confident or to recover from a near-full host.
if [ "$PRUNE" -eq 1 ]; then
  log "Pruning dangling images on host…"
  "${SSH_BASE[@]}" --command='docker image prune -f | tail -2'
fi

log "✓ Deploy complete: tenant=$TENANT image=$IMAGE_TAG"
