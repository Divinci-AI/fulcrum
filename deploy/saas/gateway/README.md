# Gateway — Cloudflare Zero Trust

> Decision (2026-05-10): **Option A — Cloudflare Zero Trust**. Hono auth proxy
> is no longer on the table. This doc now describes the chosen architecture.

The gateway sits in front of every per-org Fulcrum container and does two
jobs: **authenticate the caller** and **route to the right org**. Fulcrum
itself has no auth middleware, so the gateway is the only thing standing
between the public internet and an org's data.

## Architecture

```
                              ┌── Cloudflare Edge ────────────┐
                              │                               │
  https://acme.fulcrum        │   Access App: acme            │
        .divinci.ai     ───→  │   Policy: in group "org-acme" │
                              │   On allow → tunnel route     │
                              │                               │
                              └─────────────┬─────────────────┘
                                            │ cloudflared tunnel
                                            ▼
                              ┌── GCE host ────────────────────┐
                              │                                │
                              │  cloudflared (one tunnel,      │
                              │   many ingress rules)          │
                              │           │                    │
                              │           ▼                    │
                              │  Docker bridge "fulcrum-gateway"│
                              │           │                    │
                              │     ┌─────┴─────┐              │
                              │     ▼     ▼     ▼              │
                              │  fulcrum- fulcrum- ...         │
                              │  acme    bobsco                │
                              └────────────────────────────────┘
```

## How identity flows

1. User visits `https://acme.fulcrum.divinci.ai`.
2. Cloudflare Access intercepts. The Access App for `acme.fulcrum.divinci.ai`
   has a policy: "Include: members of group `org-acme`".
3. The user authenticates via the configured identity provider (Google SSO is
   the default; we can add Microsoft/SAML/OTP later).
4. On success, Cloudflare proxies the request through the tunnel to the GCE
   host. Cloudflare adds the header
   `Cf-Access-Authenticated-User-Email: alice@acme.com`.
5. `cloudflared` routes by hostname: `acme.fulcrum.divinci.ai` →
   `http://fulcrum-acme:7777`.
6. The Fulcrum container responds. It ignores the identity header today; we
   can read it later for audit logging without changing any data model.

## Why this works for Fulcrum specifically

- Fulcrum was built single-user and assumes "anyone on the listening port is
  authorized." Cloudflare Access enforces the "anyone" boundary at the edge,
  so Fulcrum's assumption stops being a security hole and starts being a
  feature ("trust the gateway").
- The existing `fulcrum expose` CLI already shells out to `cloudflared` for
  the single-host case — same machinery, different tunnel config.
- WebSocket upgrades (`/ws/terminal`) work through Cloudflare tunnels without
  special handling, so the live terminal sessions just work.

## What gets provisioned per org

When `provisioning/org-create.sh acme` runs, it makes these Cloudflare API
calls (in order, with rollback on any failure):

1. **DNS record** — CNAME `acme.fulcrum.divinci.ai → <tunnel-id>.cfargotunnel.com`
2. **Tunnel ingress rule** — append `{hostname: "acme.fulcrum.divinci.ai", service: "http://fulcrum-acme:7777"}` to the tunnel config and reload `cloudflared`
3. **Access Group** — create group `org-acme` (initially empty)
4. **Access Application** — create app for `acme.fulcrum.divinci.ai` with policy `require: group:org-acme`

When `provisioning/org-adduser.sh acme alice@acme.com` runs, it adds
`alice@acme.com` to the `org-acme` Access Group. No Fulcrum API calls — the
Fulcrum container has no concept of Alice and doesn't need one. The next time
Alice visits the URL, Cloudflare's SSO challenge succeeds and she's in.

## Pricing reality check

- Cloudflare Zero Trust: free up to 50 seats org-wide, then $7/seat/month.
- 50 seats = ~50 total users across all orgs (not per-org). Plan to upgrade
  on the 51st invite.

## What this layer doesn't do

- **No row-level isolation inside Fulcrum.** Each org gets its own container
  and its own SQLite — isolation is container-level. If we ever need a single
  Fulcrum process serving multiple orgs, this design has to change
  substantially.
- **No per-user permissions inside an org.** Everyone in `org-acme` sees
  everything in the acme Fulcrum. Splitting an org into sub-permissions would
  require Fulcrum-layer auth, which we're explicitly not building.

## Open implementation questions

These don't block the design; they're choices for build time:

- **Tunnel topology**: one tunnel per host with N ingress rules (simpler), or
  N tunnels (more granular metrics). Start with the first.
- **DNS proxy mode**: orange-cloud (proxied) by default. Lets CF Access
  intercept; non-proxied would skip Access entirely.
- **Session duration**: Access default is 24h. Reasonable for now.
- **MFA**: configurable per Access Application; recommend enabling once we
  have real customer data.
