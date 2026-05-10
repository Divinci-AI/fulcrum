# Gateway — design notes

> Status: **design only**. Pick one of the two shapes below before building.

The gateway sits in front of every per-tenant Fulcrum container and does two
jobs: **authenticate the caller** and **route to the right tenant**. Fulcrum
itself has no auth middleware (`server/app.ts:59-249`), so the gateway is the
only thing standing between the public internet and a tenant's data.

## Option A — Cloudflare Zero Trust (recommended starting point)

Cloudflare Zero Trust handles auth (SSO via Google / Microsoft / GitHub / etc.)
and routes traffic to the tenant container via Cloudflare Tunnel. Fulcrum's
existing `fulcrum expose` CLI already integrates with Cloudflare Tunnel
(`cli/src/commands/expose.ts`), so this reuses muscle the project already has.

**Wiring:**
1. Each tenant container runs `cloudflared` (or the host shares one) with a
   tunnel entry for `${TENANT_SLUG}.fulcrum.divinci.ai → fulcrum-${TENANT_SLUG}:7777`.
2. A Cloudflare Access policy gates each subdomain to its tenant's identity
   (group/email/SAML claim).
3. Cloudflare injects `Cf-Access-Authenticated-User-Email` header into the
   request. Fulcrum ignores it (no auth code) but can read it later if we
   add audit logging.

**Pros**
- Auth + identity providers + MFA: all free with Zero Trust up to 50 users
- No gateway code to maintain
- Reuses existing `fulcrum expose` infrastructure

**Cons**
- Cloudflare dependency — vendor lock-in for the auth layer
- Per-tenant tunnel rules need to be managed (terraform or CF API)
- Pricing scales after 50 users ($7/user/mo as of last check)

## Option B — Self-hosted Hono auth proxy

A small Hono app (one file, <300 lines) that:
1. Terminates TLS via Caddy/Traefik
2. Validates a session cookie (e.g. issued by an OIDC handshake with
   Google/WorkOS/Auth0)
3. Reads the tenant slug from the subdomain
4. Verifies the authenticated user is a member of that tenant (table lookup)
5. Reverse-proxies the request to `http://fulcrum-${slug}:7777`

**Pros**
- Full control of the auth UX; no vendor pricing tier surprises
- One codebase to operate alongside Fulcrum
- Can do per-request audit logging cheaply

**Cons**
- Auth code is a security surface — needs careful review
- Need to maintain user/tenant membership tables
- Need to handle WebSocket upgrade proxying (Fulcrum's `/ws/terminal`)

## Decision deferred

Both work. Cloudflare gets us further faster at the cost of vendor dependency.
Self-hosted gives us control at the cost of more code. The deciding factors
are:

- Does Divinci-AI already use Cloudflare for auth elsewhere? (If yes → A.)
- Do we expect customers in compliance regimes that disallow CF as a data
  processor? (If yes → B.)
- How many users in year 1? (>100 makes CF Access pricing noticeable.)

Once decided, this README becomes either:
- A "deploy with terraform" runbook (Option A), or
- The home of the Hono proxy source (Option B).
