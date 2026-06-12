import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

interface AgentInstance {
  pid: number
  agent: string
  taskId: string | null
  ramMB: number
  startedAt: string | null
}

/**
 * Is an agent process (claude/opencode/hermes) currently running inside
 * this task's worktree? Backed by /api/monitoring/claude-instances, which
 * walks Fulcrum-managed terminal process trees — so this reflects real
 * processes, not just "a terminal exists".
 */
export function useTaskAgentInstance(taskId: string | null) {
  const { data } = useQuery({
    queryKey: ['agent-instances'],
    queryFn: () => fetchJSON<AgentInstance[]>('/api/monitoring/claude-instances?filter=fulcrum'),
    refetchInterval: 15_000,
    enabled: !!taskId,
  })
  if (!taskId) return null
  return data?.find((i) => i.taskId === taskId) ?? null
}
