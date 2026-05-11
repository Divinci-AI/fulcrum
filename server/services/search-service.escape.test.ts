/**
 * Pure-function unit tests for escapeFts5Query. The sibling search-service.test.ts
 * file covers the DB-level integration behavior of search; this file isolates
 * the FTS5 escape helper so the regression guard stays fast (~ms).
 */
import { describe, expect, test } from 'bun:test'
import { escapeFts5Query } from './search-service'

describe('escapeFts5Query', () => {
  test('single plain token becomes a quoted phrase', () => {
    expect(escapeFts5Query('hello')).toBe('"hello"')
  })

  test('multi-token query becomes space-separated quoted phrases', () => {
    expect(escapeFts5Query('hello world')).toBe('"hello" "world"')
  })

  test('dashes in tokens are preserved inside the quoted phrase', () => {
    // The original bug — `-` was being parsed as a column operator and FTS5
    // returned 500 "no such column: with". With phrase quoting, `-` is
    // literal inside the string.
    expect(escapeFts5Query('word-with-dash')).toBe('"word-with-dash"')
  })

  test('embedded double quotes are escaped by doubling (FTS5 convention)', () => {
    expect(escapeFts5Query('say "hi"')).toBe('"say" """hi"""')
  })

  test('asterisk + colon + parens stay literal inside the phrase', () => {
    expect(escapeFts5Query('a*b')).toBe('"a*b"')
    expect(escapeFts5Query('foo:bar')).toBe('"foo:bar"')
    expect(escapeFts5Query('parens(test)')).toBe('"parens(test)"')
  })

  test('whitespace-only query returns an empty phrase (not an error)', () => {
    expect(escapeFts5Query('   ')).toBe('""')
  })

  test('tabs and newlines split as whitespace', () => {
    expect(escapeFts5Query('one\ttwo\nthree')).toBe('"one" "two" "three"')
  })
})
