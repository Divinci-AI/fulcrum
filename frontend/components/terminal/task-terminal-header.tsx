import { useRef, useState, useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  TaskDaily01Icon,
  FolderLibraryIcon,
  GitBranchIcon,
  Delete02Icon,
} from '@hugeicons/core-free-icons'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import { GitActionsButtons } from './git-actions-buttons'
import { TaskActionsDropdown } from './task-actions-dropdown'

import { DeleteTaskDialog } from '@/components/delete-task-dialog'
import { useUpdateTaskStatus } from '@/hooks/use-tasks'
import { useTaskAgentInstance } from '@/hooks/use-task-agent-instance'
import { useTasks } from '@/hooks/use-tasks'
import type { Task, TaskStatus } from '@/types'

const STATUS_LABELS: Record<TaskStatus, string> = {
  TO_DO: 'To Do',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  CANCELED: 'Canceled',
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  TO_DO: 'bg-status-todo/20 text-status-todo',
  IN_PROGRESS: 'bg-status-in-progress/20 text-status-in-progress',
  IN_REVIEW: 'bg-status-in-review/20 text-status-in-review',
  DONE: 'bg-status-done/20 text-status-done',
  CANCELED: 'bg-status-canceled/20 text-status-canceled',
}

interface TaskInfo {
  taskId: string
  repoId?: string
  repoName: string
  title: string
  repoPath: string
  worktreePath: string
  baseBranch: string
  branch: string | null
  prUrl?: string | null
  pinned?: boolean
}

interface TaskTerminalHeaderProps {
  taskInfo: TaskInfo
  terminalId: string
  terminalCwd?: string
  isMobile?: boolean
  sendInputToTerminal?: (terminalId: string, text: string) => void
}

const FULL_THRESHOLD = 600        // All elements visible
const MEDIUM_THRESHOLD = 450      // Hide project/CWD, keep git buttons inline
const HIDE_BADGE_THRESHOLD = 250  // Hide task status badge

export function TaskTerminalHeader({
  taskInfo,
  terminalId,
  terminalCwd,
  isMobile,
  sendInputToTerminal,
}: TaskTerminalHeaderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number>(Infinity)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const { data: tasks } = useTasks()
  const updateTaskStatus = useUpdateTaskStatus()
  const currentTask = tasks?.find((t) => t.id === taskInfo.taskId)
  const taskStatus: TaskStatus = currentTask?.status ?? 'IN_PROGRESS'
  const agentInstance = useTaskAgentInstance(taskInfo.taskId)

  // Use ResizeObserver to track container width
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  const isStandalone = !taskInfo.repoPath
  const showProjectAndCwd = containerWidth >= FULL_THRESHOLD && !isStandalone
  const showGitButtonsInline = containerWidth >= MEDIUM_THRESHOLD && !isMobile && !isStandalone
  const showBadge = containerWidth >= HIDE_BADGE_THRESHOLD

  // Build a partial Task object for DeleteTaskDialog
  const taskForDialog: Task = {
    id: taskInfo.taskId,
    title: taskInfo.title,
    worktreePath: taskInfo.worktreePath,
    pinned: taskInfo.pinned ?? false,
    // Required fields that aren't used by DeleteTaskDialog
    description: null,
    status: taskStatus,
    position: 0,
    repoPath: taskInfo.repoPath,
    repoName: taskInfo.repoName,
    baseBranch: taskInfo.baseBranch,
    branch: taskInfo.branch,
    prefix: null,
    viewState: null,
    prUrl: taskInfo.prUrl ?? null,
    startupScript: null,
    agent: 'claude',
    aiMode: null,
    agentOptions: null,
    opencodeModel: null,
    type: isStandalone ? 'scratch' : null,
    projectId: null,
    repositoryId: null,
    tags: [],
    startedAt: null,
    dueDate: null,
    timeEstimate: null,
    priority: null,
    recurrenceRule: null,
    recurrenceEndDate: null,
    recurrenceSourceTaskId: null,
    notes: null,
    assigneeUserId: null,
    assignee: null,
    approverUserId: null,
    acceptedAt: null,
    completedAt: null,
    createdAt: '',
    updatedAt: '',
  }

  return (
    <div
      ref={containerRef}
      className="flex shrink-0 items-center justify-between border-b border-border bg-card"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">
        {/* Task title - always visible, won't shrink */}
        <Link
          to="/tasks/$taskId"
          params={{ taskId: taskInfo.taskId }}
          className="flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10 max-w-[50%]"
        >
          <HugeiconsIcon icon={TaskDaily01Icon} size={12} strokeWidth={2} className="shrink-0" />
          <span className="truncate">{taskInfo.title}</span>
        </Link>

        {/* Repository name & CWD - only at widest sizes */}
        {showProjectAndCwd && (
          <>
            {taskInfo.repoId ? (
              <Link
                to="/repositories/$repoId"
                params={{ repoId: taskInfo.repoId }}
                className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground hover:text-primary"
              >
                <HugeiconsIcon icon={FolderLibraryIcon} size={12} strokeWidth={2} className="shrink-0" />
                <span className="truncate hover:underline">{taskInfo.repoName}</span>
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
                <HugeiconsIcon icon={FolderLibraryIcon} size={12} strokeWidth={2} className="shrink-0" />
                <span className="truncate">{taskInfo.repoName}</span>
              </span>
            )}
            {terminalCwd && (
              <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <HugeiconsIcon icon={GitBranchIcon} size={12} strokeWidth={2} className="shrink-0" />
                <span className="truncate">{terminalCwd.split('/').pop()}</span>
              </span>
            )}
          </>
        )}

        {/* Right-side actions */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Agent-running indicator — real process detection, not just
              "a terminal exists" (use-task-agent-instance). */}
          {agentInstance && showBadge && (
            <span
              className="flex items-center gap-1 whitespace-nowrap rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400"
              title={`${agentInstance.agent} running (pid ${agentInstance.pid}, ${agentInstance.ramMB} MB)`}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
              {agentInstance.agent}
            </span>
          )}
          {/* Task status badge - visible until very narrow */}
          {showBadge && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLORS[taskStatus]} ${updateTaskStatus.isPending ? 'animate-pulse' : ''}`}
                  />
                }
              >
                {STATUS_LABELS[taskStatus]}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={taskStatus}
                  onValueChange={(newStatus) => {
                    const statusTasks = tasks?.filter((t) => t.status === newStatus) ?? []
                    updateTaskStatus.mutate({
                      taskId: taskInfo.taskId,
                      status: newStatus as TaskStatus,
                      position: statusTasks.length,
                    })
                  }}
                >
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Actions: delete for scratch, git buttons for worktree */}
          {isStandalone ? (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-5 w-5 text-muted-foreground hover:text-destructive"
                title="Delete task"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={2} />
              </Button>
              <DeleteTaskDialog
                task={taskForDialog}
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
              />
            </>
          ) : showGitButtonsInline ? (
            <>
              <GitActionsButtons
                repoPath={taskInfo.repoPath}
                worktreePath={taskInfo.worktreePath}
                baseBranch={taskInfo.baseBranch}
                taskId={taskInfo.taskId}
                title={taskInfo.title}
                prUrl={taskInfo.prUrl}
                isMobile={isMobile}
                terminalId={terminalId}
                sendInputToTerminal={sendInputToTerminal}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-5 w-5 text-muted-foreground hover:text-destructive"
                title="Delete task"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={2} />
              </Button>
              <DeleteTaskDialog
                task={taskForDialog}
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
              />
            </>
          ) : (
            <TaskActionsDropdown
              repoPath={taskInfo.repoPath}
              worktreePath={taskInfo.worktreePath}
              baseBranch={taskInfo.baseBranch}
              taskId={taskInfo.taskId}
              title={taskInfo.title}
              prUrl={taskInfo.prUrl}
              repoName={taskInfo.repoName}
              terminalId={terminalId}
              sendInputToTerminal={sendInputToTerminal}
              pinned={taskInfo.pinned}
            />
          )}
        </div>
      </div>
    </div>
  )
}
