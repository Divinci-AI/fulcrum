import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { resolveOgMeta, injectOgMeta } from './og-meta'
import { db, tasks, projects, repositories } from '../db'

const TASK_ID = '8cb2c6d0-025d-461c-b0d1-08f2cf170a04'
const XSS_TASK_ID = 'cc111111-2222-3333-4444-555555555555'
const PROJECT_ID = 'aa111111-2222-3333-4444-555555555555'
const REPO_ID = 'bb111111-2222-3333-4444-555555555555'

const baseHeaders = () => new Headers({ host: 'fulcrum-acme.divinci.ai', 'x-forwarded-proto': 'https' })

beforeAll(() => {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: PROJECT_ID,
    name: 'Fulcrum SaaS',
    description: 'Multi-tenant deployment.',
    status: 'active',
    visibility: 'tenant',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
  db.insert(tasks).values({
    id: TASK_ID,
    title: 'Add link unfurling',
    status: 'IN_PROGRESS',
    position: 0,
    priority: 'high',
    description: 'OG meta tags + PNG previews.',
    projectId: PROJECT_ID,
    visibility: 'tenant',
    agent: 'claude',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
  db.insert(repositories).values({
    id: REPO_ID,
    path: '/tmp/test-og-repo',
    displayName: 'test-og-repo',
    lastBaseBranch: 'main',
    defaultAgent: 'claude',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
})

afterAll(() => {
  db.delete(tasks).where(inArray(tasks.id, [TASK_ID, XSS_TASK_ID])).run()
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run()
  db.delete(repositories).where(eq(repositories.id, REPO_ID)).run()
})

describe('resolveOgMeta', () => {
  it('resolves task from /tasks?task=<id>', () => {
    const meta = resolveOgMeta('/tasks', { task: TASK_ID }, baseHeaders())
    expect(meta).not.toBeNull()
    expect(meta!.title).toContain('Add link unfurling')
    expect(meta!.title).toContain('Fulcrum')
    expect(meta!.image).toMatch(new RegExp(`/og/task/${TASK_ID}\\.png\\?v=[a-z0-9]+$`))
    expect(meta!.description).toContain('Fulcrum SaaS')
    expect(meta!.description).toContain('In Progress')
  })

  it('appends cache-busting ?v= hash derived from updatedAt', () => {
    const meta1 = resolveOgMeta('/tasks', { task: TASK_ID }, baseHeaders())!
    const meta2 = resolveOgMeta('/tasks', { task: TASK_ID }, baseHeaders())!
    expect(meta1.image).toBe(meta2.image) // stable
    expect(meta1.image).toMatch(/\?v=[a-z0-9]+$/)
  })

  it('resolves task from /tasks/<id> path', () => {
    const meta = resolveOgMeta(`/tasks/${TASK_ID}`, {}, baseHeaders())
    expect(meta).not.toBeNull()
    expect(meta!.image).toMatch(new RegExp(`/og/task/${TASK_ID}\\.png\\?v=[a-z0-9]+$`))
  })

  it('returns null for unknown task id', () => {
    const meta = resolveOgMeta('/tasks', { task: '00000000-0000-0000-0000-000000000000' }, baseHeaders())
    expect(meta).toBeNull()
  })

  it('rejects non-UUID task param without crashing', () => {
    const meta = resolveOgMeta('/tasks', { task: 'not-a-uuid' }, baseHeaders())
    // Falls through to the default home card, not a task lookup
    expect(meta).not.toBeNull()
    expect(meta!.image).toContain('/og/default.png')
  })

  it('resolves project from /projects/<id>', () => {
    const meta = resolveOgMeta(`/projects/${PROJECT_ID}`, {}, baseHeaders())
    expect(meta).not.toBeNull()
    expect(meta!.title).toContain('Fulcrum SaaS')
    expect(meta!.image).toMatch(new RegExp(`/og/project/${PROJECT_ID}\\.png\\?v=[a-z0-9]+$`))
  })

  it('resolves repository from /repositories/<id>', () => {
    const meta = resolveOgMeta(`/repositories/${REPO_ID}`, {}, baseHeaders())
    expect(meta).not.toBeNull()
    expect(meta!.title).toContain('test-og-repo')
    expect(meta!.description).toContain('main')
    expect(meta!.image).toMatch(new RegExp(`/og/repo/${REPO_ID}\\.png\\?v=[a-z0-9]+$`))
  })

  it('returns apps card for /apps', () => {
    const meta = resolveOgMeta('/apps', {}, baseHeaders())
    expect(meta).not.toBeNull()
    expect(meta!.image).toContain('/og/apps.png')
  })

  it('returns default card for unknown paths', () => {
    const meta = resolveOgMeta('/some-other-page', {}, baseHeaders())
    expect(meta).not.toBeNull()
    expect(meta!.image).toContain('/og/default.png')
  })
})

describe('injectOgMeta', () => {
  const SHELL = `<!doctype html>
<html><head><title>Fulcrum</title></head><body><div id="root"></div></body></html>`

  it('inserts og:* and twitter:* tags after </title>', () => {
    const meta = resolveOgMeta('/tasks', { task: TASK_ID }, baseHeaders())!
    const out = injectOgMeta(SHELL, meta)
    expect(out).toContain('<meta property="og:title"')
    expect(out).toContain('<meta property="og:image" content="https://fulcrum-acme.divinci.ai/og/task/')
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image"')
    expect(out).toContain('Add link unfurling')
    // Title tag should still be present (we don't replace it)
    expect(out).toContain('<title>Fulcrum</title>')
  })

  it('escapes HTML special chars in title and description', () => {
    const now = new Date().toISOString()
    db.insert(tasks).values({
      id: XSS_TASK_ID,
      title: 'Title with <script>alert(1)</script> & "quotes"',
      status: 'TO_DO',
      position: 0,
      visibility: 'tenant',
      agent: 'claude',
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run()
    const meta = resolveOgMeta('/tasks', { task: XSS_TASK_ID }, baseHeaders())!
    const out = injectOgMeta(SHELL, meta)
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&amp;')
    expect(out).toContain('&quot;')
  })
})
