import { useState } from 'react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DescriptionTextarea } from '@/components/ui/description-textarea'
import MarkdownPreview from '@uiw/react-markdown-preview'
import { DatePickerPopover } from '@/components/ui/date-picker-popover'
import { TimeEstimatePicker } from '@/components/task/time-estimate-picker'
import { PriorityPicker } from '@/components/task/priority-picker'
import { AssigneePicker } from '@/components/task/assignee-picker'
import { LinksManager } from '@/components/task/links-manager'
import { DependencyManager } from '@/components/task/dependency-manager'
import { AttachmentsManager } from '@/components/task/attachments-manager'
import { TaskComments } from '@/components/task/task-comments'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDown01Icon, Cancel01Icon, GitPullRequestIcon, Link02Icon, Loading03Icon } from '@hugeicons/core-free-icons'
import { useAcceptTask, useUpdateTask } from '@/hooks/use-tasks'
import { useCurrentUser } from '@/hooks/use-current-user'
import { useAddTaskTag, useRemoveTaskTag } from '@/hooks/use-tags'
import { useBranches } from '@/hooks/use-filesystem'
import { useIsOverdue } from '@/hooks/use-date-utils'
import { openExternalUrl } from '@/lib/editor-url'
import type { Task, TaskPriority } from '@/types'

interface TaskDetailsPanelProps {
  task: Task
}

export function TaskDetailsPanel({ task }: TaskDetailsPanelProps) {
  const { resolvedTheme } = useTheme()
  const updateTask = useUpdateTask()
  const acceptTask = useAcceptTask()
  const { data: currentUser } = useCurrentUser()
  const addTaskTag = useAddTaskTag()
  const removeTaskTag = useRemoveTaskTag()
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState(task.title)
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [editedDescription, setEditedDescription] = useState(task.description || '')
  const [isEditingNotes, setIsEditingNotes] = useState(false)
  const [editedNotes, setEditedNotes] = useState(task.notes || '')
  const [tagInput, setTagInput] = useState('')
  const [deletingTags, setDeletingTags] = useState<Set<string>>(new Set())
  const [prUrlInput, setPrUrlInput] = useState(task.prUrl || '')
  const [isEditingPrUrl, setIsEditingPrUrl] = useState(false)
  const [assigneeText, setAssigneeText] = useState(task.assignee || '')
  // GitHub/git plumbing (PR link, base branch) lives behind this disclosure —
  // collapsed by default so day-to-day task editing never surfaces it.
  const [showAdvanced, setShowAdvanced] = useState(false)

  const isWorktreeTask = !!task.worktreePath
  const { data: branchData, isLoading: branchesLoading } = useBranches(isWorktreeTask ? (task.repoPath || null) : null)

  const handleSaveDescription = () => {
    if (editedDescription !== (task.description || '')) {
      updateTask.mutate({
        taskId: task.id,
        updates: { description: editedDescription || null },
      })
    }
    setIsEditingDescription(false)
  }

  const handleSaveNotes = () => {
    if (editedNotes !== (task.notes || '')) {
      updateTask.mutate({
        taskId: task.id,
        updates: { notes: editedNotes || null } as Partial<Task>,
      })
    }
    setIsEditingNotes(false)
  }

  const handleDueDateChange = (date: string | null) => {
    updateTask.mutate({
      taskId: task.id,
      updates: { dueDate: date } as Partial<Task>,
    })
  }

  const handleTimeEstimateChange = (value: number | null) => {
    updateTask.mutate({
      taskId: task.id,
      updates: { timeEstimate: value },
    })
  }

  const handlePriorityChange = (value: TaskPriority | null) => {
    updateTask.mutate({
      taskId: task.id,
      updates: { priority: value },
    })
  }

  const handleAssigneeChange = (userId: string | null) => {
    updateTask.mutate({
      taskId: task.id,
      updates: { assigneeUserId: userId },
    })
  }

  const handleApproverChange = (userId: string | null) => {
    updateTask.mutate({
      taskId: task.id,
      updates: { approverUserId: userId },
    })
  }

  const handleAssigneeTextBlur = () => {
    const trimmed = assigneeText.trim()
    const next = trimmed === '' ? null : trimmed
    if (next !== (task.assignee || null)) {
      updateTask.mutate({
        taskId: task.id,
        updates: { assignee: next },
      })
    }
  }

  const handleAddTag = () => {
    const trimmed = tagInput.trim()
    if (trimmed && !task.tags.includes(trimmed)) {
      addTaskTag.mutate({ taskId: task.id, tag: trimmed })
      setTagInput('')
    }
  }

  const handleRemoveTag = (tag: string) => {
    setDeletingTags((prev) => new Set(prev).add(tag))
    removeTaskTag.mutate({ taskId: task.id, tag })
  }

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddTag()
    }
  }

  const handleSavePrUrl = () => {
    const trimmed = prUrlInput.trim()
    if (trimmed !== (task.prUrl || '')) {
      updateTask.mutate({
        taskId: task.id,
        updates: { prUrl: trimmed || null },
      })
    }
    setIsEditingPrUrl(false)
  }

  const handlePrUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSavePrUrl()
    } else if (e.key === 'Escape') {
      setPrUrlInput(task.prUrl || '')
      setIsEditingPrUrl(false)
    }
  }

  const handleBaseBranchChange = (newBranch: string | null) => {
    if (!newBranch) return
    updateTask.mutate({
      taskId: task.id,
      updates: { baseBranch: newBranch },
    })
  }

  const handlePinnedChange = (checked: boolean) => {
    updateTask.mutate({
      taskId: task.id,
      updates: { pinned: checked } as Partial<Task>,
    })
  }

  const handleSaveTitle = () => {
    const trimmedTitle = editedTitle.trim()
    if (trimmedTitle && trimmedTitle !== task.title) {
      updateTask.mutate({
        taskId: task.id,
        updates: { title: trimmedTitle },
      })
    }
    setIsEditingTitle(false)
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveTitle()
    } else if (e.key === 'Escape') {
      setEditedTitle(task.title)
      setIsEditingTitle(false)
    }
  }

  const isOverdue = useIsOverdue(task.dueDate, task.status)

  return (
    <div className="h-full overflow-auto p-4" style={{ background: 'var(--gradient-card)' }}>
      <div className="max-w-2xl space-y-4">
        {/* Title */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">Title</h3>
            {!isEditingTitle && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditedTitle(task.title)
                  setIsEditingTitle(true)
                }}
                className="text-xs h-7"
              >
                Edit
              </Button>
            )}
          </div>
          {isEditingTitle ? (
            <div className="space-y-2">
              <Input
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={handleSaveTitle}
                placeholder="Task title"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditedTitle(task.title)
                    setIsEditingTitle(false)
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveTitle}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <p
              className="text-sm font-medium cursor-pointer hover:text-primary transition-colors"
              onClick={() => {
                setEditedTitle(task.title)
                setIsEditingTitle(true)
              }}
              title="Click to edit title"
            >
              {task.title}
            </p>
          )}
        </div>

        {/* Description */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
            {!isEditingDescription && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditingDescription(true)}
                className="text-xs h-7"
              >
                Edit
              </Button>
            )}
          </div>
          {isEditingDescription ? (
            <div className="space-y-2">
              <DescriptionTextarea
                value={editedDescription}
                onValueChange={setEditedDescription}
                placeholder="Add a description..."
                rows={4}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditedDescription(task.description || '')
                    setIsEditingDescription(false)
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveDescription}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              data-color-mode={resolvedTheme === 'light' ? 'light' : 'dark'}
            >
              {task.description ? (
                <MarkdownPreview
                  source={task.description}
                  style={{ backgroundColor: 'transparent', fontSize: '14px' }}
                />
              ) : (
                <p className="text-sm text-muted-foreground italic">No description</p>
              )}
            </div>
          )}
        </div>

        {/* Tags, Due Date, and Estimate */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Tags */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {task.tags.map((tag) => {
                const isDeleting = deletingTags.has(tag)
                return (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      disabled={isDeleting}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <HugeiconsIcon icon={isDeleting ? Loading03Icon : Cancel01Icon} size={10} className={isDeleting ? 'animate-spin' : ''} />
                    </button>
                  </span>
                )
              })}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={handleAddTag}
                placeholder={task.tags.length === 0 ? 'Add tag...' : '+'}
                className="w-16 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Due Date */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Due Date</h3>
            <DatePickerPopover
              value={task.dueDate}
              onChange={handleDueDateChange}
              isOverdue={!!isOverdue}
            />
          </div>

          {/* Time Estimate */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Estimate</h3>
            <TimeEstimatePicker
              value={task.timeEstimate}
              onChange={handleTimeEstimateChange}
            />
          </div>

          {/* Priority */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Priority</h3>
            <PriorityPicker
              value={task.priority}
              onChange={handlePriorityChange}
            />
          </div>

          {/* Assignee (D-13 PR 1) */}
          <div className="rounded-lg border bg-card p-4 space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Assignee</h3>
            <AssigneePicker
              value={task.assigneeUserId}
              onChange={handleAssigneeChange}
            />
            <Input
              value={assigneeText}
              onChange={(e) => setAssigneeText(e.target.value)}
              onBlur={handleAssigneeTextBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              placeholder="Or free-text name (external collaborator, vendor, etc.)"
              className="text-sm"
            />
          </div>

          {/* Approver — who signs off that the task is satisfied */}
          <div className="rounded-lg border bg-card p-4 space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Approver</h3>
            <AssigneePicker
              value={task.approverUserId}
              onChange={handleApproverChange}
              placeholder="No approver"
            />
            {task.acceptedAt ? (
              <p className="text-xs text-muted-foreground">
                Accepted {new Date(task.acceptedAt).toLocaleString()}
              </p>
            ) : task.approverUserId && currentUser?.id === task.approverUserId &&
              task.status !== 'DONE' && task.status !== 'CANCELED' ? (
              <Button
                size="sm"
                onClick={() => acceptTask.mutate({ taskId: task.id })}
                disabled={acceptTask.isPending}
                className="w-full"
              >
                {acceptTask.isPending ? 'Accepting…' : 'Accept as satisfied'}
              </Button>
            ) : task.approverUserId ? (
              <p className="text-xs text-muted-foreground italic">Awaiting acceptance</p>
            ) : null}
          </div>
        </div>

        {/* Advanced — GitHub/git plumbing, only for code tasks */}
        {isWorktreeTask && (
          <div className="rounded-lg border bg-card">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center justify-between p-4 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <span>Advanced</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={16}
                className={showAdvanced ? 'transition-transform rotate-180' : 'transition-transform'}
              />
            </button>
            {showAdvanced && (
              <div className="space-y-4 px-4 pb-4">
        {/* Pull Request URL */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-muted-foreground">Pull Request</h3>
              {!isEditingPrUrl && task.prUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditingPrUrl(true)}
                  className="text-xs h-7"
                >
                  Edit
                </Button>
              )}
            </div>
            {isEditingPrUrl ? (
              <div className="flex gap-2">
                <Input
                  value={prUrlInput}
                  onChange={(e) => setPrUrlInput(e.target.value)}
                  onKeyDown={handlePrUrlKeyDown}
                  placeholder="https://github.com/owner/repo/pull/123"
                  className="flex-1"
                  autoFocus
                />
                <Button size="sm" onClick={handleSavePrUrl}>
                  Save
                </Button>
              </div>
            ) : task.prUrl ? (
              <button
                onClick={() => openExternalUrl(task.prUrl!)}
                className="flex items-center gap-2 text-sm text-primary hover:underline"
              >
                <HugeiconsIcon icon={GitPullRequestIcon} size={14} strokeWidth={2} />
                <span>#{task.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? 'PR'}</span>
                <HugeiconsIcon icon={Link02Icon} size={12} strokeWidth={2} className="text-muted-foreground" />
              </button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsEditingPrUrl(true)}
                className="text-xs"
              >
                Link PR
              </Button>
            )}
          </div>

        {/* Base Branch */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Base Branch</h3>
            <Select
              value={task.baseBranch || ''}
              onValueChange={handleBaseBranchChange}
              disabled={branchesLoading}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {task.baseBranch || (
                    <span className="text-muted-foreground">
                      {branchesLoading ? 'Loading branches...' : 'Select branch'}
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {branchData?.branches && branchData.branches.length > 0 && (
                  <SelectGroup>
                    {(branchData.remoteBranches?.length ?? 0) > 0 && <SelectLabel>Local</SelectLabel>}
                    {branchData.branches.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {(branchData?.remoteBranches?.length ?? 0) > 0 && (
                  <SelectGroup>
                    <SelectLabel>Remote</SelectLabel>
                    {branchData!.remoteBranches.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1.5">
              Used for diff comparisons, rebase, merge, and PR creation.
            </p>
          </div>
              </div>
            )}
          </div>
        )}

        {/* Pin Task */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <Checkbox
              id="pin-task"
              checked={task.pinned ?? false}
              onCheckedChange={handlePinnedChange}
            />
            <label htmlFor="pin-task" className="text-sm cursor-pointer">
              Pin task (show at top of lists)
            </label>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Pinned tasks appear first in their kanban column and calendar day list.
          </p>
        </div>

        {/* Dependencies */}
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Dependencies</h3>
          <DependencyManager taskId={task.id} />
        </div>

        {/* Links */}
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Links</h3>
          <LinksManager taskId={task.id} links={task.links || []} />
        </div>

        {/* Notes */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">Notes</h3>
            {!isEditingNotes && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditingNotes(true)}
                className="text-xs h-7"
              >
                Edit
              </Button>
            )}
          </div>
          {isEditingNotes ? (
            <div className="space-y-2">
              <textarea
                value={editedNotes}
                onChange={(e) => setEditedNotes(e.target.value)}
                placeholder="Add notes..."
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditedNotes(task.notes || '')
                    setIsEditingNotes(false)
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveNotes}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              {task.notes ? (
                <p className="whitespace-pre-wrap text-sm">{task.notes}</p>
              ) : (
                <p className="text-sm text-muted-foreground italic">No notes</p>
              )}
            </div>
          )}
        </div>

        {/* Attachments */}
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Attachments</h3>
          <AttachmentsManager taskId={task.id} />
        </div>

        {/* Comments (D-13 PR 3) */}
        <TaskComments taskId={task.id} />
      </div>
    </div>
  )
}
