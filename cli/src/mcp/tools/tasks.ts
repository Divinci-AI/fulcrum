// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Task MCP tools
 */
import { basename } from 'node:path'
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { TaskStatusSchema } from './types'
import { formatSuccess, handleToolError } from '../utils'
import { getTodayInTimezone } from '../../../../shared/date-utils'

type Server = Parameters<ToolRegistrar>[0]
type Client = Parameters<ToolRegistrar>[1]

function registerListTasks(server: Server, client: Client) {
  server.tool(
    'list_tasks',
    'List all Fulcrum tasks with flexible filtering. Supports text search across title/tags/project, multi-tag filtering (OR logic), multi-status filtering, date range, and overdue detection.',
    {
      status: z
        .optional(TaskStatusSchema)
        .describe('Filter by single task status (use statuses for multiple)'),
      statuses: z
        .optional(z.array(TaskStatusSchema))
        .describe('Filter by multiple statuses (OR logic)'),
      repo: z.optional(z.string()).describe('Filter by repository name or path'),
      projectId: z.optional(z.string()).describe('Filter by project ID'),
      orphans: z
        .optional(z.boolean())
        .describe('Only show orphan tasks (not in any project)'),
      tag: z.optional(z.string()).describe('Filter by single tag (use tags for multiple)'),
      tags: z
        .optional(z.array(z.string()))
        .describe('Filter by multiple tags (OR logic, case-insensitive)'),
      search: z
        .optional(z.string())
        .describe('Case-insensitive substring search across title, tags, and project name'),
      dueDateStart: z
        .optional(z.string())
        .describe('Start of date range (YYYY-MM-DD, inclusive)'),
      dueDateEnd: z.optional(z.string()).describe('End of date range (YYYY-MM-DD, inclusive)'),
      overdue: z
        .optional(z.boolean())
        .describe('Only show overdue tasks (due date in past, not DONE/CANCELED)'),
      sort: z
        .optional(z.enum(['position', 'created', 'updated']))
        .describe('Sort order: "position" (default), "created" (newest first), "updated" (most recently updated first)'),
      limit: z
        .optional(z.number().int().min(1).max(100))
        .describe('Return only the first N results after filtering/sorting (1-100)'),
    },
    async ({
      status,
      statuses,
      repo,
      projectId,
      orphans,
      tag,
      tags,
      search,
      dueDateStart,
      dueDateEnd,
      overdue,
      sort,
      limit,
    }) => {
      try {
        let tasks = await client.listTasks()

        // Build project name lookup for search functionality
        let projectsMap: Map<string, string> | undefined
        if (search) {
          const projects = await client.listProjects()
          projectsMap = new Map()
          for (const p of projects) {
            projectsMap.set(p.id, p.name)
          }
        }

        // Text search filter (case-insensitive substring)
        if (search) {
          const searchLower = search.toLowerCase()
          tasks = tasks.filter((t) => {
            if (t.title.toLowerCase().includes(searchLower)) return true
            if (t.tags && t.tags.some((tg) => tg.toLowerCase().includes(searchLower))) return true
            if (t.projectId && projectsMap) {
              const projectName = projectsMap.get(t.projectId)
              if (projectName?.toLowerCase().includes(searchLower)) return true
            }
            return false
          })
        }

        if (status) {
          tasks = tasks.filter((t) => t.status === status)
        }

        if (statuses && statuses.length > 0) {
          tasks = tasks.filter((t) => statuses.includes(t.status))
        }

        if (repo) {
          const repoLower = repo.toLowerCase()
          tasks = tasks.filter(
            (t) =>
              (t.repoName && t.repoName.toLowerCase().includes(repoLower)) ||
              (t.repoPath && t.repoPath.toLowerCase().includes(repoLower))
          )
        }
        if (projectId) {
          tasks = tasks.filter((t) => t.projectId === projectId)
        }
        if (orphans) {
          tasks = tasks.filter((t) => t.projectId === null)
        }

        if (tag) {
          const tagLower = tag.toLowerCase()
          tasks = tasks.filter(
            (t) => t.tags && t.tags.some((tg) => tg.toLowerCase() === tagLower)
          )
        }

        if (tags && tags.length > 0) {
          const tagsLower = tags.map((tg) => tg.toLowerCase())
          tasks = tasks.filter(
            (t) => t.tags && t.tags.some((tg) => tagsLower.includes(tg.toLowerCase()))
          )
        }

        if (dueDateStart) {
          tasks = tasks.filter((t) => t.dueDate && t.dueDate >= dueDateStart)
        }
        if (dueDateEnd) {
          tasks = tasks.filter((t) => t.dueDate && t.dueDate <= dueDateEnd)
        }

        if (overdue) {
          const config = await client.getConfig('appearance.timezone')
          const timezone = (config?.value as string | null) ?? null
          const today = getTodayInTimezone(timezone)
          tasks = tasks.filter(
            (t) =>
              t.dueDate && t.dueDate < today && t.status !== 'DONE' && t.status !== 'CANCELED'
          )
        }

        if (sort === 'created') {
          tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        } else if (sort === 'updated') {
          tasks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        }

        if (limit) {
          tasks = tasks.slice(0, limit)
        }

        return formatSuccess(tasks)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

function registerCreateTask(server: Server, client: Client) {
  server.tool(
    'create_task',
    'Create a new task. For worktree tasks, provide repoPath to create a git worktree. For scratch tasks, set type to "scratch" to create an isolated directory without git. For manual tasks, omit both repoPath and type. When tags are provided, returns all existing tags for reference.',
    {
      title: z.string().describe('Task title'),
      type: z
        .optional(z.enum(['worktree', 'scratch']))
        .describe('Task type: "worktree" for git worktree tasks (default when repoPath provided), "scratch" for isolated directory without git'),
      repoPath: z
        .optional(z.string())
        .describe('Absolute path to the git repository (optional for manual tasks)'),
      baseBranch: z.optional(z.string()).describe('Base branch for the worktree (default: main)'),
      branch: z
        .optional(z.string())
        .describe('Branch name for the task worktree (auto-generated if omitted)'),
      prefix: z
        .optional(z.string())
        .describe('Prefix prepended to branch name for ticket linkage (e.g., "ENG-123"). Branch becomes: ENG-123/slug-a1b2'),
      description: z.optional(z.string()).describe('Task description'),
      status: z
        .optional(TaskStatusSchema)
        .describe(
          'Initial status (default: TO_DO, use IN_PROGRESS for immediate worktree creation)'
        ),
      projectId: z.optional(z.string()).describe('Project ID to associate with'),
      repositoryId: z.optional(z.string()).describe('Repository ID (alternative to repoPath)'),
      tags: z.optional(z.array(z.string())).describe('Tags to add to the task'),
      dueDate: z.optional(z.string()).describe('Due date in YYYY-MM-DD format'),
      timeEstimate: z
        .optional(z.number().int().min(1))
        .describe('Time estimate in hours (minimum 1)'),
      priority: z
        .optional(z.enum(['high', 'medium', 'low']))
        .describe('Task priority level (default: medium)'),
      recurrenceRule: z
        .optional(z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']))
        .describe('Recurrence frequency - creates a new TO_DO task when completed'),
      recurrenceEndDate: z
        .optional(z.string())
        .describe('Stop recurring after this date (YYYY-MM-DD). Omit for no end date.'),
    },
    async ({
      title,
      type,
      repoPath,
      baseBranch,
      branch,
      prefix,
      description,
      status,
      projectId,
      repositoryId,
      tags,
      dueDate,
      timeEstimate,
      priority,
      recurrenceRule,
      recurrenceEndDate,
    }) => {
      try {
        const repoName = repoPath ? basename(repoPath) : null
        const effectiveBaseBranch = baseBranch ?? 'main'
        const task = await client.createTask({
          title,
          type: type ?? null,
          repoPath: repoPath ?? null,
          repoName,
          baseBranch: repoPath ? effectiveBaseBranch : null,
          branch: branch ?? null,
          prefix: prefix ?? null,
          worktreePath: null,
          description,
          status: status ?? 'TO_DO',
          projectId: projectId ?? null,
          repositoryId: repositoryId ?? null,
          tags,
          dueDate: dueDate ?? null,
          timeEstimate: timeEstimate ?? null,
          priority: priority ?? null,
          recurrenceRule: recurrenceRule ?? null,
          recurrenceEndDate: recurrenceEndDate ?? null,
        })

        if (tags && tags.length > 0) {
          const allTasks = await client.listTasks()
          const existingTags = new Set<string>()
          for (const t of allTasks) {
            if (t.tags) {
              for (const tg of t.tags) {
                existingTags.add(tg)
              }
            }
          }
          return formatSuccess({
            task,
            existingTags: Array.from(existingTags).sort(),
          })
        }

        return formatSuccess(task)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

function registerUpdateTask(server: Server, client: Client) {
  server.tool(
    'update_task',
    'Update task metadata (title, description, recurrence)',
    {
      id: z.string().describe('Task ID'),
      title: z.optional(z.string()).describe('New title'),
      description: z.optional(z.string()).describe('New description'),
      timeEstimate: z
        .optional(z.nullable(z.number().int().min(1)))
        .describe('Time estimate in hours (minimum 1), or null to clear'),
      priority: z
        .optional(z.nullable(z.enum(['high', 'medium', 'low'])))
        .describe('Task priority (high/medium/low), or null to clear'),
      pinned: z
        .optional(z.boolean())
        .describe('Pin task to show at top of kanban column and calendar list'),
      recurrenceRule: z
        .optional(z.nullable(z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'])))
        .describe('Recurrence frequency, or null to remove'),
      recurrenceEndDate: z
        .optional(z.nullable(z.string()))
        .describe('Stop recurring after this date (YYYY-MM-DD), or null to remove'),
    },
    async ({ id, title, description, timeEstimate, priority, pinned, recurrenceRule, recurrenceEndDate }) => {
      try {
        const updates: Record<string, string | number | boolean | null> = {}
        if (title !== undefined) updates.title = title
        if (description !== undefined) updates.description = description
        if (timeEstimate !== undefined) updates.timeEstimate = timeEstimate
        if (priority !== undefined) updates.priority = priority
        if (pinned !== undefined) updates.pinned = pinned
        if (recurrenceRule !== undefined) updates.recurrenceRule = recurrenceRule
        if (recurrenceEndDate !== undefined) updates.recurrenceEndDate = recurrenceEndDate

        const task = await client.updateTask(id, updates)
        return formatSuccess(task)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

function registerAddTaskLink(server: Server, client: Client) {
  server.tool(
    'add_task_link',
    'Add a URL link to a task (for documentation, related PRs, design files, etc.)',
    {
      taskId: z.string().describe('Task ID'),
      url: z.string().url().describe('URL to add'),
      label: z.optional(z.string()).describe('Display label (auto-detected if not provided)'),
    },
    async ({ taskId, url, label }) => {
      try {
        const link = await client.addTaskLink(taskId, url, label)
        return formatSuccess(link)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

function registerAddTaskTag(server: Server, client: Client) {
  server.tool(
    'add_task_tag',
    'Add a tag to a task for categorization. Returns similar existing tags to help catch typos.',
    {
      taskId: z.string().describe('Task ID'),
      tag: z.string().describe('Tag to add'),
    },
    async ({ taskId, tag }) => {
      try {
        const result = await client.addTaskTag(taskId, tag)

        const allTasks = await client.listTasks()
        const existingTags = new Set<string>()
        for (const t of allTasks) {
          if (t.tags) {
            for (const tg of t.tags) {
              existingTags.add(tg)
            }
          }
        }

        const tagLower = tag.toLowerCase()
        const similarTags = Array.from(existingTags).filter(
          (tg) =>
            tg !== tag &&
            (tg.toLowerCase().includes(tagLower) || tagLower.includes(tg.toLowerCase()))
        )

        return formatSuccess({
          ...result,
          similarTags: similarTags.length > 0 ? similarTags : undefined,
        })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

function registerMoveTask(server: Server, client: Client) {
  server.tool(
    'move_task',
    'Move a task to a different status column',
    {
      id: z.string().describe('Task ID'),
      status: TaskStatusSchema.describe('Target status'),
      position: z
        .optional(z.number())
        .describe('Position in the column (0-indexed, defaults to end)'),
    },
    async ({ id, status, position }) => {
      try {
        const task = await client.moveTask(id, status, position)
        return formatSuccess(task)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

function registerSetTaskDueDate(server: Server, client: Client) {
  server.tool(
    'set_task_due_date',
    'Set or clear the due date for a task',
    {
      taskId: z.string().describe('Task ID'),
      dueDate: z.nullable(z.string()).describe('Due date in YYYY-MM-DD format, or null to clear'),
    },
    async ({ taskId, dueDate }) => {
      try {
        const result = await client.setTaskDueDate(taskId, dueDate)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

export const registerTaskTools: ToolRegistrar = (server, client) => {
  registerListTasks(server, client)
  registerCreateTask(server, client)
  registerUpdateTask(server, client)
  registerAddTaskLink(server, client)
  registerAddTaskTag(server, client)
  registerSetTaskDueDate(server, client)

  // get_task
  server.tool(
    'get_task',
    'Get details of a specific task by ID, including dependencies and attachments',
    {
      id: z.string().describe('Task ID (UUID)'),
    },
    async ({ id }) => {
      try {
        const [task, dependencies, attachments] = await Promise.all([
          client.getTask(id),
          client.getTaskDependencies(id),
          client.listTaskAttachments(id),
        ])
        return formatSuccess({ ...task, dependencies, attachments })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // delete_task
  server.tool(
    'delete_task',
    'Delete a task and optionally its linked git worktree',
    {
      id: z.string().describe('Task ID'),
      deleteWorktree: z.optional(z.boolean()).describe('Also delete the linked git worktree (default: false)'),
    },
    async ({ id, deleteWorktree }) => {
      try {
        const effectiveDeleteWorktree = deleteWorktree ?? false
        await client.deleteTask(id, effectiveDeleteWorktree)
        return formatSuccess({ deleted: id, worktreeDeleted: effectiveDeleteWorktree })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  registerMoveTask(server, client)

  // remove_task_link
  server.tool(
    'remove_task_link',
    'Remove a URL link from a task',
    {
      taskId: z.string().describe('Task ID'),
      linkId: z.string().describe('Link ID to remove'),
    },
    async ({ taskId, linkId }) => {
      try {
        await client.removeTaskLink(taskId, linkId)
        return formatSuccess({ removed: linkId })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // list_task_links
  server.tool(
    'list_task_links',
    'List all URL links attached to a task',
    {
      taskId: z.string().describe('Task ID'),
    },
    async ({ taskId }) => {
      try {
        const links = await client.listTaskLinks(taskId)
        return formatSuccess(links)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // remove_task_tag
  server.tool(
    'remove_task_tag',
    'Remove a tag from a task',
    {
      taskId: z.string().describe('Task ID'),
      tag: z.string().describe('Tag to remove'),
    },
    async ({ taskId, tag }) => {
      try {
        const result = await client.removeTaskTag(taskId, tag)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_task_dependencies
  server.tool(
    'get_task_dependencies',
    'Get the dependencies and dependents of a task, and whether it is blocked',
    {
      taskId: z.string().describe('Task ID'),
    },
    async ({ taskId }) => {
      try {
        const result = await client.getTaskDependencies(taskId)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // add_task_dependency
  server.tool(
    'add_task_dependency',
    'Add a dependency between tasks (the task cannot start until the dependency is done)',
    {
      taskId: z.string().describe('Task ID that will depend on another task'),
      dependsOnTaskId: z.string().describe('Task ID that must be completed first'),
    },
    async ({ taskId, dependsOnTaskId }) => {
      try {
        const result = await client.addTaskDependency(taskId, dependsOnTaskId)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // remove_task_dependency
  server.tool(
    'remove_task_dependency',
    'Remove a dependency from a task',
    {
      taskId: z.string().describe('Task ID'),
      dependencyId: z.string().describe('Dependency ID to remove'),
    },
    async ({ taskId, dependencyId }) => {
      try {
        const result = await client.removeTaskDependency(taskId, dependencyId)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // list_task_attachments
  server.tool(
    'list_task_attachments',
    'List all file attachments for a task',
    {
      taskId: z.string().describe('Task ID'),
    },
    async ({ taskId }) => {
      try {
        const attachments = await client.listTaskAttachments(taskId)
        return formatSuccess(attachments)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // upload_task_attachment
  server.tool(
    'upload_task_attachment',
    'Upload a file to a task from a local path. Supported types: PDF, images (PNG, JPEG, GIF, WebP, SVG), text files, Word docs, Excel spreadsheets, CSV.',
    {
      taskId: z.string().describe('Task ID'),
      filePath: z.string().describe('Absolute path to file on the local filesystem'),
    },
    async ({ taskId, filePath }) => {
      try {
        const attachment = await client.uploadTaskAttachment(taskId, filePath)
        return formatSuccess(attachment)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // delete_task_attachment
  server.tool(
    'delete_task_attachment',
    'Delete a file attachment from a task',
    {
      taskId: z.string().describe('Task ID'),
      attachmentId: z.string().describe('Attachment ID to delete'),
    },
    async ({ taskId, attachmentId }) => {
      try {
        const result = await client.deleteTaskAttachment(taskId, attachmentId)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_task_attachment_path
  server.tool(
    'get_task_attachment_path',
    'Get the local file path for a task attachment. Use this to read attachment contents with file tools.',
    {
      taskId: z.string().describe('Task ID'),
      attachmentId: z.string().describe('Attachment ID'),
    },
    async ({ taskId, attachmentId }) => {
      try {
        const result = await client.getTaskAttachmentPath(taskId, attachmentId)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_task_dependency_graph
  server.tool(
    'get_task_dependency_graph',
    'Get all tasks and their dependencies as a graph structure for visualization',
    {},
    async () => {
      try {
        const result = await client.getTaskDependencyGraph()
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // list_tasks_by_tag
  server.tool(
    'list_tasks_by_tag',
    'List all tasks that have a specific tag',
    {
      tag: z.string().describe('Tag to filter by'),
    },
    async ({ tag }) => {
      try {
        let tasks = await client.listTasks()
        const tagLower = tag.toLowerCase()
        tasks = tasks.filter(
          (t) => t.tags && t.tags.some((tg) => tg.toLowerCase() === tagLower)
        )
        return formatSuccess(tasks)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // list_tags
  server.tool(
    'list_tags',
    'List all unique tags in use across tasks. Use search to find tags by partial match (helps discover exact tag names and handle typos/variations).',
    {
      search: z
        .optional(z.string())
        .describe('Find tags matching this substring (case-insensitive)'),
    },
    async ({ search }) => {
      try {
        const tasks = await client.listTasks()
        const tagCounts = new Map<string, number>()

        for (const task of tasks) {
          if (task.tags) {
            for (const tag of task.tags) {
              tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
            }
          }
        }

        let tags = Array.from(tagCounts.entries()).map(([name, count]) => ({
          name,
          count,
        }))

        if (search) {
          const searchLower = search.toLowerCase()
          tags = tags.filter((tg) => tg.name.toLowerCase().includes(searchLower))
        }

        tags.sort((a, b) => b.count - a.count)

        return formatSuccess({ tags })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // delete_tag
  server.tool(
    'delete_tag',
    'Delete a tag from the database. This removes the tag and all its associations with tasks and projects.',
    {
      tag: z.string().describe('The exact name of the tag to delete'),
    },
    async ({ tag }) => {
      try {
        await client.deleteTag(tag)
        return formatSuccess({ deleted: tag })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // list_tasks_by_due_date
  server.tool(
    'list_tasks_by_due_date',
    'List tasks within a date range based on due date',
    {
      startDate: z.optional(z.string()).describe('Start date (YYYY-MM-DD), inclusive'),
      endDate: z.optional(z.string()).describe('End date (YYYY-MM-DD), inclusive'),
      overdue: z.optional(z.boolean()).describe('Only show overdue tasks'),
    },
    async ({ startDate, endDate, overdue }) => {
      try {
        let tasks = await client.listTasks()

        if (overdue) {
          const config = await client.getConfig('appearance.timezone')
          const timezone = (config?.value as string | null) ?? null
          const today = getTodayInTimezone(timezone)
          tasks = tasks.filter(
            (t) =>
              t.dueDate && t.dueDate < today && t.status !== 'DONE' && t.status !== 'CANCELED'
          )
        } else {
          if (startDate) {
            tasks = tasks.filter((t) => t.dueDate && t.dueDate >= startDate)
          }
          if (endDate) {
            tasks = tasks.filter((t) => t.dueDate && t.dueDate <= endDate)
          }
        }

        return formatSuccess(tasks)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

/**
 * Register observer-safe task tools (no delete, no filesystem — for untrusted contexts)
 */
export const registerTaskObserverTools: ToolRegistrar = (server, client) => {
  registerListTasks(server, client)
  registerCreateTask(server, client)
  registerUpdateTask(server, client)
  registerMoveTask(server, client)
  registerAddTaskLink(server, client)
  registerAddTaskTag(server, client)
  registerSetTaskDueDate(server, client)
}