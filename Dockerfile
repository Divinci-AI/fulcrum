# Multi-stage Dockerfile for the Fulcrum SaaS container.
#
# Build:    docker build -t divinci-ai/fulcrum:dev .
# Run:      docker run --rm -p 7777:7777 -v $(pwd)/data:/data divinci-ai/fulcrum:dev
#
# The runtime image contains every binary Fulcrum needs at runtime — bun,
# dtach, git, fnox, age, uv, claude — so a tenant container can boot, run
# agents, and persist secrets without touching the host.

# -------------------- builder --------------------
FROM oven/bun:1-debian AS builder

WORKDIR /build

# Install build deps. node is needed because some npm packages still compile
# native modules through node-gyp during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first so bun install caches across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Frontend bundle + tsc type emit. Server runs from source via bun, no JS bundle needed.
RUN bun run build

# -------------------- runtime --------------------
FROM oven/bun:1-debian AS runtime

# Runtime system deps:
#   - dtach: persistent terminal sessions (CLAUDE.md "Terminal Architecture")
#   - git: worktree creation in server/services/task-service.ts
#   - age: encryption key generation for fnox
#   - ca-certificates: HTTPS to Google/GitHub/etc.
#   - curl, tar, xz-utils: fetching binaries that aren't in apt (fnox, uv, claude)
#   - wget: healthcheck in docker-compose.tenant.template.yaml
#   - tini: PID 1 + signal handling for the bun process
RUN apt-get update && apt-get install -y --no-install-recommends \
        dtach \
        git \
        age \
        ca-certificates \
        curl \
        tar \
        xz-utils \
        wget \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Binaries not in apt — pin to a known platform target. The image targets
# linux/amd64 by default; multi-arch can be added via buildx later.
ARG TARGETARCH=amd64
ARG FNOX_VERSION=latest

# fnox — encrypted secrets, every Fulcrum config value lives here at runtime
RUN set -e; \
    arch=$(uname -m | sed 's/aarch64/aarch64/;s/x86_64/x86_64/'); \
    curl -fsSL "https://github.com/jdx/fnox/releases/${FNOX_VERSION}/download/fnox-${arch}-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /tmp; \
    install -m 0755 /tmp/fnox /usr/local/bin/fnox; \
    rm -f /tmp/fnox

# uv — Python package manager, used by templates and copier flows
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# claude — primary AI agent runtime. Installed as a non-root step into a known
# path; we drop privileges before the container actually runs the agent.
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- --install-dir /usr/local/bin || true

# App layout
WORKDIR /app

# Copy node_modules and built artifacts from builder. node_modules is
# Bun-managed (no native rebuild required at runtime) so a straight copy
# works.
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/server ./server
COPY --from=builder /build/shared ./shared
COPY --from=builder /build/drizzle ./drizzle
COPY --from=builder /build/package.json ./package.json

# Per-tenant data lives outside the container at /data. fulcrum's FULCRUM_DIR
# env var (server/lib/settings/paths.ts:86) controls every filesystem path.
ENV FULCRUM_DIR=/data/.fulcrum \
    FULCRUM_SERVER_PORT=7777 \
    NODE_ENV=production \
    # Bun's default tmpdir inside /tmp is fine; explicit so worktrees don't
    # collide if multiple containers shared a host (they don't, but explicit).
    TMPDIR=/tmp

# Prepare the data mountpoint. The compose template mounts ./data/<slug>:/data
# but the directory must exist for bun to chdir into it for fnox state.
RUN mkdir -p /data/.fulcrum && chown -R bun:bun /data /app

USER bun

EXPOSE 7777

# tini handles SIGTERM and reaps zombies (PTY children create lots).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "server/index.ts"]
