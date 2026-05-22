import { Hono } from 'hono'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { nanoid } from 'nanoid'
import { db, repositories, projects, projectRepositories, apps, appServices, tasks } from '../db'
import { eq, desc, sql } from 'drizzle-orm'
import { getSettings, expandPath } from '../lib/settings'
import { broadcast } from '../websocket/terminal-ws'
import type { Repository, AgentType } from '../../shared/types'

const app = new Hono()

// Transform database row to API response (parse JSON fields + narrow
// schema types that drizzle leaves looser than the Repository interface).
function toApiResponse(row: typeof repositories.$inferSelect): Repository {
  return {
    ...row,
    claudeOptions: row.claudeOptions ? JSON.parse(row.claudeOptions) : null,
    opencodeOptions: row.opencodeOptions ? JSON.parse(row.opencodeOptions) : null,
    // DB stores defaultAgent as text; the Repository interface narrows
    // to the AgentType union. Cast here rather than at every call site.
    defaultAgent: row.defaultAgent as AgentType | null,
    // SQLite boolean default(false) gives drizzle a `boolean | null` for
    // reads; Repository wants `boolean`. Normalize null → false.
    isCopierTemplate: row.isCopierTemplate ?? false,
  }
}

// GET /api/repositories - List all repositories (sorted by last used, then created)
// Query params:
//   orphans=true - Only return repositories not linked to any project
//   projectId=X - Only return repositories linked to the specified project
app.get('/', (c) => {
  const orphansOnly = c.req.query('orphans') === 'true'
  const projectIdFilter = c.req.query('projectId')

  let allRepos = db
    .select()
    .from(repositories)
    .orderBy(
      // Sort by lastUsedAt DESC (nulls last), then by createdAt DESC
      desc(sql`COALESCE(${repositories.lastUsedAt}, '1970-01-01')`),
      desc(repositories.createdAt)
    )
    .all()

  // Filter based on query params
  if (orphansOnly || projectIdFilter) {
    // Get all project-repository links (join table)
    const allProjectRepos = db.select().from(projects).all()
    const linkedRepoIds = new Set<string>()
    const repoIdsByProject = new Map<string, string[]>()

    // Check legacy repositoryId links
    for (const project of allProjectRepos) {
      if (project.repositoryId) {
        linkedRepoIds.add(project.repositoryId)
        const existing = repoIdsByProject.get(project.id) ?? []
        existing.push(project.repositoryId)
        repoIdsByProject.set(project.id, existing)
      }
    }

    // Check projectRepositories join table
    const prLinks = db.select().from(projectRepositories).all()
    for (const link of prLinks) {
      linkedRepoIds.add(link.repositoryId)
      const existing = repoIdsByProject.get(link.projectId) ?? []
      existing.push(link.repositoryId)
      repoIdsByProject.set(link.projectId, existing)
    }

    if (orphansOnly) {
      allRepos = allRepos.filter((r) => !linkedRepoIds.has(r.id))
    }

    if (projectIdFilter) {
      const projectRepoIds = repoIdsByProject.get(projectIdFilter) ?? []
      allRepos = allRepos.filter((r) => projectRepoIds.includes(r.id))
    }
  }

  return c.json(allRepos.map(toApiResponse))
})

// GET /api/repositories/:id - Get single repository
app.get('/:id', (c) => {
  const id = c.req.param('id')
  const repo = db.select().from(repositories).where(eq(repositories.id, id)).get()
  if (!repo) {
    return c.json({ error: 'Repository not found' }, 404)
  }

  // Get linked projects via join table
  const linkedProjects = db
    .select({
      id: projects.id,
      name: projects.name,
    })
    .from(projectRepositories)
    .innerJoin(projects, eq(projectRepositories.projectId, projects.id))
    .where(eq(projectRepositories.repositoryId, id))
    .all()

  return c.json({
    ...toApiResponse(repo),
    projects: linkedProjects,
  })
})

// POST /api/repositories - Create a repository and associate it with a project
// Body: { path: string, displayName?: string, projectId?: string }
// If projectId is provided, links to that existing project (404 if not found).
// If projectId is omitted, auto-creates a project with the same name as the repo.
app.post('/', async (c) => {
  try {
    const body = await c.req.json<{
      path: string
      displayName?: string
      projectId?: string
    }>()

    if (!body.path) {
      return c.json({ error: 'path is required' }, 400)
    }

    const repoPath = expandPath(body.path)

    // Check if directory exists
    if (!existsSync(repoPath)) {
      return c.json({ error: `Directory does not exist: ${repoPath}` }, 400)
    }

    // Check if it's a git repo
    const gitPath = join(repoPath, '.git')
    if (!existsSync(gitPath)) {
      return c.json({ error: `Directory is not a git repository: ${repoPath}` }, 400)
    }

    // Check for duplicate path
    const existing = db.select().from(repositories).where(eq(repositories.path, repoPath)).get()
    if (existing) {
      return c.json({ error: 'Repository with this path already exists', existingId: existing.id }, 409)
    }

    const displayName = body.displayName || repoPath.split('/').pop() || 'repo'
    const now = new Date().toISOString()
    const id = nanoid()

    db.insert(repositories)
      .values({
        id,
        path: repoPath,
        displayName,
        startupScript: null,
        copyFiles: null,
        isCopierTemplate: false,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const repo = db.select().from(repositories).where(eq(repositories.id, id)).get()
    if (!repo) {
      return c.json({ error: 'Failed to create repository' }, 500)
    }

    // Associate with a project
    let projectId: string
    let projectName: string

    if (body.projectId) {
      // Link to existing project
      const existingProject = db.select().from(projects).where(eq(projects.id, body.projectId)).get()
      if (!existingProject) {
        // Clean up the repo we just created
        db.delete(repositories).where(eq(repositories.id, id)).run()
        return c.json({ error: 'Project not found' }, 404)
      }
      projectId = existingProject.id
      projectName = existingProject.name
    } else {
      // Auto-create a project with the same name
      projectId = nanoid()
      projectName = displayName
      db.insert(projects)
        .values({
          id: projectId,
          name: displayName,
          repositoryId: id,
          status: 'active',
          lastAccessedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }

    // Link repo to project via join table
    db.insert(projectRepositories)
      .values({
        id: nanoid(),
        projectId,
        repositoryId: id,
        isPrimary: true,
        createdAt: now,
      })
      .run()

    broadcast({ type: 'project:updated', payload: { projectId } })
    broadcast({ type: 'repositories:updated' })

    return c.json({ ...toApiResponse(repo), project: { id: projectId, name: projectName } }, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create repository' }, 400)
  }
})

// POST /api/repositories/clone - DEPRECATED: Use POST /api/projects instead
// Repositories must be created through projects to maintain data integrity
app.post('/clone', (c) => {
  return c.json({
    error: 'Standalone repository cloning is not supported. Use POST /api/projects to create a project with a cloned repository.',
  }, 400)
})

// PATCH /api/repositories/:id - Update repository
app.patch('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(repositories).where(eq(repositories.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Repository not found' }, 404)
    }

    const body = await c.req.json<{
      path?: string
      displayName?: string
      startupScript?: string | null
      copyFiles?: string | null
      claudeOptions?: Record<string, string> | null
      opencodeOptions?: Record<string, string> | null
      opencodeModel?: string | null
      defaultAgent?: 'claude' | 'opencode' | null
      isCopierTemplate?: boolean
    }>()

    // If path is changing, validate and check for duplicates
    if (body.path && body.path !== existing.path) {
      const newPath = expandPath(body.path)

      // Check if directory exists
      if (!existsSync(newPath)) {
        return c.json({ error: `Directory does not exist: ${newPath}` }, 400)
      }

      const duplicate = db
        .select()
        .from(repositories)
        .where(eq(repositories.path, newPath))
        .get()
      if (duplicate) {
        return c.json({ error: 'Repository with this path already exists' }, 400)
      }

      // Update body.path with expanded path
      body.path = newPath
    }

    const now = new Date().toISOString()

    // Serialize agent options if provided
    const updateData: Record<string, unknown> = { ...body, updatedAt: now }
    if ('claudeOptions' in body) {
      updateData.claudeOptions = body.claudeOptions ? JSON.stringify(body.claudeOptions) : null
    }
    if ('opencodeOptions' in body) {
      updateData.opencodeOptions = body.opencodeOptions ? JSON.stringify(body.opencodeOptions) : null
    }

    db.update(repositories)
      .set(updateData)
      .where(eq(repositories.id, id))
      .run()

    const updated = db.select().from(repositories).where(eq(repositories.id, id)).get()
    return c.json(updated ? toApiResponse(updated) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update repository' }, 400)
  }
})

// DELETE /api/repositories/:id - Delete repository (unlinks from projects/tasks first)
// Query params:
//   deleteDirectory=true - Also delete the directory from disk
//   deleteApp=true - Also delete the linked app
app.delete('/:id', (c) => {
  const id = c.req.param('id')
  const deleteDirectory = c.req.query('deleteDirectory') === 'true'
  const deleteAppFlag = c.req.query('deleteApp') === 'true'

  const existing = db.select().from(repositories).where(eq(repositories.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Repository not found' }, 404)
  }

  // Optionally delete linked app
  if (deleteAppFlag) {
    const linkedApp = db.select().from(apps).where(eq(apps.repositoryId, id)).get()
    if (linkedApp) {
      db.delete(appServices).where(eq(appServices.appId, linkedApp.id)).run()
      db.delete(apps).where(eq(apps.id, linkedApp.id)).run()
    }
  }

  // Optionally delete directory from disk
  let directoryDeleted = false
  if (deleteDirectory && existing.path) {
    const repoPath = existing.path
    const home = homedir()
    if (resolve(repoPath) === home) {
      return c.json({ error: 'Cannot delete home directory' }, 400)
    }
    const dangerousPaths = ['/', '/home', '/usr', '/etc', '/var', '/tmp', '/root']
    if (dangerousPaths.includes(resolve(repoPath))) {
      return c.json({ error: 'Cannot delete system directory' }, 400)
    }
    if (existsSync(repoPath)) {
      const gitPath = join(repoPath, '.git')
      if (!existsSync(gitPath)) {
        return c.json({ error: 'Directory does not appear to be a git repository' }, 400)
      }
      try {
        rmSync(repoPath, { recursive: true, force: true })
        directoryDeleted = true
      } catch (err) {
        return c.json({
          error: `Failed to delete directory: ${err instanceof Error ? err.message : 'Unknown error'}`,
        }, 500)
      }
    }
  }

  // Clean up projectRepositories join table
  db.delete(projectRepositories).where(eq(projectRepositories.repositoryId, id)).run()

  // Null out deprecated projects.repositoryId
  db.update(projects).set({ repositoryId: null }).where(eq(projects.repositoryId, id)).run()

  // Null out tasks.repositoryId
  db.update(tasks).set({ repositoryId: null }).where(eq(tasks.repositoryId, id)).run()

  // Delete the repository record
  db.delete(repositories).where(eq(repositories.id, id)).run()

  return c.json({ success: true, directoryDeleted })
})

// POST /api/repositories/scan - Scan directory for git repositories
app.post('/scan', async (c) => {
  try {
    const body = await c.req.json<{ directory?: string }>().catch((): { directory?: string } => ({}))

    // Default to configured git repos directory, expand tilde if present
    const settings = getSettings()
    const directory = expandPath(body.directory || settings.paths.defaultGitReposDir)

    if (!existsSync(directory)) {
      return c.json({ error: `Directory does not exist: ${directory}` }, 400)
    }

    // Get existing repository paths for comparison
    const existingRepos = db.select({ path: repositories.path }).from(repositories).all()
    const existingPaths = new Set(existingRepos.map((r) => r.path))

    // Scan immediate subdirectories for .git folders
    const discovered: Array<{ path: string; name: string; exists: boolean }> = []

    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Skip hidden directories
      if (entry.name.startsWith('.')) continue

      const subPath = join(directory, entry.name)
      const gitPath = join(subPath, '.git')

      if (existsSync(gitPath)) {
        discovered.push({
          path: subPath,
          name: entry.name,
          exists: existingPaths.has(subPath),
        })
      }
    }

    // Sort by name
    discovered.sort((a, b) => a.name.localeCompare(b.name))

    return c.json({ directory, repositories: discovered })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to scan directory' }, 500)
  }
})

// POST /api/repositories/bulk - DEPRECATED: Use POST /api/projects/bulk instead
// Repositories must be created through projects to maintain data integrity
app.post('/bulk', (c) => {
  return c.json({
    error: 'Standalone bulk repository creation is not supported. Use POST /api/projects/bulk to create projects with repositories.',
  }, 400)
})

export default app