import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { createTestApp } from '../__tests__/fixtures/app'
import { db, tasks, projects, repositories } from '../db'

const TASK_ID = 'dd111111-2222-3333-4444-555555555555'
const PROJECT_ID = 'ee111111-2222-3333-4444-555555555555'
const REPO_ID = 'ff111111-2222-3333-4444-555555555555'

beforeAll(() => {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: PROJECT_ID,
    name: 'OG Route Test Project',
    description: 'Used by og.test.ts',
    status: 'active',
    visibility: 'tenant',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
  db.insert(tasks).values({
    id: TASK_ID,
    title: 'OG route integration task',
    status: 'IN_PROGRESS',
    position: 0,
    priority: 'high',
    description: 'Integration-test task for /og/task endpoint.',
    projectId: PROJECT_ID,
    visibility: 'tenant',
    agent: 'claude',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
  db.insert(repositories).values({
    id: REPO_ID,
    path: '/tmp/og-route-test-repo',
    displayName: 'og-route-test-repo',
    lastBaseBranch: 'main',
    defaultAgent: 'claude',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
})

afterAll(() => {
  db.delete(tasks).where(inArray(tasks.id, [TASK_ID])).run()
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run()
  db.delete(repositories).where(eq(repositories.id, REPO_ID)).run()
})

describe('OG image routes', () => {
  test('GET /og/task/:id.png returns a PNG for a real task', async () => {
    const { get } = createTestApp()
    const res = await get(`/og/task/${TASK_ID}.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('max-age')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.byteLength).toBeGreaterThan(1000)
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(body[0]).toBe(0x89)
    expect(body[1]).toBe(0x50)
    expect(body[2]).toBe(0x4e)
    expect(body[3]).toBe(0x47)
  })

  test('GET /og/task/:id (no .png) also works', async () => {
    const { get } = createTestApp()
    const res = await get(`/og/task/${TASK_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('GET /og/task/:id.png returns fallback PNG for unknown id', async () => {
    const { get } = createTestApp()
    const res = await get('/og/task/00000000-0000-0000-0000-000000000000.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('GET /og/project/:id.png returns a PNG', async () => {
    const { get } = createTestApp()
    const res = await get(`/og/project/${PROJECT_ID}.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('GET /og/repo/:id.png returns a PNG', async () => {
    const { get } = createTestApp()
    const res = await get(`/og/repo/${REPO_ID}.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('GET /og/apps.png returns the apps overview card', async () => {
    const { get } = createTestApp()
    const res = await get('/og/apps.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('GET /og/default.png returns the default card', async () => {
    const { get } = createTestApp()
    const res = await get('/og/default.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })
})

describe('SPA fallback OG meta injection (prod mode)', () => {
  // The SPA fallback that injects OG meta tags only registers when
  // NODE_ENV=production or FULCRUM_PACKAGE_ROOT is set. Set FULCRUM_PACKAGE_ROOT
  // to the repo root so the catch-all reads the built dist/index.html.
  const REPO_ROOT = process.cwd()
  let prevPackageRoot: string | undefined

  beforeAll(() => {
    prevPackageRoot = process.env.FULCRUM_PACKAGE_ROOT
    process.env.FULCRUM_PACKAGE_ROOT = REPO_ROOT
  })

  afterAll(() => {
    if (prevPackageRoot === undefined) delete process.env.FULCRUM_PACKAGE_ROOT
    else process.env.FULCRUM_PACKAGE_ROOT = prevPackageRoot
  })

  test('GET /tasks?task=<id> injects og:image and og:title meta tags', async () => {
    const { get } = createTestApp()
    const res = await get(`/tasks?task=${TASK_ID}`, { host: 'fulcrum-acme.divinci.ai' })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<meta property="og:title"')
    expect(html).toContain('OG route integration task')
    expect(html).toContain(`/og/task/${TASK_ID}.png`)
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"')
  })

  test('GET /tasks/<id> path form also injects meta', async () => {
    const { get } = createTestApp()
    const res = await get(`/tasks/${TASK_ID}`, { host: 'fulcrum-acme.divinci.ai' })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`/og/task/${TASK_ID}.png`)
  })

  test('GET / injects default Fulcrum meta', async () => {
    const { get } = createTestApp()
    const res = await get('/', { host: 'fulcrum-acme.divinci.ai' })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('/og/default.png')
    expect(html).toContain('Harness Attention')
  })
})
