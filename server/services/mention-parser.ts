/**
 * Pure `@<email>` mention parser. Lives in its own file (with zero
 * imports from anything that touches the DB) so the unit test can load it
 * without the test-mode FULCRUM_DIR safety guard tripping on module load.
 *
 * Recognized format: `@email@domain.tld` preceded by start-of-string or
 * whitespace. The leading `@` distinguishes "mention" from a bare email
 * appearing as normal address text.
 */

/**
 * Extract every `@email@domain` token from a body of text. Returns unique,
 * lowercased emails.
 */
export function parseMentions(text: string | null | undefined): string[] {
  if (!text) return []
  const pattern = /(?:^|\s)@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
  const found = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    if (match[1]) found.add(match[1].toLowerCase())
  }
  return Array.from(found)
}

/**
 * Extract `@displayName` tokens — `@` followed by a non-email identifier
 * (no `@` inside, no whitespace). Returns the names verbatim (mention-service
 * does the case-insensitive lookup against users.displayName).
 *
 * Tokens that ARE emails are deliberately excluded here — parseMentions()
 * handles those. We use a negative-lookahead-like check by requiring the
 * token to contain no `@`.
 */
export function parseDisplayNameMentions(text: string | null | undefined): string[] {
  if (!text) return []
  // After `@`, accept word chars + dot + dash + underscore. The token ends
  // at whitespace, end-of-string, or a non-allowed character. Tokens that
  // contain an `@` later (i.e. email mentions) are filtered out.
  const pattern = /(?:^|\s)@([A-Za-z0-9._-]+)/g
  const found = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    const token = match[1]
    if (!token) continue
    // Skip the local-part of an email mention. parseMentions handles those.
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1)
    if (after === '@') continue
    // Must contain at least one letter (avoid matching "@1" or "@..." noise)
    if (!/[A-Za-z]/.test(token)) continue
    found.add(token)
  }
  return Array.from(found)
}
