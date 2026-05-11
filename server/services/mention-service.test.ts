import { describe, expect, test } from 'bun:test'
// Import from the pure-function module so this test doesn't drag in the
// DB-touching imports of mention-service.ts (which would trip the test-mode
// FULCRUM_DIR guard on module load).
import { parseMentions } from './mention-parser'

describe('parseMentions', () => {
  test('extracts a single @email mention at start of string', () => {
    expect(parseMentions('@mike@divinci.ai please review')).toEqual(['mike@divinci.ai'])
  })

  test('extracts a mention preceded by whitespace', () => {
    expect(parseMentions('hi @bob@example.com, see this')).toEqual(['bob@example.com'])
  })

  test('does NOT match a bare email in prose (no leading @)', () => {
    // The whole point of the leading @: "I emailed bob@x.com" must NOT be a
    // mention. Otherwise every email address in a note triggers a notification.
    expect(parseMentions('I emailed bob@example.com about it')).toEqual([])
  })

  test('extracts multiple distinct mentions, dedupes, lowercases', () => {
    expect(
      parseMentions('@Alice@x.com and @bob@y.com and again @alice@x.com')
    ).toEqual(['alice@x.com', 'bob@y.com'])
  })

  test('handles tab + newline as preceding whitespace', () => {
    expect(parseMentions('hello\n@carol@z.com')).toEqual(['carol@z.com'])
    expect(parseMentions('\t@dave@z.com')).toEqual(['dave@z.com'])
  })

  test('null / empty input returns empty array', () => {
    expect(parseMentions(null)).toEqual([])
    expect(parseMentions(undefined)).toEqual([])
    expect(parseMentions('')).toEqual([])
  })

  test('mention pattern requires a TLD with at least 2 letters', () => {
    expect(parseMentions('@x@a.b')).toEqual([])     // 1-letter TLD rejected
    expect(parseMentions('@x@a.co')).toEqual(['x@a.co']) // 2-letter TLD accepted
  })
})
