# Fulcrum E2E tests (Playwright)

Phase A foundation — see `deploy/saas/BUGS.md` for the bugs that motivated
this. Phases B (feature matrix) and C (agent-driven, frontend-MCP bridge)
follow in their own PRs.

## Layout

```
e2e/
├── playwright.config.ts       projects = [local, prod]
├── docker-compose.test.yml    ephemeral Fulcrum for the `local` project
├── smoke.spec.ts              first three regression tests
└── README.md                  this file
```

## Running locally

The local project doesn't need Cloudflare, Google, or any secrets — the
container boots with stub OAuth values. Tests that need real OAuth are
skipped on `local`.

```sh
# 1. (one-time) install Playwright browsers
bunx playwright install chromium

# 2. Build the image. On Apple Silicon you need amd64 explicitly,
#    or you'll see "exec format error" if your dev container runs amd64.
docker buildx build --platform linux/amd64 --load -t divinci-ai/fulcrum:dev .

# 3. Bring up the test stack
docker compose -f e2e/docker-compose.test.yml up -d --wait

# 4. Run
bunx playwright test --config=e2e/playwright.config.ts --project=local

# 5. Tear down
docker compose -f e2e/docker-compose.test.yml down -v
```

## Running against prod (fulcrum-acme.divinci.ai)

Prod tests authenticate to Cloudflare Access via a **service token** so the
browser never sees the SSO flow. The token pair is two strings:

- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`

Provisioning the token (one-time):

```sh
# Create service token via API
curl -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Fulcrum E2E probe","duration":"forever"}' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/service_tokens"
# Response includes `client_id` and `client_secret` — save them. CF only
# shows the secret ONCE.

# Update the Access App's policy to include the service token
APP_ID=8c9dfd22-595d-4bd1-869b-7dca77d56cf2   # fulcrum-acme.divinci.ai
curl -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Allow E2E service token","decision":"non_identity","include":[{"service_token":{"token_id":"<CLIENT-ID-FROM-ABOVE>"}}]}' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$APP_ID/policies"
```

Then export the pair and run:

```sh
export CF_ACCESS_CLIENT_ID=<client-id>
export CF_ACCESS_CLIENT_SECRET=<client-secret>
bunx playwright test --config=e2e/playwright.config.ts --project=prod
```

CI does this via repo secrets — see `.github/workflows/e2e.yml`.

### Why `.prod.spec.ts` and not the full matrix

Cloudflare Access at the edge **overwrites** the
`Cf-Access-Authenticated-User-Email` header with the service token's policy
email before requests reach the origin. The local matrix fabricates
distinct identities by setting that header per-request (see
`provisionUser` in `_lib/`), which works locally because the test
container trusts the header but **collapses through CF Access** — every
request resolves to the same identity.

The prod project therefore restricts itself to `*.prod.spec.ts` specs
designed for single-user verification: reachability, persistence
round-trips, route registration. Multi-user collab assertions (mention
fan-out to specific recipients, ACL enforcement across grant boundaries,
team membership effects) remain in the local-only matrix.

What the prod set covers today:

| Spec | What regresses if it fails |
|---|---|
| `smoke.prod.spec.ts` | Gateway routing, SPA bundle, `/api/users/me` envelope |
| `api/tasks.prod.spec.ts` | Task POST persists all fields; PATCH writes; GET list includes it |
| `api/projects.prod.spec.ts` | Project POST persists description + notes; GET list |
| `api/d5-reachability.prod.spec.ts` | D-5 migration applied, ACL/teams routes registered |
| `api/ws-substrate.prod.spec.ts` | WS upgrade succeeds through CF, subscribe/ack works |

Want to verify a fresh deploy? `--project=prod` after the recreate.

## What this catches today

| Spec | Regression it prevents |
|---|---|
| `/health 200` | Container boots and Hono serves the health route |
| `/settings renders` | SPA hydrates without backend boot errors (the symptom we'd have caught on the first Mac-arm64 image had we had this test) |
| `google-oauth-status shape` | Phase 1 endpoint stays present + shape stable. Skips on builds that predate Phase 1 — flips to PASS when Phase 1 merges into the deployed image |

## Phase B+C scope (not yet implemented)

- 22 feature specs — one per MCP tool surface (tasks, repos, apps, calendar, gmail, jobs, messaging, memory, search, settings, …)
- Frontend MCP page-context bridge: a WebSocket where the page publishes `{route, selection, visibleEntities}`. ~200 LOC.
- Agent-driven meta-tests: a spec that calls `mcp__plugin_fulcrum_fulcrum__create_task` and asserts both the API and UI agree.
