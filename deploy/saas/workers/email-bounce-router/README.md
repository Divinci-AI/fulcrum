# fulcrum-email-bounce-router

Cloudflare Email Worker that receives inbound bounce/complaint emails on
the Routing-configured domain, parses the RFC 3464 DSN (or RFC 5965 ARF
complaint), and POSTs structured events to Fulcrum's
`/api/email-events` ingest endpoint.

## How it fits

```
recipient MTA → permanent bounce →
  return-path mailbox on bounce-domain (CF Email Routing) →
  this Worker (Email Worker binding) →
  POST { recipient, eventType, ... } → fulcrum-acme.divinci.ai/api/email-events →
  email_send_events table → Members UI bounce badge (D-11 PR 5)
```

## Setup (one-time, per tenant)

### 1. Pick a bounce-handling domain

Either:
- **Same domain as sending** (`invites.divinci.ai`) — CF Email Sending uses TXT records, Email Routing uses MX records. They don't conflict on the same zone, but verify in the dashboard.
- **Separate subdomain** (`bounces.invites.divinci.ai`) — cleaner blast radius. Set `Return-Path` on outgoing messages to land here.

The Worker doesn't care which you pick — it parses any inbound DSN.

### 2. Enable Email Routing on that zone

Cloudflare dashboard → **Email** → **Email Routing** → Get Started. Publish the MX + SPF records when prompted.

### 3. Generate the shared secret

```sh
openssl rand -hex 32
# copy the output
```

Paste into both:
- Fulcrum Settings → Integrations → Cloudflare Email ingest secret (writes to fnox `integrations.cloudflareEmailIngestSecret`)
- This Worker's secret (step 5 below)

### 4. Install wrangler + bun deps

```sh
cd deploy/saas/workers/email-bounce-router
npm install -g wrangler   # if not already installed
```

### 5. Set Worker secrets

```sh
echo -n "https://<tenant>.fulcrum.divinci.ai/api/email-events" | wrangler secret put FULCRUM_INGEST_URL
echo -n "<the-secret-from-step-3>" | wrangler secret put FULCRUM_INGEST_SECRET
```

### 6. Deploy

```sh
wrangler deploy
```

### 7. Bind as the Email Routing destination

Cloudflare dashboard → **Email** → **Email Routing** → **Email Workers** tab → bind `fulcrum-email-bounce-router` as the destination for the **catch-all** rule on the bounce-handling domain.

Once bound, any inbound email — including the DSNs from MTAs that couldn't deliver our outbound — fires this Worker, which parses + POSTs to Fulcrum.

## Local testing

```sh
# Unit-test the parser without wrangler:
bun test src/parse-bounce.test.ts

# Worker runtime test (requires wrangler):
wrangler dev --remote   # uses a CF-hosted dev environment
```

Worker logs in production: dashboard → **Workers & Pages** → `fulcrum-email-bounce-router` → **Logs**. The `observability` block in `wrangler.jsonc` enables sampled head-based tail logging (sampling rate 1.0 = every request) — bump down to 0.1 once volume grows.

## What gets dropped

The Worker parses but **doesn't reject** non-bounce inbound. Real human replies to the from-address fall through to `parseInboundEmail` returning null, the Worker logs `not a bounce; ignoring`, and the email is dropped (Routing's catch-all default for unrouted destinations).

If you want human replies forwarded somewhere instead, change `worker.ts` to `await message.forward('inbox@yourdomain')` in the null-event branch.

## Updating the parser

`parse-bounce.ts` is pure (input: raw string, output: structured event). Add a fixture to `parse-bounce.test.ts` for any new MTA shape you encounter — they all vary slightly in whitespace + header formats.
