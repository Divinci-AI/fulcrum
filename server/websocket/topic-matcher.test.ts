import { describe, expect, test } from 'bun:test'
import { anyTopicMatches, topicMatches } from './topic-matcher'

describe('topicMatches', () => {
  test('`*` matches anything', () => {
    expect(topicMatches('*', 'task:foo')).toBe(true)
    expect(topicMatches('*', 'project:bar')).toBe(true)
    expect(topicMatches('*', 'literally-anything')).toBe(true)
  })

  test('exact-string match', () => {
    expect(topicMatches('task:foo', 'task:foo')).toBe(true)
    expect(topicMatches('task:foo', 'task:bar')).toBe(false)
    expect(topicMatches('project:xyz', 'project:xyz')).toBe(true)
  })

  test('trailing `:*` matches the same prefix', () => {
    expect(topicMatches('task:*', 'task:foo')).toBe(true)
    expect(topicMatches('task:*', 'task:bar')).toBe(true)
    expect(topicMatches('project:*', 'project:any')).toBe(true)
  })

  test('trailing `:*` does NOT cross prefixes', () => {
    expect(topicMatches('task:*', 'project:foo')).toBe(false)
    expect(topicMatches('project:*', 'task:foo')).toBe(false)
  })

  test('`me` is opaque — does not match plain event topics', () => {
    // The `me` subscription is matched by the broadcast call site (which
    // knows the recipient user identity), not by this pure helper.
    expect(topicMatches('me', 'task:foo')).toBe(false)
    expect(topicMatches('me', 'project:foo')).toBe(false)
    expect(topicMatches('me', 'me')).toBe(true) // still trivially equal
  })

  test('no implicit globbing in the middle of a string', () => {
    expect(topicMatches('task:*:nested', 'task:foo:nested')).toBe(false)
    expect(topicMatches('*foo', 'foobar')).toBe(false)
  })
})

describe('anyTopicMatches', () => {
  test('empty subscription set never matches', () => {
    expect(anyTopicMatches(new Set(), 'task:foo')).toBe(false)
  })

  test('returns true if any one subscription matches', () => {
    const subs = new Set(['task:*', 'project:specific'])
    expect(anyTopicMatches(subs, 'task:foo')).toBe(true)
    expect(anyTopicMatches(subs, 'project:specific')).toBe(true)
    expect(anyTopicMatches(subs, 'project:other')).toBe(false)
  })

  test('wildcard `*` in the set matches everything', () => {
    const subs = new Set(['*'])
    expect(anyTopicMatches(subs, 'task:foo')).toBe(true)
    expect(anyTopicMatches(subs, 'project:bar')).toBe(true)
  })
})
