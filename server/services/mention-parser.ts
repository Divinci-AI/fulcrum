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
