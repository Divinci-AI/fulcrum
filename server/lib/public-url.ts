import type { Context } from 'hono'
import { getSettings } from './settings/core'

/**
 * Derive the public-facing base URL for this tenant (no trailing slash).
 *
 * Used by anything that embeds a URL in outbound content the recipient
 * will click — invite emails, notifications, etc. `c.req.url` is a trap
 * here: when the server runs behind cloudflared (the SaaS deploy), it
 * reflects the loopback socket the tunnel forwards to (`127.0.0.1:7777`
 * or `localhost:7777`), not the hostname the user typed.
 *
 * Precedence:
 *   1. `settings.server.publicDomain` — operator-configured, always
 *      preferred. Bound via `FULCRUM_SERVER_PUBLIC_DOMAIN` in the
 *      compose templates.
 *   2. `X-Forwarded-Host` + `X-Forwarded-Proto` headers — set by most
 *      reverse proxies. We don't sniff `CF-Visitor` because cloudflared
 *      doesn't forward `X-Forwarded-Host` automatically; this branch is
 *      mostly for non-CF reverse proxies.
 *   3. `c.req.url` — last resort, correct for local dev only.
 */
export function getPublicBaseUrl(c: Context): string {
  const settings = getSettings()
  const publicDomain = settings.server.publicDomain
  if (publicDomain) {
    return `https://${publicDomain}`
  }

  const fwdHost = c.req.header('x-forwarded-host')
  if (fwdHost) {
    const fwdProto = c.req.header('x-forwarded-proto') ?? 'https'
    return `${fwdProto}://${fwdHost}`
  }

  const u = new URL(c.req.url)
  return `${u.protocol}//${u.host}`
}
