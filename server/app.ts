import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import healthRoutes from './routes/health'
import tasksRoutes from './routes/tasks'
import gitRoutes from './routes/git'
import filesystemRoutes from './routes/filesystem'
import configRoutes from './routes/config'
import uploadsRoutes from './routes/uploads'
import worktreesRoutes from './routes/worktrees'
import terminalViewStateRoutes from './routes/terminal-view-state'
import repositoriesRoutes from './routes/repositories'
import copierRoutes from './routes/copier'
import githubRoutes from './routes/github'
import { monitoringRoutes } from './routes/monitoring'
import systemRoutes from './routes/system'
import execRoutes from './routes/exec'
import appsRoutes from './routes/apps'
import composeRoutes from './routes/compose'
import deploymentRoutes from './routes/deployment'
import jobsRoutes from './routes/jobs'
import opencodeRoutes from './routes/opencode'
import projectsRoutes from './routes/projects'
import taskDependenciesRoutes from './routes/task-dependencies'
import tagsRoutes from './routes/tags'
import versionRoutes from './routes/version'
import mcpRoutes from './routes/mcp'
import mcpObserverRoutes from './routes/mcp-restricted'
import assistantRoutes from './routes/assistant'
import messagingRoutes from './routes/messaging'
import backupRoutes from './routes/backup'
import caldavRoutes from './routes/caldav'
import googleOauthRoutes from './routes/google-oauth'
import googleRoutes from './routes/google'
import memoryRoutes from './routes/memory'
import memoryFileRoutes from './routes/memory-file'
import searchRoutes from './routes/search'
import scratchDirsRoutes from './routes/scratch-dirs'
import serverExposeRoutes from './routes/server-expose'
import usersRoutes from './routes/users'
import teamsRoutes from './routes/teams'
import aclsRoutes from './routes/acls'
import { currentUser } from './middleware/current-user'
import { writeEntry } from './lib/logger'
import type { LogEntry } from '../shared/logger'

/**
 * Gets the path to the dist directory.
 * In bundled mode (CLI), FULCRUM_PACKAGE_ROOT points to the package installation.
 * In dev/source mode, uses CWD.
 */
function getDistPath(): string {
  if (process.env.FULCRUM_PACKAGE_ROOT) {
    return join(process.env.FULCRUM_PACKAGE_ROOT, 'dist')
  }
  return join(process.cwd(), 'dist')
}

export function createApp() {
  const app = new Hono()

  // Middleware

  // Bun automatically adds Transfer-Encoding: chunked for streamed responses,
  // but Hono's streamSSE also sets it, causing duplicate headers.
  // This breaks nginx reverse proxies (duplicate hop-by-hop header → 502).
  // Only strip it for SSE responses and let Bun handle it natively.
  app.use('*', async (c, next) => {
    await next()
    if (c.res.headers.get('Content-Type')?.includes('text/event-stream')) {
      c.res.headers.delete('Transfer-Encoding')
    }
  })

  app.use('*', logger())
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'mcp-session-id',
        'Last-Event-ID',
        'mcp-protocol-version',
        // Cloudflare Access injects this on every request behind a CF Access
        // policy. We trust it because CF verifies the user identity at the
        // edge; the gateway/README spells out the threat model.
        'Cf-Access-Authenticated-User-Email',
        'Cf-Access-Jwt-Assertion',
      ],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    })
  )

  // Identity resolution — runs before all /api routes so handlers can read
  // `c.var.user`. Non-enforcing: routes opt in via `requireUser(c)`.
  // Also runs on /ws/* upgrades (D-4) so the WS factory can tag the socket
  // with its identity at connection time.
  app.use('/api/*', currentUser)
  app.use('/ws/*', currentUser)

  // API Routes
  app.route('/health', healthRoutes)
  app.route('/api/users', usersRoutes)
  app.route('/api/tasks', tasksRoutes)
  app.route('/api/git', gitRoutes)
  app.route('/api/fs', filesystemRoutes)
  app.route('/api/config', configRoutes)
  app.route('/api/uploads', uploadsRoutes)
  app.route('/api/worktrees', worktreesRoutes)
  app.route('/api/scratch-dirs', scratchDirsRoutes)
  app.route('/api/terminal-view-state', terminalViewStateRoutes)
  app.route('/api/repositories', repositoriesRoutes)
  app.route('/api/copier', copierRoutes)
  app.route('/api/github', githubRoutes)
  app.route('/api/monitoring', monitoringRoutes)
  app.route('/api/server/expose', serverExposeRoutes)
  app.route('/api/system', systemRoutes)
  app.route('/api/exec', execRoutes)
  app.route('/api/apps', appsRoutes)
  app.route('/api/compose', composeRoutes)
  app.route('/api/deployment', deploymentRoutes)
  app.route('/api/jobs', jobsRoutes)
  app.route('/api/opencode', opencodeRoutes)
  app.route('/api/projects', projectsRoutes)
  app.route('/api/task-dependencies', taskDependenciesRoutes)
  app.route('/api/tags', tagsRoutes)
  app.route('/api/version', versionRoutes)
  app.route('/api/teams', teamsRoutes)
  app.route('/api/acls', aclsRoutes)

  // MCP HTTP transport endpoints
  app.route('/mcp/observer', mcpObserverRoutes)
  app.route('/mcp', mcpRoutes)

  // AI Chat assistant routes
  app.route('/api/assistant', assistantRoutes)

  // Messaging channels (WhatsApp, etc.)
  app.route('/api/messaging', messagingRoutes)

  // Backup and restore
  app.route('/api/backup', backupRoutes)

  // CalDAV calendar integration
  app.route('/api/caldav', caldavRoutes)

  // Google OAuth and API integration
  app.route('/api/google/oauth', googleOauthRoutes)
  app.route('/api/google', googleRoutes)

  // Agent memory system
  app.route('/api/memory', memoryRoutes)

  // Master memory file (MEMORY.md)
  app.route('/api/memory-file', memoryFileRoutes)

  // Unified search across all entities
  app.route('/api/search', searchRoutes)

  // Logging endpoint for frontend to send batched logs to server
  app.post('/api/logs', async (c) => {
    const { entries } = await c.req.json<{ entries: LogEntry[] }>()
    for (const entry of entries) {
      writeEntry(entry)
    }
    return c.json({ ok: true })
  })

  // Legacy debug endpoint (for backwards compatibility during migration)
  app.post('/api/debug', async (c) => {
    const body = await c.req.json()
    // Convert old format to new JSONL format
    const entry = {
      ts: new Date().toISOString(),
      lvl: 'debug',
      src: 'Frontend/Legacy',
      msg: body.message,
      ...(body.data ? { ctx: body.data } : {}),
    }
    console.log(JSON.stringify(entry))
    return c.json({ ok: true })
  })

  // Serve static files in production mode or bundled CLI mode
  // Note: Check FULCRUM_PACKAGE_ROOT in addition to NODE_ENV because bun build
  // inlines NODE_ENV at build time, removing this block if built without NODE_ENV=production
  if (process.env.NODE_ENV === 'production' || process.env.FULCRUM_PACKAGE_ROOT) {
    const distPath = getDistPath()

    // Helper to serve static files with proper MIME types and caching
    const serveFile = async (filePath: string, immutableCache = false) => {
      const ext = filePath.split('.').pop()?.toLowerCase()
      const mimeTypes: Record<string, string> = {
        html: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        ico: 'image/x-icon',
        svg: 'image/svg+xml',
        woff: 'font/woff',
        woff2: 'font/woff2',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
      }
      const content = await readFile(filePath)
      // Assets with content hashes can be cached forever (immutable)
      // Other files should revalidate on each request
      const cacheControl = immutableCache
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, must-revalidate'
      return new Response(content, {
        headers: {
          'Content-Type': mimeTypes[ext || ''] || 'application/octet-stream',
          'Cache-Control': cacheControl,
        },
      })
    }

    // Serve assets (immutable cache - files have content hashes)
    app.get('/assets/*', async (c) => {
      const assetPath = join(distPath, c.req.path)
      if (existsSync(assetPath)) {
        return serveFile(assetPath, true)
      }
      return c.notFound()
    })

    // Serve sounds
    app.get('/sounds/*', async (c) => {
      const soundPath = join(distPath, c.req.path)
      if (existsSync(soundPath)) {
        return serveFile(soundPath)
      }
      return c.notFound()
    })

    // Serve specific static files
    const staticFiles = ['fulcrum-icon.png', 'fulcrum-logo.jpeg', 'vite.svg', 'logo.png', 'goat.jpeg']
    for (const file of staticFiles) {
      app.get(`/${file}`, async () => {
        const filePath = join(distPath, file)
        if (existsSync(filePath)) {
          return serveFile(filePath)
        }
        return new Response('Not Found', { status: 404 })
      })
    }

    // SPA fallback - serve index.html for all other routes (except API and WebSocket)
    app.get('*', async (c, next) => {
      const path = c.req.path
      if (path.startsWith('/api/') || path.startsWith('/ws/') || path === '/health') {
        return next()
      }
      const html = await readFile(join(distPath, 'index.html'), 'utf-8')
      return c.html(html, {
        headers: { 'Cache-Control': 'no-cache, must-revalidate' },
      })
    })
  }

  return app
}
