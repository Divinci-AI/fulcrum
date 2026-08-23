import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, tasks, tags, taskTags, taskLinks } from '../db'
import {
  getTaskTags,
  getTaskLinks,
  getTaskTagsBatch,
  getTaskLinksBatch,
} from './tasks'

/**
 * getTaskTagsBatch / getTaskLinksBatch are second implementations of what
 * getTaskTags / getTaskLinks already do. As with effectiveRolesForTasks, the
 * test is not against expected values written by hand — it is against the
 * per-task helpers themselves, over a fixture holding the shapes that differ:
 * no tags, one tag, several tags, a tag shared between tasks, a join row whose
 * tag was deleted, and tasks with zero / several links.
 *
 * If someone changes one and not the other, this fails.
 */
describe('batched tag/link helpers agree with the per-task helpers', () => {
  let env: TestEnv
  beforeEach(() => { env = setupTestEnv() })
  afterEach(() => { env.cleanup() })

  const now = () => new Date().toISOString()

  const TASK_IDS = ['t-none', 't-one', 't-many', 't-shared', 't-dangling', 't-links']

  function seed() {
    db.insert(tasks).values(
      TASK_IDS.map((id, i) => ({
        id, title: id, status: 'TO_DO', position: i,
        visibility: 'tenant', projectId: null, createdAt: now(), updatedAt: now(),
      })) as never
    ).run()

    db.insert(tags).values([
      { id: 'tag-a', name: 'alpha', color: null, createdAt: now() },
      { id: 'tag-b', name: 'beta', color: null, createdAt: now() },
      { id: 'tag-c', name: 'gamma', color: null, createdAt: now() },
    ] as never).run()

    db.insert(taskTags).values([
      { id: 'j1', taskId: 't-one', tagId: 'tag-a', createdAt: now() },
      { id: 'j2', taskId: 't-many', tagId: 'tag-a', createdAt: now() },
      { id: 'j3', taskId: 't-many', tagId: 'tag-b', createdAt: now() },
      { id: 'j4', taskId: 't-many', tagId: 'tag-c', createdAt: now() },
      { id: 'j5', taskId: 't-shared', tagId: 'tag-b', createdAt: now() },
      // Join row pointing at a tag that no longer exists. getTaskTags drops it
      // (the second query returns nothing); the batch must drop it too, and
      // must not emit `undefined` into the array.
      { id: 'j6', taskId: 't-dangling', tagId: 'tag-deleted', createdAt: now() },
    ] as never).run()

    db.insert(taskLinks).values([
      { id: 'l1', taskId: 't-links', url: 'https://example.com/pr/1', label: 'PR 1', type: 'pr', createdAt: now() },
      { id: 'l2', taskId: 't-links', url: 'https://example.com/pr/2', label: null, type: null, createdAt: now() },
      { id: 'l3', taskId: 't-one', url: 'https://example.com/doc', label: 'doc', type: 'docs', createdAt: now() },
    ] as never).run()
  }

  test('tags: batch matches per-task for every task', () => {
    seed()
    const batch = getTaskTagsBatch(TASK_IDS)
    for (const id of TASK_IDS) {
      expect([...(batch.get(id) ?? [])].sort()).toEqual([...getTaskTags(id)].sort())
    }
  })

  test('links: batch matches per-task for every task', () => {
    seed()
    const batch = getTaskLinksBatch(TASK_IDS)
    for (const id of TASK_IDS) {
      const a = (batch.get(id) ?? []).map((l) => l.id).sort()
      const b = getTaskLinks(id).map((l) => l.id).sort()
      expect(a).toEqual(b)
    }
  })

  test('a join row whose tag was deleted yields no entry, not undefined', () => {
    seed()
    const batch = getTaskTagsBatch(TASK_IDS)
    expect(batch.get('t-dangling') ?? []).toEqual([])
    expect((batch.get('t-dangling') ?? []).includes(undefined as never)).toBe(false)
  })

  test('empty input does not query and returns an empty map', () => {
    seed()
    expect(getTaskTagsBatch([]).size).toBe(0)
    expect(getTaskLinksBatch([]).size).toBe(0)
  })

  test('stitches results correctly across chunk boundaries', () => {
    // 1,200 tasks each with one link and one tag — three chunks at
    // SQLITE_IN_CHUNK=500, so a chunk that is skipped, truncated or
    // overwritten rather than merged shows up as a short map.
    //
    // NOTE: this deliberately does NOT claim to exercise SQLite's bound-
    // parameter ceiling. Setting SQLITE_IN_CHUNK to 100000 and re-running
    // this test still PASSES — bun:sqlite accepts 1,200 parameters in one
    // IN(...) fine (modern SQLite defaults to 32,766, not 999). The chunking
    // is insurance for boards an order of magnitude larger; what is pinned
    // here is that the merge is correct, not that the limit is reached.
    const ids = Array.from({ length: 1200 }, (_, i) => `bulk-${i}`)
    db.insert(tasks).values(
      ids.map((id, i) => ({
        id, title: id, status: 'TO_DO', position: i,
        visibility: 'tenant', projectId: null, createdAt: now(), updatedAt: now(),
      })) as never
    ).run()
    db.insert(tags).values([{ id: 'tag-bulk', name: 'bulk', color: null, createdAt: now() }] as never).run()
    db.insert(taskTags).values(
      ids.map((id, i) => ({ id: `jb-${i}`, taskId: id, tagId: 'tag-bulk', createdAt: now() })) as never
    ).run()
    db.insert(taskLinks).values(
      ids.map((id, i) => ({ id: `lb-${i}`, taskId: id, url: `https://example.com/${i}`, label: null, type: null, createdAt: now() })) as never
    ).run()

    const tagBatch = getTaskTagsBatch(ids)
    const linkBatch = getTaskLinksBatch(ids)
    expect(tagBatch.size).toBe(1200)
    expect(linkBatch.size).toBe(1200)
    expect(tagBatch.get('bulk-1199')).toEqual(['bulk'])
    expect(linkBatch.get('bulk-1199')?.length).toBe(1)
  })
})
