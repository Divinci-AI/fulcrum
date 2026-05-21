import { Hono } from 'hono'
import { eq, count } from 'drizzle-orm'
import { db, tasks, projects, repositories, users } from '../db'
import {
  renderTaskOg,
  renderProjectOg,
  renderRepoOg,
  renderGenericOg,
  renderCached,
} from '../services/og-image-service'
import { log } from '../lib/logger'

const app = new Hono()

// Crash-proof error logger. Hit by route catch blocks where a thrown error
// from logging would mask the underlying failure (as happened in the D-15
// deploy when `log.error` didn't exist).
function logOgError(msg: string, ctx: Record<string, unknown>): void {
  try {
    log.og.error(msg, ctx)
  } catch {
    try {
      console.error(JSON.stringify({ src: 'OG', msg, ctx }))
    } catch {
      // Nothing else to do.
    }
  }
}

// PNG responses are cached server-side for 5min and client-side for 1h.
// Crawlers re-fetch periodically so a moderately long client cache is fine —
// stale unfurls just refresh on the next crawl cycle.
const PNG_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
} as const

function hostFromReq(c: { req: { header: (name: string) => string | undefined } }): string {
  const host = c.req.header('host') ?? 'fulcrum'
  return host
}

function pngResponse(png: Uint8Array): Response {
  // satori/resvg returns a Uint8Array view; copy to a plain ArrayBuffer so
  // Response's BodyInit is unambiguous for older Bun versions.
  const buf = new ArrayBuffer(png.byteLength)
  new Uint8Array(buf).set(png)
  return new Response(buf, { headers: PNG_HEADERS })
}

app.get('/task/:id', async (c) => {
  const id = c.req.param('id').replace(/\.png$/, '')
  try {
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!task) {
      const png = await renderCached('fallback:task-not-found', () =>
        renderGenericOg({
          title: 'Task not found',
          subtitle: 'This task may have been deleted or moved.',
          badge: 'Task',
          host: hostFromReq(c),
        })
      )
      return pngResponse(png)
    }

    const project = task.projectId
      ? db.select().from(projects).where(eq(projects.id, task.projectId)).get()
      : null
    const assignee = task.assigneeUserId
      ? db.select().from(users).where(eq(users.id, task.assigneeUserId)).get()
      : null
    const assigneeName = assignee?.displayName || assignee?.email?.split('@')[0] || null

    const cacheKey = `task:${id}:${task.updatedAt}`
    const png = await renderCached(cacheKey, () =>
      renderTaskOg({
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate,
        description: task.description,
        projectName: project?.name ?? null,
        assigneeName,
        host: hostFromReq(c),
      })
    )
    return pngResponse(png)
  } catch (err) {
    logOgError('OG task render failed', { id, err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
    return c.text('OG render failed', 500)
  }
})

app.get('/project/:id', async (c) => {
  const id = c.req.param('id').replace(/\.png$/, '')
  try {
    const project = db.select().from(projects).where(eq(projects.id, id)).get()
    if (!project) {
      const png = await renderCached('fallback:project-not-found', () =>
        renderGenericOg({
          title: 'Project not found',
          subtitle: 'This project may have been deleted.',
          badge: 'Project',
          host: hostFromReq(c),
        })
      )
      return pngResponse(png)
    }

    const taskCountRow = db
      .select({ n: count() })
      .from(tasks)
      .where(eq(tasks.projectId, id))
      .get()

    const cacheKey = `project:${id}:${project.updatedAt}:${taskCountRow?.n ?? 0}`
    const png = await renderCached(cacheKey, () =>
      renderProjectOg({
        name: project.name,
        description: project.description,
        taskCount: taskCountRow?.n ?? 0,
        host: hostFromReq(c),
      })
    )
    return pngResponse(png)
  } catch (err) {
    logOgError('OG project render failed', { id, err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
    return c.text('OG render failed', 500)
  }
})

app.get('/repo/:id', async (c) => {
  const id = c.req.param('id').replace(/\.png$/, '')
  try {
    const repo = db.select().from(repositories).where(eq(repositories.id, id)).get()
    if (!repo) {
      const png = await renderCached('fallback:repo-not-found', () =>
        renderGenericOg({
          title: 'Repository not found',
          subtitle: 'This repository may have been removed.',
          badge: 'Repository',
          host: hostFromReq(c),
        })
      )
      return pngResponse(png)
    }
    const cacheKey = `repo:${id}:${repo.updatedAt}`
    const png = await renderCached(cacheKey, () =>
      renderRepoOg({
        name: repo.displayName,
        branch: repo.lastBaseBranch,
        agent: repo.defaultAgent,
        host: hostFromReq(c),
      })
    )
    return pngResponse(png)
  } catch (err) {
    logOgError('OG repo render failed', { id, err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
    return c.text('OG render failed', 500)
  }
})

async function renderApps(host: string): Promise<Uint8Array> {
  return renderCached(`apps:${host}`, () =>
    renderGenericOg({
      title: 'Deployed Apps',
      subtitle: 'Docker Compose apps with auto DNS & tunnel routing.',
      badge: 'Apps',
      host,
    })
  )
}

async function renderDefault(host: string): Promise<Uint8Array> {
  return renderCached(`default:${host}`, () =>
    renderGenericOg({
      title: 'Fulcrum',
      subtitle: 'Harness Attention. Orchestrate Agents. Ship.',
      badge: 'Cockpit',
      host,
    })
  )
}

for (const path of ['/apps', '/apps.png']) {
  app.get(path, async (c) => {
    try {
      return pngResponse(await renderApps(hostFromReq(c)))
    } catch (err) {
      logOgError('OG apps render failed', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
      return c.text('OG render failed', 500)
    }
  })
}

for (const path of ['/default', '/default.png']) {
  app.get(path, async (c) => {
    try {
      return pngResponse(await renderDefault(hostFromReq(c)))
    } catch (err) {
      logOgError('OG default render failed', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined })
      return c.text('OG render failed', 500)
    }
  })
}

export default app
