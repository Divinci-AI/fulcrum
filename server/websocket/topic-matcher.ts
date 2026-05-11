/**
 * Pure topic-matching helper for the D-4 WebSocket subscription model.
 *
 * Topic grammar (see deploy/saas/D4-realtime-design.md for the full spec):
 *
 *   - `*`               wildcard, matches every event
 *   - `task:*`          every task event
 *   - `task:<id>`       events for one task
 *   - `project:*`       every project event
 *   - `project:<id>`    events for one project
 *   - `me`              special; matched per-user in the broadcast call site
 *                       (this helper doesn't know about users)
 *
 * Lives in its own file with zero imports so unit tests can load it
 * without touching the DB-mediated test-isolation path.
 */

/**
 * Returns true if a subscription string `sub` matches an event `topic`.
 * Both arguments are case-sensitive. `me` is *not* matched here — the
 * `me` route lives in the broadcast call site which knows the recipient
 * user, not this pure function.
 */
export function topicMatches(sub: string, topic: string): boolean {
  if (sub === '*') return true
  if (sub === topic) return true
  // Prefix wildcard: 'task:*' matches 'task:<anything>'.
  // We intentionally support exactly one trailing `*` — full glob
  // semantics aren't worth the complexity at the current grammar size.
  if (sub.endsWith(':*')) {
    const prefix = sub.slice(0, -1) // 'task:*' → 'task:'
    return topic.startsWith(prefix)
  }
  return false
}

/**
 * Returns true if ANY subscription in the set matches the event topic.
 * Used to filter the connected-clients list during a broadcast.
 */
export function anyTopicMatches(subs: ReadonlySet<string>, topic: string): boolean {
  for (const s of subs) {
    if (topicMatches(s, topic)) return true
  }
  return false
}
