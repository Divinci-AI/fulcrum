#!/usr/bin/env bash
# local-build.sh — operator fallback for shipping the Mac DMG when CI is
# unavailable (e.g. the publish.yml workflow is blocked by GH billing).
#
# Equivalent to `mise run desktop:package` plus an optional `gh release`
# upload step. Installs mise on demand (idempotent) so a fresh checkout
# on a new machine can ship a DMG with one command.
#
# Usage:
#   ./desktop/scripts/local-build.sh                # build only
#   ./desktop/scripts/local-build.sh --release      # build + create v<X> release
#   ./desktop/scripts/local-build.sh --release --tag=v5.10.2
#
# Flags:
#   --release         Create a GitHub release and upload the DMG. Tag is
#                     derived from package.json's version unless --tag set.
#   --tag=<vX.Y.Z>    Override the release tag.
#   --skip-build      Skip the build chain (use an existing DMG in desktop/dist).
#   --help            Show this header.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RELEASE=0
SKIP_BUILD=0
TAG=""

for arg in "$@"; do
  case "$arg" in
    --release) RELEASE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --tag=*) TAG="${arg#--tag=}" ;;
    --help|-h)
      sed -n '2,/^set -e/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^set -e/d'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '\033[1;36m[local-build %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- Pre-flight: ensure mise is available, install if missing ---
ensure_mise() {
  if command -v mise >/dev/null 2>&1; then
    return
  fi
  # mise may exist but not on PATH (e.g. installed in a previous run).
  for candidate in "$HOME/.local/bin/mise" "$HOME/.cargo/bin/mise"; do
    if [ -x "$candidate" ]; then
      export PATH="$(dirname "$candidate"):$PATH"
      return
    fi
  done

  log "mise not found — installing via https://mise.run …"
  curl -fsSL https://mise.run | sh
  if [ -x "$HOME/.local/bin/mise" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v mise >/dev/null 2>&1 || die "mise install completed but binary still not on PATH; add ~/.local/bin to PATH and re-run."
}

# --- Pre-flight: platform sanity (Mac DMG only builds on Mac) ---
case "$(uname -s)" in
  Darwin) PLATFORM="mac"; PKG_GLOB="desktop/dist/*.dmg" ;;
  Linux)  PLATFORM="linux"; PKG_GLOB="desktop/dist/*.AppImage" ;;
  *) die "Unsupported platform: $(uname -s)" ;;
esac

cd "$REPO_ROOT"

# --- Build ---
if [ "$SKIP_BUILD" -eq 0 ]; then
  ensure_mise
  # mise refuses to read mise.toml unless the directory is explicitly
  # trusted — `mise trust` is a one-time per-machine acknowledgement.
  # Idempotent: noop after the first run.
  mise trust "$REPO_ROOT" >/dev/null 2>&1 || true
  log "Building desktop package via 'mise run desktop:package' on ${PLATFORM}…"
  log "(This takes ~5-10 min: frontend build + bun compile server + neu build + dmg/AppImage package.)"
  mise run desktop:package
fi

# Pick the newest artifact matching the glob — desktop:package writes a
# single file but if older builds were left around we want the latest.
# shellcheck disable=SC2012
ARTIFACT="$(ls -t $PKG_GLOB 2>/dev/null | head -1 || true)"
[ -n "$ARTIFACT" ] || die "No package found at $PKG_GLOB after build."
log "Artifact: $ARTIFACT"

# --- Release (optional) ---
if [ "$RELEASE" -eq 1 ]; then
  command -v gh >/dev/null 2>&1 || die "gh CLI not on PATH; install it or skip --release."

  if [ -z "$TAG" ]; then
    VERSION="$(jq -r '.version' "$REPO_ROOT/package.json")"
    TAG="v${VERSION}"
  fi

  log "Creating release $TAG with artifact $ARTIFACT"
  # Idempotent: if the release already exists, upload to it; else create.
  if gh release view "$TAG" >/dev/null 2>&1; then
    log "Release $TAG already exists — uploading artifact to it."
    gh release upload "$TAG" "$ARTIFACT" --clobber
  else
    gh release create "$TAG" "$ARTIFACT" \
      --title "$TAG" \
      --notes "Local build via desktop/scripts/local-build.sh."
  fi
fi

log "Done. Artifact: $ARTIFACT"
