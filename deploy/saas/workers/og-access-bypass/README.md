# fulcrum-og-access-bypass

Cloudflare Worker that lets link-preview crawlers (Slack, Discord, Facebook, Twitter, LinkedIn, Telegram, WhatsApp, Apple/iMessage, Google, etc.) reach Fulcrum's Open Graph meta tags + `/og/*.png` PNG endpoints **without solving Cloudflare Access's OAuth challenge**, while keeping every other request gated as usual.

## Why this exists

`fulcrum-<tenant>.divinci.ai` sits behind a Cloudflare Access policy that requires email-based authentication. Crawlers like `Slackbot-LinkExpanding` cannot solve an OAuth flow, so they hit a `302 → /cdn-cgi/access/login/...` and bail, and Slack/Discord/etc. show no unfurl at all.

Cloudflare Access policies do **not** support User-Agent matching as a native selector. The standard pattern for unfurl support is therefore: a Worker on the zone that intercepts requests at the edge, detects crawler UAs on unfurl-eligible paths, and injects a service-token header pair that satisfies a `Service Auth` bypass policy on the Access app.

## Mechanism

```
crawler ─▶ CF edge ─▶ this Worker
                       │
                       ├─ crawler UA + unfurl path?
                       │     ├─ yes ─▶ add CF-Access-Client-{Id,Secret}
                       │     │           ▼
                       │     │      Access app sees service-token policy
                       │     │      match ─▶ pass through to origin
                       │     │           ▼
                       │     │      Fulcrum container returns SPA HTML
                       │     │      with og:* meta tags / or PNG
                       │     │
                       │     └─ no ─▶ pass through unmodified ─▶ Access
                       │                  challenges the human as usual
```

The list of recognized crawler UAs lives in `src/worker.ts` as `CRAWLER_UA_FRAGMENTS`. The unfurl path set lives in the same file as `UNFURL_PATHS`. Both are intentionally narrow — bypass is scoped to where it's needed.

## One-time setup per tenant

1. **Create a service token.** Cloudflare Zero Trust dashboard:
   `Access controls → Service Credentials → Service Tokens → Create Service Token`.
   Name: `fulcrum-og-bypass`. Duration: pick one (we use 1 year as the default rotation cadence). Save the **Client ID** and **Client Secret** — the secret is shown exactly once.

2. **Wrangler secrets.** From this directory:

   ```bash
   wrangler secret put CF_ACCESS_CLIENT_ID       # paste the Client ID
   wrangler secret put CF_ACCESS_CLIENT_SECRET   # paste the Client Secret
   ```

3. **Deploy the Worker.**

   ```bash
   wrangler deploy
   ```

   This binds the Worker to the routes declared in `wrangler.jsonc` (currently `fulcrum-acme.divinci.ai/*`). When onboarding a new tenant, add another route entry like
   `{ "pattern": "fulcrum-<slug>.divinci.ai/*", "zone_name": "divinci.ai" }`.

4. **Access policy on the tenant app.** Cloudflare Zero Trust dashboard:
   `Access controls → Applications → fulcrum-<tenant>.divinci.ai → Policies → Add a policy`.
    - **Action**: `Service Auth`
    - **Include**: `Service Token → fulcrum-og-bypass`
    - Place this policy **first** in the list so it evaluates before the email-based allow policies.

5. **Verify** with a curl impersonating Slackbot. No service-token headers — the Worker should add them transparently at the edge:

   ```bash
   curl -sS -I -A "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" \
     'https://fulcrum-acme.divinci.ai/og/task/<id>.png'
   # → HTTP/2 200, content-type: image/png
   ```

   And paste a real task URL into a Slack channel to confirm the unfurl renders.

## Rotation

The service token's duration is set on creation. To rotate:

1. Create a new token in the dashboard (same screen as step 1 above).
2. `wrangler secret put CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` with the new values.
3. `wrangler deploy` — Worker picks up the new secrets on the next request.
4. Delete the old token from the dashboard.

Rotation is fully zero-downtime as long as the new token is added to the Access bypass policy before the old one is removed. (If you only have one policy referencing "any valid service token" instead of a specific one, no policy edit is needed.)

## Why not WAF Custom Rules with Skip Cloudflare Access?

Tried it. The `Skip` action on WAF Custom Rules can skip rate limiting, managed rules, Bot Fight Mode, Zone Lockdown, User Agent Blocking, etc. — but **not** Cloudflare Access. Access runs in its own phase that WAF Custom Rules don't reach. (Verified in the dashboard UI: the "WAF components to skip" list has no Access option.) Service Auth via Worker is the supported path.
