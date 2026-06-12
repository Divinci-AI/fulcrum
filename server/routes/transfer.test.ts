import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, tasks, projects } from '../db'
import { eq } from 'drizzle-orm'

describe('Transfer Routes', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
  })
  afterEach(() => env.cleanup())

  test('export → import roundtrip remaps ids and preserves structure', async () => {
    const { get, post } = createTestApp()
    const now = new Date().toISOString()

    // Seed: a project with one task that has tags, a link, and a dependency.
    db.insert(projects)
      .values({ id: 'proj-1', name: 'Transfer Me', status: 'active', createdAt: now, updatedAt: now })
      .run()
    db.insert(tasks)
      .values([
        {
          id: 'task-a',
          title: 'Task A',
          status: 'TO_DO',
          position: 0,
          projectId: 'proj-1',
          worktreePath: '/tmp/some/local/path',
          repoPath: '/tmp/repo',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'task-b',
          title: 'Task B',
          status: 'IN_PROGRESS',
          position: 1,
          projectId: 'proj-1',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
    await post('/api/tasks/task-a/tags', undefined).catch(() => {})

    const exportRes = await get('/api/transfer/export')
    const bundle = await exportRes.json()
    expect(exportRes.status).toBe(200)
    expect(bundle.version).toBe(1)
    expect(bundle.projects.length).toBe(1)
    expect(bundle.tasks.length).toBe(2)

    // Import the same bundle back (simulating a second instance).
    const importRes = await post('/api/transfer/import', bundle)
    const result = await importRes.json()
    expect(importRes.status).toBe(200)
    expect(result.imported.projects).toBe(1)
    expect(result.imported.tasks).toBe(2)

    // Originals untouched; copies have new ids and no execution-plane state.
    const allTasks = db.select().from(tasks).all()
    expect(allTasks.length).toBe(4)
    const imported = allTasks.filter((t) => t.id !== 'task-a' && t.id !== 'task-b')
    expect(imported.every((t) => t.worktreePath === null && t.repoPath === null)).toBe(true)
    const importedA = imported.find((t) => t.title === 'Task A')
    expect(importedA?.projectId).not.toBe('proj-1')
    const importedProject = db.select().from(projects).where(eq(projects.id, importedA!.projectId!)).get()
    expect(importedProject?.name).toBe('Transfer Me')
  })

  test('import rejects unrecognized bundles', async () => {
    const { post } = createTestApp()
    expect((await post('/api/transfer/import', { version: 99 })).status).toBe(400)
  })
})
