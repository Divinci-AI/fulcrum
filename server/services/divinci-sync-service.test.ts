import { describe, test, expect, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  contentHash,
  fulcrumUrlForEntity,
  collectSyncableEntities,
  _resetDivinciSyncForTesting,
} from './divinci-sync-service'
import { db, tasks, projects, divinciSyncMappings } from '../db'

const baseCfg = {
  baseUrl: 'https://api.divinci.ai',
  apiKey: 'k',
  collectionId: 'col-1',
  publicDomain: 'https://fulcrum-acme.divinci.ai',
}

async function clearTables(): Promise<void> {
  // Order matters — clear children/mappings before parents if there were FKs.
  await db.delete(divinciSyncMappings)
  await db.delete(tasks)
  await db.delete(projects)
}

beforeEach(async () => {
  _resetDivinciSyncForTesting()
  await clearTables()
})

describe('divinci-sync-service.contentHash', () => {
  test('is stable for identical input', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'))
  })

  test('changes when input changes', () => {
    expect(contentHash('hello')).not.toBe(contentHash('hello!'))
  })

  test('produces a 64-char hex string (SHA-256)', () => {
    expect(contentHash('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('divinci-sync-service.fulcrumUrlForEntity', () => {
  test('returns null when no public domain configured', () => {
    expect(fulcrumUrlForEntity(null, 'task', 'abc')).toBeNull()
  })

  test('builds https://<host>/tasks/<id> for tasks', () => {
    expect(fulcrumUrlForEntity('fulcrum-acme.divinci.ai', 'task', 'abc')).toBe(
      'https://fulcrum-acme.divinci.ai/tasks/abc',
    )
  })

  test('builds https://<host>/projects/<id> for projects', () => {
    expect(fulcrumUrlForEntity('fulcrum-acme.divinci.ai', 'project', 'p1')).toBe(
      'https://fulcrum-acme.divinci.ai/projects/p1',
    )
  })

  test('respects a baseUrl that already includes scheme', () => {
    expect(fulcrumUrlForEntity('http://localhost:7777', 'task', 'abc')).toBe(
      'http://localhost:7777/tasks/abc',
    )
  })

  test('strips trailing slashes from the public domain', () => {
    expect(fulcrumUrlForEntity('https://example.com///', 'task', 'abc')).toBe(
      'https://example.com/tasks/abc',
    )
  })
})

describe('divinci-sync-service.collectSyncableEntities', () => {
  test('returns empty when no tasks or projects exist', async () => {
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities).toEqual([])
  })

  test('renders a task body with title, status, and description', async () => {
    await db.insert(tasks).values({
      id: 't1',
      title: 'Ship D-17 PR 2',
      description: 'Sync Fulcrum tasks into Divinci collections.',
      status: 'IN_PROGRESS',
      position: 0,
      agent: 'claude',
      priority: 'high',
      dueDate: '2026-05-30',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities.length).toBe(1)
    const t = entities[0]
    expect(t.entityType).toBe('task')
    expect(t.entityId).toBe('t1')
    expect(t.title).toBe('Fulcrum task: Ship D-17 PR 2')
    expect(t.body).toContain('# Ship D-17 PR 2')
    expect(t.body).toContain('Status: IN_PROGRESS')
    expect(t.body).toContain('Priority: high')
    expect(t.body).toContain('Due: 2026-05-30')
    expect(t.body).toContain('Sync Fulcrum tasks into Divinci collections.')
    expect(t.sourceUrl).toBe('https://fulcrum-acme.divinci.ai/tasks/t1')
  })

  test('skips empty description without producing the "## Description" header', async () => {
    await db.insert(tasks).values({
      id: 't-empty',
      title: 'No body',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities[0].body).not.toContain('## Description')
  })

  test('joins task to project name when project exists', async () => {
    await db.insert(projects).values({
      id: 'p1',
      name: 'Boundless',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await db.insert(tasks).values({
      id: 't-with-project',
      title: 'Task in project',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      projectId: 'p1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    const t = entities.find((e) => e.entityId === 't-with-project')
    expect(t?.body).toContain('Project: Boundless')
  })

  test('produces a project entity with description + notes', async () => {
    await db.insert(projects).values({
      id: 'p2',
      name: 'Founder stack',
      description: 'AI coaching for founders',
      notes: 'Phase 4: pitch deck.',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    const p = entities.find((e) => e.entityType === 'project')
    expect(p).toBeDefined()
    expect(p!.title).toBe('Fulcrum project: Founder stack')
    expect(p!.body).toContain('AI coaching for founders')
    expect(p!.body).toContain('Phase 4: pitch deck.')
    expect(p!.sourceUrl).toBe('https://fulcrum-acme.divinci.ai/projects/p2')
  })

  test('omits sourceUrl when no public domain is configured', async () => {
    await db.insert(tasks).values({
      id: 't-no-url',
      title: 'X',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities({ ...baseCfg, publicDomain: null })
    expect(entities[0].sourceUrl).toBeNull()
  })

  test('shortens descriptions over 500 chars in the file-description field', async () => {
    const longDesc = 'x'.repeat(800)
    await db.insert(tasks).values({
      id: 't-long',
      title: 'Long',
      description: longDesc,
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities[0].description.length).toBeLessThanOrEqual(500)
    expect(entities[0].description.endsWith('…')).toBe(true)
  })
})

describe('divinci-sync-service.collectSyncableEntities content-hash diffing', () => {
  // Sanity check: two unchanged tasks produce identical hashes, but editing
  // the title changes the hash. This is the contract runDivinciSync relies on
  // to skip uploads for unchanged entities.
  test('identical task body yields identical hash; edited task body yields different', async () => {
    await db.insert(tasks).values({
      id: 't',
      title: 'A',
      description: 'd',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const e1 = await collectSyncableEntities(baseCfg)
    const h1 = contentHash(e1[0].body)
    const e2 = await collectSyncableEntities(baseCfg)
    expect(contentHash(e2[0].body)).toBe(h1)
    // Mutate the title
    await db.update(tasks).set({ title: 'B' }).where(eq(tasks.id, 't'))
    const e3 = await collectSyncableEntities(baseCfg)
    expect(contentHash(e3[0].body)).not.toBe(h1)
  })
})
