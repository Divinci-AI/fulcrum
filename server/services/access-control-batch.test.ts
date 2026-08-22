import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, tasks, projects, acls, teamMembers } from '../db'
import { effectiveRole, effectiveRolesForTasks } from './access-control-service'

/**
 * `effectiveRolesForTasks` is a SECOND implementation of an authorization
 * decision. Two copies of a rule is how the two silently diverge — so this does
 * not test the batch function's output against expected values written by hand.
 * It tests it against `effectiveRole` itself, over a fixture that exercises
 * every visibility/grant/principal combination, for several distinct viewers.
 *
 * If someone changes one and not the other, this fails.
 */
describe('effectiveRolesForTasks agrees with effectiveRole, row for row', () => {
  let env: TestEnv
  beforeEach(() => { env = setupTestEnv() })
  afterEach(() => { env.cleanup() })

  const now = () => new Date().toISOString()

  function seed() {
    db.insert(projects).values([
      { id: 'p-open', name: 'open project', visibility: 'tenant', createdAt: now(), updatedAt: now() },
      { id: 'p-shut', name: 'restricted project', visibility: 'restricted', createdAt: now(), updatedAt: now() },
    ] as never).run()

    const rows: never[] = []
    // Every combination that the decision path distinguishes: task visibility
    // x membership of a project x whether the project itself is restricted.
    for (const [tid, vis, pid] of [
      ['t-tenant-noproj', 'tenant', null],
      ['t-restr-noproj', 'restricted', null],
      ['t-tenant-open', 'tenant', 'p-open'],
      ['t-restr-open', 'restricted', 'p-open'],
      ['t-tenant-shut', 'tenant', 'p-shut'],
      ['t-restr-shut', 'restricted', 'p-shut'],
      // NOTE: a null-visibility task is deliberately NOT in this fixture —
      // tasks.visibility is NOT NULL, so that branch is unreachable for tasks.
      // The batch function still routes null through combineGrantWithVisibility
      // identically to effectiveRole, defensively.
    ] as Array<[string, string | null, string | null]>) {
      rows.push({
        id: tid, title: tid, status: 'TO_DO', position: 0,
        visibility: vis, projectId: pid, createdAt: now(), updatedAt: now(),
      } as never)
    }
    db.insert(tasks).values(rows).run()

    // Grants: one direct-to-user on a task, one on a project (to test the
    // cascade), and one via a TEAM the user belongs to.
    db.insert(teamMembers).values([
      { id: 'tm-1', teamId: 'team-a', userId: 'u-team', role: 'member', joinedAt: now() },
    ] as never).run()
    db.insert(acls).values([
      { id: 'a1', resourceType: 'task', resourceId: 't-restr-noproj', principalType: 'user', principalId: 'u-direct', role: 'editor', grantedAt: now(), grantedBy: 'u-admin' },
      { id: 'a2', resourceType: 'project', resourceId: 'p-shut', principalType: 'user', principalId: 'u-proj', role: 'viewer', grantedAt: now(), grantedBy: 'u-admin' },
      { id: 'a3', resourceType: 'task', resourceId: 't-restr-shut', principalType: 'team', principalId: 'team-a', role: 'admin', grantedAt: now(), grantedBy: 'u-admin' },
    ] as never).run()
  }

  test('every task, every viewer, identical verdicts', () => {
    seed()
    const all = db.select().from(tasks).all() as Array<{ id: string; projectId: string | null; visibility: string | null }>
    expect(all.length).toBe(6)

    for (const viewer of [null, 'u-nobody', 'u-direct', 'u-proj', 'u-team']) {
      const batch = effectiveRolesForTasks(viewer, all)
      for (const row of all) {
        expect(`${viewer}:${row.id}:${batch.get(row.id)}`)
          .toBe(`${viewer}:${row.id}:${effectiveRole(viewer, 'task', row.id)}`)
      }
    }
  })

  test('an empty input does no work and returns an empty map', () => {
    expect(effectiveRolesForTasks('u-direct', []).size).toBe(0)
  })

  test('chunking does not change the answer past the IN(...) chunk size', () => {
    seed()
    const now2 = now()
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: `bulk-${i}`, title: `bulk ${i}`, status: 'TO_DO', position: 0,
      visibility: i % 2 ? 'tenant' : 'restricted', projectId: null,
      createdAt: now2, updatedAt: now2,
    }))
    db.insert(tasks).values(many as never).run()
    const all = db.select().from(tasks).all() as Array<{ id: string; projectId: string | null; visibility: string | null }>
    expect(all.length).toBeGreaterThan(500)
    const batch = effectiveRolesForTasks('u-direct', all)
    for (const row of all) {
      expect(batch.get(row.id)).toBe(effectiveRole('u-direct', 'task', row.id))
    }
  })
})
