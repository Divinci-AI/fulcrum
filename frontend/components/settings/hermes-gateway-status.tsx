import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

interface HermesStatus {
  configured: boolean
  reachable: boolean
  model?: string | null
}

/** Live health indicator for the local `hermes gateway` endpoint. */
export function HermesGatewayStatus() {
  const { data } = useQuery({
    queryKey: ['assistant', 'hermes-status'],
    queryFn: () => fetchJSON<HermesStatus>('/api/assistant/hermes-status'),
    refetchInterval: 30_000,
  })

  if (!data) return null

  const { configured, reachable } = data
  const color = !configured ? 'bg-muted-foreground/50' : reachable ? 'bg-green-500' : 'bg-red-500'
  const label = !configured
    ? 'Not configured'
    : reachable
      ? `Gateway reachable${data.model ? ` (${data.model})` : ''}`
      : 'Gateway unreachable — is `hermes gateway` running?'

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
      <span>{label}</span>
    </div>
  )
}
