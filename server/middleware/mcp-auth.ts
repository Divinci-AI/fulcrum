/**
 * mcpAuth middleware — access gate for the MCP HTTP transports.
 *
 * The /mcp endpoint exposes the full tool surface (including
 * execute_command / write_file / edit_file), so unlike /api routes it must
 * never be reachable anonymously from off-box. Access is granted when:
 *
 *   1. `currentUser` resolved an identity (Bearer API token or the
 *      CF Access header verified at the SaaS gateway), or
 *   2. the TCP connection is from loopback AND carries no proxy-forwarding
 *      headers. Local agents (Claude Code / OpenCode in task worktrees,
 *      the observer service) talk to http://localhost:<port>/mcp directly,
 *      so they keep working without credentials. A request relayed by a
 *      reverse proxy or Cloudflare Tunnel also arrives from loopback, but
 *      those always add forwarding headers — treat them as remote so a
 *      tunnel without CF Access in front doesn't expose the tool surface.
 *
 * FULCRUM_DEV_USER_EMAIL (handled in currentUser) keeps dev/e2e working.
 */
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { CurrentUserContext } from './current-user'
import { log } from '../lib/logger'

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded']

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export const mcpAuth = createMiddleware<CurrentUserContext>(async (c, next) => {
  if (c.var.user) {
    await next()
    return
  }

  const forwardedVia = FORWARDING_HEADERS.find((h) => c.req.header(h))
  let remoteAddress: string | undefined
  try {
    remoteAddress = getConnInfo(c).remote.address
  } catch {
    // No socket info available — fail closed below.
  }

  if (!forwardedVia && remoteAddress && LOOPBACK_ADDRESSES.has(remoteAddress)) {
    await next()
    return
  }

  log.server.warn('Rejected unauthenticated MCP request', {
    path: c.req.path,
    remoteAddress: remoteAddress ?? 'unknown',
    ...(forwardedVia ? { forwardedVia } : {}),
  })
  throw new HTTPException(401, {
    res: new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  })
})
