/**
 * Shared `@mention` UI helpers.
 *
 * - findMentionTrigger / filterMentionUsers power the @-autocomplete popover
 *   (used by DescriptionTextarea for tasks/projects and TeamChat for chat).
 * - MentionText renders a message body with `@email` / `@name` tokens
 *   highlighted.
 *
 * The canonical mention format the server parses is `@<email>` (see
 * server/services/mention-parser.ts); `@displayName` also resolves when
 * unambiguous, so both render highlighted here.
 */

export interface MentionableUser {
  email: string
  displayName: string | null
}

/** Find an active @-mention trigger ending at `cursor`. Returns the
 * trigger's `@` index and the query string (the chars after `@`), or null
 * if there's no active trigger. */
export function findMentionTrigger(
  text: string,
  cursor: number
): { at: number; query: string } | null {
  if (cursor === 0) return null
  // Walk back from cursor to find a `@` preceded by start-of-string or whitespace.
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      // Boundary check: char before must be undefined or whitespace.
      const prev = i > 0 ? text[i - 1] : ''
      if (prev === '' || /\s/.test(prev)) {
        const query = text.slice(i + 1, cursor)
        // Query terminates at any whitespace — if we encounter one in
        // the slice, this trigger is no longer active.
        if (/\s/.test(query)) return null
        return { at: i, query }
      }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

export function filterMentionUsers<T extends MentionableUser>(users: T[], query: string): T[] {
  if (!query) return users.slice(0, 8)
  const q = query.toLowerCase()
  return users
    .filter(
      (u) => u.email.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q)
    )
    .slice(0, 8)
}

// Matches `@email@domain.tld` or `@name` tokens at start-of-string or after
// whitespace — mirrors the server-side parser's boundaries.
const MENTION_TOKEN =
  /(^|\s)(@(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*))/g

/** Render `text` with mention tokens highlighted. Plain text otherwise —
 * no markdown processing, safe for chat bodies. */
export function MentionText({ text, className }: { text: string; className?: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const start = (match.index ?? 0) + match[1].length
    if (start > last) parts.push(text.slice(last, start))
    parts.push(
      <span key={key++} className="text-accent font-medium">
        {match[2]}
      </span>
    )
    last = start + match[2].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <span className={className}>{parts}</span>
}
