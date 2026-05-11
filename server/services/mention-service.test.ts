import { describe, expect, test } from 'bun:test'
// Import from the pure-function module so this test doesn't drag in the
// DB-touching imports of mention-service.ts (which would trip the test-mode
// FULCRUM_DIR guard on module load).
import { parseMentions, parseDisplayNameMentions } from './mention-parser'

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

describe('parseDisplayNameMentions', () => {
  test('extracts a single @name mention at start of string', () => {
    expect(parseDisplayNameMentions('@alice please review')).toEqual(['alice'])
  })

  test('extracts a name preceded by whitespace', () => {
    expect(parseDisplayNameMentions('hey @bob can you look')).toEqual(['bob'])
  })

  test('does NOT extract @email — that is the email parser\'s job', () => {
    // The "@bob" prefix here is followed by "@", which signals an email mention.
    // parseDisplayNameMentions must skip it so we don't double-mention.
    expect(parseDisplayNameMentions('cc @bob@example.com please')).toEqual([])
  })

  test('extracts multiple distinct names and dedupes', () => {
    expect(parseDisplayNameMentions('@alice and @bob and @alice again')).toEqual([
      'alice',
      'bob',
    ])
  })

  test('null / empty input returns empty array', () => {
    expect(parseDisplayNameMentions(null)).toEqual([])
    expect(parseDisplayNameMentions(undefined)).toEqual([])
    expect(parseDisplayNameMentions('')).toEqual([])
  })

  test('skips tokens with no letters (e.g. @123 or @...)', () => {
    expect(parseDisplayNameMentions('see @123 and @...')).toEqual([])
  })

  test('handles tab + newline as preceding whitespace', () => {
    expect(parseDisplayNameMentions('hello\n@carol')).toEqual(['carol'])
    expect(parseDisplayNameMentions('\t@dave')).toEqual(['dave'])
  })

  test('does NOT match @-anchored inside a word like "email@bob"', () => {
    // The leading-`@` rule is preceded-by-start-or-whitespace, so an `@`
    // mid-word does NOT trigger a mention. Avoids the "info@example" false
    // positive when prose includes addresses inline.
    expect(parseDisplayNameMentions('info@bob is the contact')).toEqual([])
  })
})
