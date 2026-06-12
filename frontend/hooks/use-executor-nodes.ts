import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

export interface ExecutorNode {
  id: string
  name: string
  platform: string | null
  version: string | null
  lastSeenAt: string | null
  online: boolean
}

/** The caller's execution nodes (D-18). The executor:status WS event keys
 * a refetch via the ['executors'] query key (see use-task-sync). */
export function useExecutorNodes() {
  return useQuery({
    queryKey: ['executors'],
    queryFn: () => fetchJSON<{ nodes: ExecutorNode[] }>('/api/executors').then((r) => r.nodes),
    refetchInterval: 60_000,
  })
}
