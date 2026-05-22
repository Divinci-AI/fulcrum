import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as fs from 'fs'
import * as path from 'path'
import { db, tasks } from '../db'
import { eq } from 'drizzle-orm'
import { getScratchBasePath } from '../lib/settings'
import { getPTYManager, destroyTerminalAndBroadcast } from '../terminal/pty-instance'
import type { ScratchDirBasic, ScratchDirDetails, ScratchDirsSummary, TaskStatus } from '../../shared/types'

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

// Destroy terminals associated with a directory path
function destroyTerminalsForDir(dirPath: string): void {
  try {
    const ptyManager = getPTYManager()
    const terminals = ptyManager.listTerminals()
    for (const terminal of terminals) {
      if (terminal.cwd === dirPath) {
        destroyTerminalAndBroadcast(terminal.id)
      }
    }
  } catch {
    // PTY manager might not be initialized yet, ignore
  }
}

const app = new Hono()

// GET /api/scratch-dirs - Stream scratch dirs via SSE for progressive loading
app.get('/', (c) => {
  // Disable proxy buffering for SSE
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    await stream.write(': ping\n\n')

    const scratchBasePath = getScratchBasePath()

    if (!fs.existsSync(scratchBasePath)) {
      await stream.writeSSE({
        event: 'scratch:basic',
        data: JSON.stringify([]),
      })
      await stream.writeSSE({
        event: 'scratch:complete',
        data: JSON.stringify({
          total: 0,
          orphaned: 0,
          totalSize: 0,
          totalSizeFormatted: '0 B',
        } satisfies ScratchDirsSummary),
      })
      return
    }

    // Get all scratch tasks to build a map of worktreePath -> task
    const allTasks = db.select().from(tasks).all()
    const dirToTask = new Map<string, (typeof allTasks)[0]>()
    for (const task of allTasks) {
      if (task.worktreePath && task.type === 'scratch') {
        dirToTask.set(task.worktreePath, task)
      }
    }

    // Read all directories in scratchBasePath
    const entries = fs.readdirSync(scratchBasePath, { withFileTypes: true })
    const basicDirs: ScratchDirBasic[] = []
    const pathsToProcess: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const fullPath = path.join(scratchBasePath, entry.name)
      const stats = fs.statSync(fullPath)
      const linkedTask = dirToTask.get(fullPath)

      basicDirs.push({
        path: fullPath,
        name: entry.name,
        lastModified: stats.mtime.toISOString(),
        isOrphaned: !linkedTask,
        taskId: linkedTask?.id,
        taskTitle: linkedTask?.title,
        taskStatus: linkedTask?.status as TaskStatus | undefined,
        pinned: linkedTask?.pinned ?? false,
      })
      pathsToProcess.push(fullPath)
    }

    // Sort: orphaned first, then by last modified (newest first)
    basicDirs.sort((a, b) => {
      if (a.isOrphaned !== b.isOrphaned) {
        return a.isOrphaned ? -1 : 1
      }
      return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
    })

    // Send basic info immediately
    await stream.writeSSE({
      event: 'scratch:basic',
      data: JSON.stringify(basicDirs),
    })

    // Process details in parallel with concurrency limit
    let totalSize = 0
    const CONCURRENCY = 4

    async function processDir(fullPath: string) {
      try {
        const size = await getDirectorySizeAsync(fullPath)
        totalSize += size

        await stream.writeSSE({
          event: 'scratch:details',
          data: JSON.stringify({
            path: fullPath,
            size,
            sizeFormatted: formatBytes(size),
          } satisfies ScratchDirDetails),
        })
      } catch (error) {
        await stream.writeSSE({
          event: 'scratch:error',
          data: JSON.stringify({
            path: fullPath,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        })
      }
    }

    for (let i = 0; i < pathsToProcess.length; i += CONCURRENCY) {
      const batch = pathsToProcess.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(processDir))
    }

    // Send completion summary
    await stream.writeSSE({
      event: 'scratch:complete',
      data: JSON.stringify({
        total: basicDirs.length,
        orphaned: basicDirs.filter((d) => d.isOrphaned).length,
        totalSize,
        totalSizeFormatted: formatBytes(totalSize),
      } satisfies ScratchDirsSummary),
    })
  })
})

// GET /api/scratch-dirs/json - JSON fallback
app.get('/json', async (c) => {
  const scratchBasePath = getScratchBasePath()

  if (!fs.existsSync(scratchBasePath)) {
    return c.json({
      dirs: [],
      summary: {
        total: 0,
        orphaned: 0,
        totalSize: 0,
        totalSizeFormatted: '0 B',
      },
    })
  }

  const allTasks = db.select().from(tasks).all()
  const dirToTask = new Map<string, (typeof allTasks)[0]>()
  for (const task of allTasks) {
    if (task.worktreePath && task.type === 'scratch') {
      dirToTask.set(task.worktreePath, task)
    }
  }

  const entries = fs.readdirSync(scratchBasePath, { withFileTypes: true })
  const dirs: (ScratchDirBasic & Partial<ScratchDirDetails>)[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const fullPath = path.join(scratchBasePath, entry.name)
    const stats = fs.statSync(fullPath)
    const linkedTask = dirToTask.get(fullPath)

    const size = await getDirectorySizeAsync(fullPath)

    dirs.push({
      path: fullPath,
      name: entry.name,
      lastModified: stats.mtime.toISOString(),
      isOrphaned: !linkedTask,
      taskId: linkedTask?.id,
      taskTitle: linkedTask?.title,
      taskStatus: linkedTask?.status as TaskStatus | undefined,
      pinned: linkedTask?.pinned ?? false,
      size,
      sizeFormatted: formatBytes(size),
    })
  }

  dirs.sort((a, b) => {
    if (a.isOrphaned !== b.isOrphaned) {
      return a.isOrphaned ? -1 : 1
    }
    return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
  })

  const totalSize = dirs.reduce((sum, d) => sum + (d.size || 0), 0)

  return c.json({
    dirs,
    summary: {
      total: dirs.length,
      orphaned: dirs.filter((d) => d.isOrphaned).length,
      totalSize,
      totalSizeFormatted: formatBytes(totalSize),
    },
  })
})

// DELETE /api/scratch-dirs - Delete a scratch directory (optionally delete linked task)
app.delete('/', async (c) => {
  try {
    const body = await c.req.json<{
      dirPath: string
      deleteLinkedTask?: boolean
    }>()

    if (!body.dirPath) {
      return c.json({ error: 'dirPath is required' }, 400)
    }

    // Verify it's within the scratch base path for safety
    const scratchBasePath = getScratchBasePath()
    const normalizedPath = path.normalize(body.dirPath)
    if (!normalizedPath.startsWith(scratchBasePath)) {
      return c.json({ error: 'Invalid scratch directory path' }, 400)
    }

    if (!fs.existsSync(body.dirPath)) {
      return c.json({ error: 'Directory not found' }, 404)
    }

    // Find the linked task
    const linkedTask = db
      .select()
      .from(tasks)
      .where(eq(tasks.worktreePath, body.dirPath))
      .get()

    // Reject deletion if the linked task is pinned
    if (linkedTask?.pinned) {
      return c.json({ error: 'Cannot delete a pinned scratch directory. Unpin it first.' }, 400)
    }

    // Destroy any terminals using this directory
    destroyTerminalsForDir(body.dirPath)

    // Delete the directory
    fs.rmSync(body.dirPath, { recursive: true, force: true })

    // Handle linked task
    let deletedTaskId: string | undefined
    if (linkedTask) {
      const now = new Date().toISOString()

      if (body.deleteLinkedTask) {
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

    return c.json({ success: true, path: body.dirPath, deletedTaskId })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete scratch directory' }, 500)
  }
})

export default app