/**
 * Fulcrum OG / link-unfurl Access bypass Worker.
 *
 * Sits in front of a Fulcrum tenant on Cloudflare's edge and lets known
 * link-preview crawlers (Slack, Discord, Facebook/Meta, Twitter,
 * LinkedIn, Telegram, WhatsApp, etc.) reach the OG meta tags + /og/*.png
 * endpoints without solving Cloudflare Access's OAuth challenge.
 *
 * Mechanism: when the request's User-Agent matches a crawler and the
 * path is in the unfurl set, we inject a CF Access service-token header
 * pair and re-fetch the same URL. The tenant's Access app must have a
 * matching service-token "bypass / non-identity" policy so the headered
 * request passes through to origin. All other traffic is forwarded
 * unmodified — Access handles humans normally.
 *
 * Deploy:
 *   cd deploy/saas/workers/og-access-bypass
 *   wrangler secret put CF_ACCESS_CLIENT_ID         # paste the token ID
 *   wrangler secret put CF_ACCESS_CLIENT_SECRET     # paste the secret
 *   wrangler deploy
 *
 * Then in the CF dashboard, configure:
 *   1. Zero Trust → Access controls → Service Credentials → Service
 *      Tokens — create a token (e.g. "fulcrum-og-bypass"). Save the
 *      Client ID + Secret into the wrangler secrets above.
 *   2. Zero Trust → Access controls → Applications → fulcrum-acme
 *      (or per-tenant) → Add policy:
 *        Decision: Service Auth
 *        Include:  Any valid Service Token  (or specifically the
 *                  fulcrum-og-bypass token)
 *      Place this policy first.
 *   3. Workers & Pages → og-access-bypass → Triggers → Routes —
 *      add `fulcrum-acme.divinci.ai/*` (or scope tighter to the unfurl
 *      paths; the Worker also self-gates).
 */

interface Env {
  CF_ACCESS_CLIENT_ID: string
  CF_ACCESS_CLIENT_SECRET: string
}

// User-Agent fragments we treat as link-preview crawlers. Each fragment
// is matched case-insensitively against the incoming `User-Agent` header.
// Adding a new crawler is a one-line change; the bypass remains scoped
// to UNFURL_PATHS so a hostile bot can't roam the whole API.
const CRAWLER_UA_FRAGMENTS: readonly string[] = [
  'slackbot',                  // Slack — Slackbot-LinkExpanding 1.0
  'discordbot',                // Discord
  'facebookexternalhit',       // Facebook / Instagram / WhatsApp
  'whatsapp',                  // WhatsApp Android/iOS
  'twitterbot',                // X / Twitter
  'linkedinbot',               // LinkedIn
  'telegrambot',               // Telegram
  'skypeuripreview',           // Skype / Teams (via Bing)
  'iframely',                  // generic embed service
  'mattermost',                // Mattermost
  'slack-imgproxy',            // Slack's image proxy (og:image fetch)
  'embedly',                   // Embedly (Trello, others)
  'googlebot',                 // Google (search-result rich previews)
  'bingbot',                   // Bing
  'applebot',                  // Apple / iMessage preview service
  'redditbot',                 // Reddit
  'pinterestbot',              // Pinterest
  'snapchat',                  // Snapchat link preview
  'tiktok',                    // TikTok
] as const

// Path prefixes that may produce unfurls. Crawlers requesting anything
// outside this set get the normal Access challenge so the rest of the
// tenant's surface stays gated.
const UNFURL_PATHS: readonly RegExp[] = [
  /^\/og(\/|$)/,
  /^\/tasks(\/|\?|$)/,
  /^\/projects(\/|$)/,
  /^\/repositories(\/|$)/,
  /^\/apps(\/|\?|$)/,
  /^\/$/,                      // root — bare-domain shares get a default card
] as const

function isCrawler(ua: string | null): boolean {
  if (!ua) return false
  const lower = ua.toLowerCase()
  for (const fragment of CRAWLER_UA_FRAGMENTS) {
    if (lower.includes(fragment)) return true
  }
  return false
}

function isUnfurlPath(pathname: string): boolean {
  for (const re of UNFURL_PATHS) {
    if (re.test(pathname)) return true
  }
  return false
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Sanity: missing secrets means the Worker can't help. Fall through
    // so Access still gates the request — better to lose unfurls than
    // to break the tenant.
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      return fetch(request)
    }

    const url = new URL(request.url)
    const ua = request.headers.get('User-Agent')

    if (!isCrawler(ua) || !isUnfurlPath(url.pathname)) {
      return fetch(request)
    }

    // Crawler on an unfurl path. Clone the request, attach the service-
    // token headers, send it back through the edge. The matching service-
    // token policy on the Access app will let it through.
    const headers = new Headers(request.headers)
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID)
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET)

    const bypassed = new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    })

    return fetch(bypassed)
  },
}
