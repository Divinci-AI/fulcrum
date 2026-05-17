/**
 * currentUser middleware — derives the request's user identity from the
 * Cloudflare Access header set at the SaaS gateway.
 *
 * Trust model:
 *   - CF Access at the edge verifies the user's identity and sets
 *     `Cf-Access-Authenticated-User-Email`. We trust that header iff the
 *     deployment is behind CF Access (see deploy/saas/gateway/README.md).
 *   - For local dev + e2e (no CF Access in front), the header is absent.
 *     Fall back to `FULCRUM_DEV_USER_EMAIL` env var if set, so dev
 *     iteration and the e2e suite have a sensible default identity. If
 *     neither header nor env is present, `c.var.user` is `null` and
 *     routes choose to enforce or not.
 *
 * The middleware does NOT 401 on its own — it only attaches the user (or
 * null) to the request context. Routes that require auth can call the
 * `requireUser(c)` helper exported here.
 */
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ensureUserByEmail } from '../services/user-service'
import type { User } from '../db'

const CF_ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email'

export interface CurrentUserContext {
  Variables: {
    user: User | null
  }
}

export const currentUser = createMiddleware<CurrentUserContext>(async (c, next) => {
  const headerEmail = c.req.header(CF_ACCESS_EMAIL_HEADER)
  const fallback = process.env.FULCRUM_DEV_USER_EMAIL
  const email = headerEmail ?? fallback ?? null

  if (email && email.trim() !== '') {
    try {
      const user = ensureUserByEmail(email)
      c.set('user', user)
    } catch {
      // Don't take the whole request down if the upsert blows up (e.g. DB
      // mid-migration). Treat as anonymous; the route can decide.
      c.set('user', null)
    }
  } else {
    c.set('user', null)
  }
  await next()
})

/**
 * Throw a 401 when the route requires an authenticated user. Routes that
 * need auth should call this at the top of their handler.
 *
 * Implementation note: we throw `HTTPException` (Hono's first-class error
 * type) rather than a bare `Response`. Bare-Response throws aren't caught
 * by Hono's default machinery and bubble up to Bun as 500s; HTTPException
 * is rendered into the configured response automatically.
 */
export function requireUser(c: Context<CurrentUserContext>): User {
  const user = c.var.user
  if (!user) {
    throw new HTTPException(401, {
      res: new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    })
  }
  return user
}

/**
 * D-7 PR 2: throw a 403 when the route requires a tenant admin.
 *
 * Builds on `requireUser` for the auth half — 401 still wins if there's no
 * identity at all, then 403 when the identity exists but isn't an admin.
 * The first user of a tenant is automatically promoted by migration 0082;
 * subsequent admins are granted via PATCH /api/users/:id/admin.
 */
export function requireAdminUser(c: Context<CurrentUserContext>): User {
  const user = requireUser(c)
  if (!user.isAdmin) {
    throw new HTTPException(403, {
      res: new Response(JSON.stringify({ error: 'Tenant admin required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    })
  }
  return user
}
