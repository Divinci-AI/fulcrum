# SaaS deploy — bugs caught during the first end-to-end run

Captured during the first `org-create.sh acme` deploy on `fulcrum-saas-1`
(GCE, us-central1-a). Most have been patched on `feat/saas-container-image`;
a few are intentionally deferred as architectural follow-ups.

## Fixed in this branch

| # | Where | What | How |
|---|---|---|---|
| 1 | `Dockerfile` runtime stage | `chown -R bun:bun /data` at build time is wiped when `/data` is volume-mounted at runtime → container crashes with `EACCES: permission denied, mkdir '/data/.fulcrum'` | `org-create.sh` chowns the host data dir to UID 1000 before `docker compose up`. (Could be tightened further by adding `user:` to the compose template — TBD.) |
| 2 | `Dockerfile` | `RUN curl claude.ai/install.sh \| bash -s -- --install-dir /usr/local/bin` — the install script doesn't accept that flag; previous run silently swallowed the error via `\|\| true` and left `claude` absent on PATH | Replaced with `ln -sf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude /usr/local/bin/claude` so Fulcrum's `which claude` check passes without a second 225 MB copy |
| 3 | `Dockerfile` | Bundled `claude` binary is musl-linked, but `oven/bun:1-debian` is glibc — execution failed with "cannot execute: required file not found" because `/lib/ld-musl-x86_64.so.1` was absent | Added `musl` to the apt install list (~3 MB) so the dynamic linker is present |
| 4 | `Dockerfile` | `server/routes/mcp{,-restricted}.ts` import from `../../cli/src/`, but only `server/` `shared/` `drizzle/` `dist/` were COPYed in the runtime stage → import error on first request | Added `COPY --from=builder /build/cli ./cli` |
| 5 | `Dockerfile` | `server/index.ts:34` defaults `HOST=localhost`; inside a container that binds only to the loopback interface and Docker port-publish can't reach it → "Empty reply from server" | Added `ENV HOST=0.0.0.0` |
| 6 | `_cf-api.sh` `cf_dns_ensure_cname` | Passed `--arg name "$subdomain"` to CF DNS API, which interpreted it relative to the zone and created `acme.divinci.ai` instead of `acme.fulcrum.divinci.ai` | Now passes the FULL `$hostname`. CF correctly creates the intended record. |
| 7 | `_cf-api.sh` `cf_access_app_ensure` | Used Cloudflare Access Groups, but the API token's `Access: Apps and Policies` permission doesn't include Groups in recent CF token UI splits → 403 on group endpoints | Refactored to inline the owner email directly in the Access App's policy. Multi-member orgs become a future feature. |
| 8 | `org-create.sh` + helpers | Default base domain was `fulcrum.divinci.ai`, producing `<slug>.fulcrum.divinci.ai` — two levels deep, which free Cloudflare Universal SSL doesn't cover → `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` in the browser | Flat naming: `fulcrum-<slug>.divinci.ai`. One level deep, covered by free Universal SSL. Stays inside the free tier. |
| 9 | `docker-compose.tenant.template.yaml` | No host port published — cloudflared on the host (not inside Docker) couldn't resolve `fulcrum-<slug>` because that hostname is only valid inside the docker network → 502 Bad Gateway | Added `ports: ["127.0.0.1:7777:7777"]`. Single-tenant works. **See open issue below for N-tenant collision.** |
| 10 | `gce-startup.sh` | `git clone https://github.com/Divinci-AI/fulcrum.git ... \|\| true` silently failed because the repo is private — provisioning scripts never landed on the host | Added optional GCE metadata `fulcrum-deploy-token` for token-authed clone; removed the `\|\| true` mask so failures are loud |
| 11 | Compose template healthcheck | Hit `/api/health`, but Fulcrum mounts the route at `/health` (`server/app.ts:87`) | Fixed earlier in 462077de |

## Open follow-ups (NOT fixed; staging for separate PRs)

| # | What | Why deferred |
|---|---|---|
| A | **Tunnel creation must produce a remote-managed tunnel.** `cloudflared tunnel create` produces `config_src: local`; the provisioning scripts assume remote-managed. The bootstrap doc currently relies on the operator doing a manual delete+recreate via the API. | Should add an API-first tunnel-create step in either `gce-startup.sh` or `org-create.sh` first-run. ~30 min of code |
| B | **Port 7777 collides across tenants.** The host port-publish in (#9) works for one tenant but breaks at N>1. | Two fixes: allocate unique host ports per tenant in `org-create.sh`, OR move cloudflared into a Docker container on `fulcrum-gateway` network so it can resolve container hostnames directly. The container approach is the *right* answer. ~2 hours |
| C | **arm64 vs amd64 image.** Dockerfile builds for native arch; on Apple Silicon → arm64 image, useless on amd64 GCE host. Currently sidestepped by rebuilding on the GCE host itself. | Add `docker buildx --platform linux/amd64,linux/arm64 --push` step to a CI workflow. Will land alongside the e2e CI work. |
| D | **Phase 1 OAuth UI cleanup not in image.** The container shows the OAuth credentials input fields in Settings even though env vars provide them, because Phase 3 was branched off Phase 2 (off main) — Phase 1's `managedByHost` hide-fields fix isn't included. | Merge Phase 1 into Phase 3 (or rebase Phase 3 onto Phase 1) before the next image rebuild. Trivial git work |
| E | **Repo is private; `gce-startup.sh` needs a deploy token.** The startup script supports `fulcrum-deploy-token` metadata but no token is provisioned yet. | Mint a fine-grained GitHub PAT (read:contents on Divinci-AI/fulcrum), attach via `gcloud compute instances add-metadata`. ~5 min |
| F | **CF Access only covers `fulcrum-<slug>.divinci.ai`.** No SSO IdP probe in provisioning — relies on the operator having an IdP configured in Zero Trust. | Add a preflight to `org-create.sh` that checks `/access/identity_providers` returns ≥1 IdP. Helpful but not critical |
| G | **OAuth redirect URI per tenant.** Each new `fulcrum-<slug>.divinci.ai` needs its callback URL added to the Google OAuth client (Google doesn't support wildcards). | Either (a) automate via Google Cloud SDK in `org-create.sh`, (b) use a central callback router that dispatches to the right tenant via `state` parameter. (b) is cleaner architecturally |
| H | **Client secret rotation reminder.** The `****Kq0g` Google client secret leaked into the chat transcript during this session's setup. Should be rotated. | Manual action: add a new secret, update env, delete `Kq0g`. ~5 min |
| I | **CF API token leaked.** The `cfut_ZP6F...` token is also in the chat transcript. Same rotation reminder. | Manual action: delete + recreate the token. ~3 min |

## "Wat" moments worth memorializing

- **Cloudflare's API token form requires a Zone-typed permission to surface the "Zone Resources" section.** Picking only Account permissions means the resources scope silently defaults to an empty set, and the token returns `success: true, result: []` everywhere. Looks like a working token. Isn't.

- **CF Access service token strings are prefixed `cfat_`** and look like API tokens but **are not** — they're for Cloudflare Access service-to-service auth. They'll authenticate against Access policies but return 401 on `api.cloudflare.com`. Genuinely confusable.

- **Google client secrets can never be viewed after creation** — only the last 4 characters are shown. The fix is "Add Secret" (Google supports multiple active secrets per client); the old one stays usable until you delete it.

- **Cloudflare Universal SSL Free covers exactly one wildcard depth.** `*.divinci.ai` works. `*.fulcrum.divinci.ai` does not. Subdomain depth is a billing decision before it's a UX one.
