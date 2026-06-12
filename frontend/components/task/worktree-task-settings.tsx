import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { useInitializeScratchTask } from '@/hooks/use-tasks'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { fetchJSON } from '@/lib/api'
import { useExecutorNodes } from '@/hooks/use-executor-nodes'
import { useDefaultAgent } from '@/hooks/use-config'
import type { Task } from '@/types'
import { InitializeWorktreeTaskModal } from './initialize-worktree-task-modal'

interface WorktreeTaskSettingsProps {
  task: Task
  compact?: boolean
}

export function WorktreeTaskSettings({ task, compact }: WorktreeTaskSettingsProps) {
  const navigate = useNavigate()
  const { data: defaultAgent } = useDefaultAgent()
  const initializeScratch = useInitializeScratchTask()
  const [initializeModalOpen, setInitializeModalOpen] = useState(false)
  const queryClient = useQueryClient()
  // D-18 PR 3: initialize the worktree on one of the user's execution
  // nodes instead of this server. Needs a linked repository (the node
  // clones over its remote URL).
  const { data: executorNodes } = useExecutorNodes()
  const onlineNodes = (executorNodes ?? []).filter((n) => n.online)
  const initOnNode = useMutation({
    mutationFn: (nodeId: string) =>
      fetchJSON(`/api/tasks/${task.id}/initialize-on-node`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      toast.success('Worktree created on your execution node.')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to initialize on node'),
  })

  const handleInitializeScratch = () => {
    initializeScratch.mutate(
      { taskId: task.id, agent: defaultAgent || 'claude' },
      {
        onSuccess: (data) => {
          if (data) {
            navigate({ to: '/tasks/$taskId', params: { taskId: task.id } })
          }
        },
      }
    )
  }

  const paddingClass = compact ? 'p-3' : 'p-4'
  const marginClass = compact ? 'mb-2' : 'mb-3'
  const headingClass = compact ? 'text-xs' : 'text-sm'

  // Uninitialized scratch task — show initialize button directly
  if (task.type === 'scratch') {
    return (
      <div className={`rounded-lg border bg-card ${paddingClass}`}>
        <h2 className={`${headingClass} font-medium text-muted-foreground ${marginClass}`}>Scratch Task</h2>
        <Button
          variant="outline"
          onClick={handleInitializeScratch}
          disabled={initializeScratch.isPending}
          className="w-full"
          size={compact ? 'sm' : 'default'}
        >
          {initializeScratch.isPending ? 'Creating...' : 'Initialize Scratch Task'}
        </Button>
        <p className={`text-muted-foreground italic mt-2 ${compact ? 'text-xs' : 'text-sm'}`}>
          Creates an isolated directory without git for quick experiments.
        </p>
      </div>
    )
  }

  return (
    <div className={`rounded-lg border bg-card ${paddingClass}`}>
      <h2 className={`${headingClass} font-medium text-muted-foreground ${marginClass}`}>Initialize Task</h2>

      <Button
        onClick={() => setInitializeModalOpen(true)}
        className="w-full"
        size={compact ? 'sm' : 'default'}
      >
        Initialize as Worktree Task
      </Button>

      {task.type !== 'scratch' && task.type !== 'worktree' && (
        <>
          <div className="my-3 flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <Button
            variant="outline"
            onClick={handleInitializeScratch}
            disabled={initializeScratch.isPending}
            className="w-full"
            size={compact ? 'sm' : 'default'}
          >
            {initializeScratch.isPending ? 'Creating...' : 'Initialize as Scratch Task'}
          </Button>
          <p className={`text-muted-foreground italic mt-2 ${compact ? 'text-xs' : 'text-sm'}`}>
            Creates an isolated directory without git for quick experiments.
          </p>
        </>
      )}

      {task.repositoryId && onlineNodes.length > 0 && (
        <div className="mt-3 space-y-2">
          {onlineNodes.map((n) => (
            <Button
              key={n.id}
              variant="outline"
              onClick={() => initOnNode.mutate(n.id)}
              disabled={initOnNode.isPending}
              className="w-full"
              size={compact ? 'sm' : 'default'}
            >
              {initOnNode.isPending ? 'Initializing…' : `Initialize on ${n.name}`}
            </Button>
          ))}
          <p className={`text-muted-foreground italic ${compact ? 'text-xs' : 'text-sm'}`}>
            Clones the repo and creates the worktree on your machine; the agent runs there.
          </p>
        </div>
      )}

      <InitializeWorktreeTaskModal
        task={task}
        open={initializeModalOpen}
        onOpenChange={setInitializeModalOpen}
      />
    </div>
  )
}
