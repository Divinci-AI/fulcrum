import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTasks } from '@/hooks/use-tasks'
import { useProjects } from '@/hooks/use-projects'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'
import { HugeiconsIcon } from '@hugeicons/react'
import { Search01Icon, Tick02Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import type { Task, TaskStatus } from '@/types'

type ArchiveStatusFilter = 'all' | 'DONE' | 'CANCELED'

interface ArchiveSearch {
  status?: ArchiveStatusFilter
  project?: string
  q?: string
}

export const Route = createFileRoute('/archive/')({
  validateSearch: (search: Record<string, unknown>): ArchiveSearch => ({
    status: (search.status as ArchiveStatusFilter) ?? 'all',
    project: typeof search.project === 'string' ? search.project : undefined,
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
  component: ArchiveView,
})

function formatCompletedAt(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

function StatusPill({ status }: { status: TaskStatus }) {
  const isDone = status === 'DONE'
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-xs gap-1',
        isDone
          ? 'border-emerald-500/40 text-emerald-500 bg-emerald-500/10'
          : 'border-muted-foreground/30 text-muted-foreground bg-muted/40'
      )}
    >
      <HugeiconsIcon icon={isDone ? Tick02Icon : Cancel01Icon} size={12} strokeWidth={2.5} />
      {isDone ? 'Done' : 'Canceled'}
    </Badge>
  )
}

function ArchiveView() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const { data: tasks, isLoading } = useTasks()
  const { data: projects } = useProjects()
  const [searchInput, setSearchInput] = useState(search.q ?? '')

  const projectsById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects ?? []) map.set(p.id, p.name)
    return map
  }, [projects])

  const filtered = useMemo(() => {
    if (!tasks) return []
    const q = (search.q ?? '').trim().toLowerCase()
    const statusFilter = search.status ?? 'all'
    const projectFilter = search.project

    return tasks
      .filter((t) => t.status === 'DONE' || t.status === 'CANCELED')
      .filter((t) => (statusFilter === 'all' ? true : t.status === statusFilter))
      .filter((t) => {
        if (!projectFilter) return true
        if (projectFilter === 'inbox') return t.projectId === null
        return t.projectId === projectFilter
      })
      .filter((t) => {
        if (!q) return true
        return (
          t.title.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q) ||
          (t.notes ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => {
        // completedAt DESC, NULLs last
        const ac = a.completedAt ?? ''
        const bc = b.completedAt ?? ''
        if (!ac && !bc) return 0
        if (!ac) return 1
        if (!bc) return -1
        return bc.localeCompare(ac)
      })
  }, [tasks, search.q, search.status, search.project])

  const counts = useMemo(() => {
    const terminal = (tasks ?? []).filter(
      (t) => t.status === 'DONE' || t.status === 'CANCELED'
    )
    return {
      all: terminal.length,
      done: terminal.filter((t) => t.status === 'DONE').length,
      canceled: terminal.filter((t) => t.status === 'CANCELED').length,
    }
  }, [tasks])

  const updateSearch = (patch: Partial<ArchiveSearch>) => {
    navigate({
      to: '/archive',
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b space-y-3">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold">Archive</h1>
            <p className="text-sm text-muted-foreground">
              Completed and canceled tasks, newest first. {counts.all} total — {counts.done} done, {counts.canceled} canceled.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <HugeiconsIcon
              icon={Search01Icon}
              size={14}
              strokeWidth={2}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              placeholder="Search title, description, notes…"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value)
                updateSearch({ q: e.target.value || undefined })
              }}
              className="pl-9 h-9"
            />
          </div>

          <ToggleGroup
            value={[search.status ?? 'all']}
            onValueChange={(v) => {
              const selected = Array.isArray(v) ? v[0] : v
              if (!selected) return
              updateSearch({ status: selected as ArchiveStatusFilter })
            }}
            size="sm"
            variant="outline"
          >
            <ToggleGroupItem value="all">All ({counts.all})</ToggleGroupItem>
            <ToggleGroupItem value="DONE">Done ({counts.done})</ToggleGroupItem>
            <ToggleGroupItem value="CANCELED">Canceled ({counts.canceled})</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && (
          <div className="text-sm text-muted-foreground text-center py-8">Loading archive…</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-12 border rounded-lg">
            No archived tasks match the current filters.
          </div>
        )}
        <ul className="space-y-2">
          {filtered.map((task) => (
            <li key={task.id}>
              <ArchiveRow
                task={task}
                projectName={task.projectId ? projectsById.get(task.projectId) ?? null : null}
                onClick={() => navigate({ to: '/tasks/$taskId', params: { taskId: task.id } })}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function ArchiveRow({
  task,
  projectName,
  onClick,
}: {
  task: Task
  projectName: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-lg border bg-card p-3 hover:bg-accent transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill status={task.status} />
            <div className="font-medium truncate">{task.title}</div>
          </div>
          {(task.description || task.tags?.length || projectName) && (
            <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
              {projectName && <span>{projectName}</span>}
              {task.tags?.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="text-xs text-muted-foreground whitespace-nowrap pt-0.5">
          {formatCompletedAt(task.completedAt)}
        </div>
      </div>
    </button>
  )
}
