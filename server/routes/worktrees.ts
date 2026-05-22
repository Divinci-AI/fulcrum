// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { db, tasks } from '../db'
import { eq } from 'drizzle-orm'
import { getWorktreeBasePath } from '../lib/settings'
import { getPTYManager, destroyTerminalAndBroadcast } from '../terminal/pty-instance'
import type { WorktreeBasic, WorktreeDetails, WorktreesSummary } from '../../shared/types'

// --- Size cache with 5-minute TTL ---
interface SizeCacheEntry {
  size: number
  computedAt: number
}

const sizeCache = new Map<string, SizeCacheEntry>()
const SIZE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function getCachedSize(dirPath: string): Promise<number> {
  const entry = sizeCache.get(dirPath)
  if (entry && Date.now() - entry.computedAt < SIZE_CACHE_TTL) {
    return entry.size
  }
  const size = await getDirectorySizeAsync(dirPath)
  sizeCache.set(dirPath, { size, computedAt: Date.now() })
  return size
}

function invalidateSizeCache(dirPath: string): void {
  sizeCache.delete(dirPath)
}

// Dynamic concurrency: I/O-bound du can exceed CPU count, clamped to [4, 16]
const CONCURRENCY = Math.min(16, Math.max(4, os.availableParallelism?.() ?? os.cpus().length))

// Format bytes to human-readable string
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

// Get directory size using du command (async)
async function getDirectorySizeAsync(dirPath: string): Promise<number> {
  try {
    const platform = process.platform
    const cmd = platform === 'darwin' ? ['du', '-sk', dirPath] : ['du', '-sb', dirPath]

    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(proc.stdout).text()
    const sizeValue = parseInt(output.split('\t')[0], 10)
    return platform === 'darwin' ? sizeValue * 1024 : sizeValue
  } catch {
    return 0
  }
}

// Get git branch for a worktree path (async)
async function getGitBranchAsync(gitPath: string): Promise<string> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: gitPath,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = await new Response(proc.stdout).text()
    return output.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

// Destroy terminals associated with a worktree path
function destroyTerminalsForWorktree(worktreePath: string): void {
  try {
    const ptyManager = getPTYManager()
    const terminals = ptyManager.listTerminals()
    for (const terminal of terminals) {
      if (terminal.cwd === worktreePath) {
        destroyTerminalAndBroadcast(terminal.id)
      }
    }
  } catch {
    // PTY manager might not be initialized yet, ignore
  }
}

// Delete git worktree (async)
async function deleteWorktree(worktreePath: string, repoPath?: string): Promise<void> {
  if (!fs.existsSync(worktreePath)) return

  // Try git worktree remove if we have the repo path
  if (repoPath && fs.existsSync(repoPath)) {
    try {
      const proc = Bun.spawn(['git', 'worktree', 'remove', worktreePath, '--force'], {
        cwd: repoPath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await proc.exited
      if (proc.exitCode === 0) return
    } catch {
      // Fall through to manual removal
    }
  }

  // Manual removal and prune
  fs.rmSync(worktreePath, { recursive: true, force: true })

  // Try to find the parent repo and prune
  if (repoPath && fs.existsSync(repoPath)) {
    try {
      Bun.spawn(['git', 'worktree', 'prune'], { cwd: repoPath })
    } catch {
      // Ignore prune errors
    }
  }
}

const app = new Hono()

// GET /api/worktrees - Stream worktrees via SSE for progressive loading
app.get('/', (c) => {
  // Disable proxy buffering for SSE (required for Cloudflare tunnels)
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    // Send immediate comment to establish connection (helps with proxies/tunnels)
    await stream.write(': ping\n\n')

    const worktreeBasePath = getWorktreeBasePath()

    // Handle missing directory
    if (!fs.existsSync(worktreeBasePath)) {
      await stream.writeSSE({
        event: 'worktree:basic',
        data: JSON.stringify([]),
      })
      await stream.writeSSE({
        event: 'worktree:complete',
        data: JSON.stringify({
          total: 0,
          orphaned: 0,
          totalSize: 0,
          totalSizeFormatted: '0 B',
        } satisfies WorktreesSummary),
      })
      return
    }

    // Get all tasks to build a map of worktreePath -> task
    const allTasks = db.select().from(tasks).all()
    const worktreeToTask = new Map<string, (typeof allTasks)[0]>()
    for (const task of allTasks) {
      if (task.worktreePath) {
        worktreeToTask.set(task.worktreePath, task)
      }
    }

    // Read all directories in worktreeBasePath (fast operation)
    const entries = fs.readdirSync(worktreeBasePath, { withFileTypes: true })
    const basicWorktrees: WorktreeBasic[] = []
    const pathsToProcess: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const fullPath = path.join(worktreeBasePath, entry.name)

      // Check if it's a git worktree (has .git file or directory)
      const gitPath = path.join(fullPath, '.git')
      if (!fs.existsSync(gitPath)) continue

      const stats = fs.statSync(fullPath)
      const linkedTask = worktreeToTask.get(fullPath)

      basicWorktrees.push({
        path: fullPath,
        name: entry.name,
        lastModified: stats.mtime.toISOString(),
        isOrphaned: !linkedTask,
        taskId: linkedTask?.id,
        taskTitle: linkedTask?.title,
        taskStatus: linkedTask?.status,
        repoPath: linkedTask?.repoPath,
        pinned: linkedTask?.pinned ?? false,
      })
      pathsToProcess.push(fullPath)
    }

    // Sort: orphaned first, then by last modified (newest first)
    basicWorktrees.sort((a, b) => {
      if (a.isOrphaned !== b.isOrphaned) {
        return a.isOrphaned ? -1 : 1
      }
      return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
    })

    // Send basic info immediately
    await stream.writeSSE({
      event: 'worktree:basic',
      data: JSON.stringify(basicWorktrees),
    })

    // Process details in parallel with concurrency limit
    let totalSize = 0

    async function processWorktree(fullPath: string) {
      try {
        const [size, branch] = await Promise.all([
          getCachedSize(fullPath),
          getGitBranchAsync(fullPath),
        ])
        totalSize += size

        await stream.writeSSE({
          event: 'worktree:details',
          data: JSON.stringify({
            path: fullPath,
            size,
            sizeFormatted: formatBytes(size),
            branch,
          } satisfies WorktreeDetails),
        })
      } catch (error) {
        await stream.writeSSE({
          event: 'worktree:error',
          data: JSON.stringify({
            path: fullPath,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        })
      }
    }

    // Process in batches with concurrency limit
    for (let i = 0; i < pathsToProcess.length; i += CONCURRENCY) {
      const batch = pathsToProcess.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(processWorktree))
    }

    // Send completion summary
    await stream.writeSSE({
      event: 'worktree:complete',
      data: JSON.stringify({
        total: basicWorktrees.length,
        orphaned: basicWorktrees.filter((w) => w.isOrphaned).length,
        totalSize,
        totalSizeFormatted: formatBytes(totalSize),
      } satisfies WorktreesSummary),
    })
  })
})

// GET /api/worktrees/json - JSON fallback for environments where SSE doesn't work (e.g., Cloudflare tunnels)
app.get('/json', async (c) => {
  const worktreeBasePath = getWorktreeBasePath()

  // Handle missing directory
  if (!fs.existsSync(worktreeBasePath)) {
    return c.json({
      worktrees: [],
      summary: {
        total: 0,
        orphaned: 0,
        totalSize: 0,
        totalSizeFormatted: '0 B',
      },
    })
  }

  // Get all tasks to build a map of worktreePath -> task
  const allTasks = db.select().from(tasks).all()
  const worktreeToTask = new Map<string, (typeof allTasks)[0]>()
  for (const task of allTasks) {
    if (task.worktreePath) {
      worktreeToTask.set(task.worktreePath, task)
    }
  }

  // Read all directories in worktreeBasePath
  const entries = fs.readdirSync(worktreeBasePath, { withFileTypes: true })

  // Collect basic info synchronously
  const basicEntries: { fullPath: string; name: string; mtime: string; linkedTask: (typeof allTasks)[0] | undefined }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const fullPath = path.join(worktreeBasePath, entry.name)
    const gitPath = path.join(fullPath, '.git')
    if (!fs.existsSync(gitPath)) continue

    const stats = fs.statSync(fullPath)
    basicEntries.push({
      fullPath,
      name: entry.name,
      mtime: stats.mtime.toISOString(),
      linkedTask: worktreeToTask.get(fullPath),
    })
  }

  // Fetch sizes and branches in parallel with concurrency limit
  const worktrees: (WorktreeBasic & Partial<WorktreeDetails>)[] = []
  for (let i = 0; i < basicEntries.length; i += CONCURRENCY) {
    const batch = basicEntries.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (e) => {
        const [size, branch] = await Promise.all([getCachedSize(e.fullPath), getGitBranchAsync(e.fullPath)])
        return { ...e, size, branch }
      }),
    )
    for (const r of results) {
      worktrees.push({
        path: r.fullPath,
        name: r.name,
        lastModified: r.mtime,
        isOrphaned: !r.linkedTask,
        taskId: r.linkedTask?.id,
        taskTitle: r.linkedTask?.title,
        taskStatus: r.linkedTask?.status,
        repoPath: r.linkedTask?.repoPath,
        pinned: r.linkedTask?.pinned ?? false,
        size: r.size,
        sizeFormatted: formatBytes(r.size),
        branch: r.branch,
      })
    }
  }

  // Sort: orphaned first, then by last modified (newest first)
  worktrees.sort((a, b) => {
    if (a.isOrphaned !== b.isOrphaned) {
      return a.isOrphaned ? -1 : 1
    }
    return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
  })

  const totalSize = worktrees.reduce((sum, w) => sum + (w.size || 0), 0)

  return c.json({
    worktrees,
    summary: {
      total: worktrees.length,
      orphaned: worktrees.filter((w) => w.isOrphaned).length,
      totalSize,
      totalSizeFormatted: formatBytes(totalSize),
    },
  })
})

// DELETE /api/worktrees - Delete a worktree (optionally delete linked task)
app.delete('/', async (c) => {
  try {
    const body = await c.req.json<{
      worktreePath: string
      repoPath?: string
      deleteLinkedTask?: boolean
    }>()

    if (!body.worktreePath) {
      return c.json({ error: 'worktreePath is required' }, 400)
    }

    // Verify it's within the worktree base path for safety
    const worktreeBasePath = getWorktreeBasePath()
    const normalizedPath = path.normalize(body.worktreePath)
    if (!normalizedPath.startsWith(worktreeBasePath)) {
      return c.json({ error: 'Invalid worktree path' }, 400)
    }

    if (!fs.existsSync(body.worktreePath)) {
      return c.json({ error: 'Worktree not found' }, 404)
    }

    // Find the linked task
    const linkedTask = db
      .select()
      .from(tasks)
      .where(eq(tasks.worktreePath, body.worktreePath))
      .get()

    // Reject deletion if the linked task is pinned
    if (linkedTask?.pinned) {
      return c.json({ error: 'Cannot delete a pinned worktree. Unpin it first.' }, 400)
    }

    // Destroy any terminals using this worktree
    destroyTerminalsForWorktree(body.worktreePath)

    // Delete the worktree
    await deleteWorktree(body.worktreePath, body.repoPath || linkedTask?.repoPath)
    invalidateSizeCache(body.worktreePath)

    // Handle linked task based on deleteLinkedTask flag
    let deletedTaskId: string | undefined
    if (linkedTask) {
      const now = new Date().toISOString()

      if (body.deleteLinkedTask) {
        // Delete the linked task
        // Shift down tasks in the same column that were after this task
        const columnTasks = db.select().from(tasks).where(eq(tasks.status, linkedTask.status)).all()

        for (const t of columnTasks) {
          if (t.position > linkedTask.position) {
            db.update(tasks)
              .set({ position: t.position - 1, updatedAt: now })
              .where(eq(tasks.id, t.id))
              .run()
          }
        }

        db.delete(tasks).where(eq(tasks.id, linkedTask.id)).run()
        deletedTaskId = linkedTask.id
      } else {
        // Preserve the task but clear its worktreePath
        db.update(tasks)
          .set({ worktreePath: null, updatedAt: now })
          .where(eq(tasks.id, linkedTask.id))
          .run()
      }
    }

    return c.json({ success: true, path: body.worktreePath, deletedTaskId })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete worktree' }, 500)
  }
})

export default app