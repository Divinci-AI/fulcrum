/**
 * Frontend page-context bridge (D-9 PR 7 / Phase C).
 *
 * The browser publishes its current page state — route, selection,
 * visible entities — over WebSocket as the user clicks around. This
 * service caches the latest snapshot per Fulcrum user so that MCP
 * tools and other server-side surfaces can answer "what is the user
 * looking at right now?" without polling the frontend.
 *
 * Storage is in-memory by design:
 *   - State is ephemeral (changes on every click); persisting it would
 *     just churn the DB
 *   - Lost on restart is fine — the browser republishes on reconnect
 *   - Scope is per-userId so multiple tabs from the same user collapse
 *     to the most-recent update
 */

export interface PageContext {
  /** TanStack Router pathname, e.g. "/tasks/abc123". */
  route: string
  /** Optional selection — a single ID for now (last-clicked task,
   * project, app, etc.). The shape is intentionally loose because the
   * frontend decides what "selected" means per page. */
  selection?: { kind: string; id: string } | null
  /** IDs visible on the page, grouped by entity kind. Lets agents
   * answer "what task is mike looking at" without re-fetching. */
  visibleEntities?: {
    tasks?: string[]
    projects?: string[]
    apps?: string[]
    repositories?: string[]
    [kind: string]: string[] | undefined
  }
  /** Free-form bag for page-specific fields. Stored as JSON, returned
   * verbatim — let consumers ignore what they don't care about. */
  metadata?: Record<string, unknown>
  /** Server-set timestamp; the frontend's clock is untrusted. */
  updatedAt: string
}

const cache = new Map<string, PageContext>()

/**
 * Stash `ctx` as the latest snapshot for `userId`. The server stamps
 * `updatedAt` — callers don't need to compute it.
 */
export function setPageContext(
  userId: string,
  ctx: Omit<PageContext, 'updatedAt'>
): PageContext {
  const stored: PageContext = { ...ctx, updatedAt: new Date().toISOString() }
  cache.set(userId, stored)
  return stored
}

/**
 * Return the latest snapshot for `userId`, or null when the user
 * hasn't published one this process lifetime. (After a restart the
 * frontend re-publishes on first navigation, so null is a transient
 * state, not an error.)
 */
export function getPageContext(userId: string): PageContext | null {
  return cache.get(userId) ?? null
}

/**
 * Drop a user's cached context. Used on logout / explicit "forget my
 * context" actions. No-op for unknown users.
 */
export function clearPageContext(userId: string): void {
  cache.delete(userId)
}

/** Test-only helper. */
export function _clearAll(): void {
  cache.clear()
}
