import { describe, test, expect, beforeEach } from 'bun:test'
import {
  setPageContext,
  getPageContext,
  clearPageContext,
  _clearAll,
} from './page-context-service'

describe('page-context-service', () => {
  beforeEach(() => {
    _clearAll()
  })

  test('round-trips a context for a user; stamps updatedAt', () => {
    const stored = setPageContext('user-1', {
      route: '/tasks/abc',
      selection: { kind: 'task', id: 'abc' },
      visibleEntities: { tasks: ['abc', 'def'] },
    })
    expect(stored.updatedAt).toBeTruthy()
    const got = getPageContext('user-1')
    expect(got).not.toBeNull()
    expect(got?.route).toBe('/tasks/abc')
    expect(got?.selection).toEqual({ kind: 'task', id: 'abc' })
    expect(got?.visibleEntities?.tasks).toEqual(['abc', 'def'])
  })

  test('overwrites the cached entry on subsequent updates', () => {
    setPageContext('user-1', { route: '/tasks' })
    setPageContext('user-1', { route: '/projects' })
    expect(getPageContext('user-1')?.route).toBe('/projects')
  })

  test('scopes per userId', () => {
    setPageContext('alice', { route: '/tasks' })
    setPageContext('bob', { route: '/projects' })
    expect(getPageContext('alice')?.route).toBe('/tasks')
    expect(getPageContext('bob')?.route).toBe('/projects')
  })

  test('returns null when no context has been set', () => {
    expect(getPageContext('never-seen')).toBeNull()
  })

  test('clearPageContext drops the entry', () => {
    setPageContext('user-1', { route: '/x' })
    clearPageContext('user-1')
    expect(getPageContext('user-1')).toBeNull()
  })

  test('metadata is passed through verbatim', () => {
    setPageContext('user-1', {
      route: '/monitoring',
      metadata: { activeTab: 'observers', custom: { nested: true } },
    })
    const got = getPageContext('user-1')
    expect(got?.metadata).toEqual({
      activeTab: 'observers',
      custom: { nested: true },
    })
  })
})
