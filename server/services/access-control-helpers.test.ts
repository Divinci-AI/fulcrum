import { describe, expect, test } from 'bun:test'
import {
  TENANT_DEFAULT_ROLE,
  combineGrantWithVisibility,
  maxRole,
  roleSatisfies,
} from './access-control-helpers'

describe('maxRole', () => {
  test('returns null for empty input so caller can fall back', () => {
    expect(maxRole([])).toBeNull()
  })

  test('picks the strongest of multiple roles', () => {
    expect(maxRole(['viewer', 'editor'])).toBe('editor')
    expect(maxRole(['viewer', 'admin', 'editor'])).toBe('admin')
    expect(maxRole(['viewer', 'viewer'])).toBe('viewer')
  })

  test('a single role returns itself', () => {
    expect(maxRole(['admin'])).toBe('admin')
  })
})

describe('roleSatisfies', () => {
  test('null never satisfies anything', () => {
    expect(roleSatisfies(null, 'viewer')).toBe(false)
    expect(roleSatisfies(null, 'editor')).toBe(false)
    expect(roleSatisfies(null, 'admin')).toBe(false)
  })

  test('equal role satisfies the requirement', () => {
    expect(roleSatisfies('editor', 'editor')).toBe(true)
    expect(roleSatisfies('admin', 'admin')).toBe(true)
  })

  test('stronger role satisfies a weaker requirement', () => {
    expect(roleSatisfies('admin', 'editor')).toBe(true)
    expect(roleSatisfies('admin', 'viewer')).toBe(true)
    expect(roleSatisfies('editor', 'viewer')).toBe(true)
  })

  test('weaker role does NOT satisfy a stronger requirement', () => {
    expect(roleSatisfies('viewer', 'editor')).toBe(false)
    expect(roleSatisfies('viewer', 'admin')).toBe(false)
    expect(roleSatisfies('editor', 'admin')).toBe(false)
  })
})

describe('combineGrantWithVisibility', () => {
  test('tenant-visible + no grant → tenant default role (editor)', () => {
    expect(combineGrantWithVisibility('tenant', null)).toBe(TENANT_DEFAULT_ROLE)
    expect(combineGrantWithVisibility('tenant', null)).toBe('editor')
  })

  test('tenant-visible + viewer grant → still defaults to editor (no demotion)', () => {
    // The tenant default is itself editor — a viewer grant doesn't reduce
    // access below the default. Otherwise granting someone "viewer" on a
    // tenant-visible resource would secretly downgrade them.
    expect(combineGrantWithVisibility('tenant', 'viewer')).toBe('editor')
  })

  test('tenant-visible + admin grant → admin (elevation)', () => {
    expect(combineGrantWithVisibility('tenant', 'admin')).toBe('admin')
  })

  test('restricted + no grant → null (no access)', () => {
    expect(combineGrantWithVisibility('restricted', null)).toBeNull()
  })

  test('restricted + viewer grant → viewer (grant IS the access)', () => {
    expect(combineGrantWithVisibility('restricted', 'viewer')).toBe('viewer')
  })

  test('restricted + admin grant → admin', () => {
    expect(combineGrantWithVisibility('restricted', 'admin')).toBe('admin')
  })

  test('restricted + editor grant → editor (no implicit promotion)', () => {
    // Symmetric with the no-demotion rule: in restricted mode, the grant
    // is the *whole* access story.
    expect(combineGrantWithVisibility('restricted', 'editor')).toBe('editor')
  })
})
