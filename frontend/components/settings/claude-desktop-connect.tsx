import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { fetchJSON } from '@/lib/api'

interface ClaudeDesktopStatus {
  installed: boolean
  configPath: string
  connected: boolean
  command: string | null
}

/**
 * One-click Claude Desktop ↔ Fulcrum MCP wiring. Writes/removes the
 * `fulcrum mcp` stdio entry in claude_desktop_config.json on the machine
 * running the server (i.e. meaningful on local/desktop installs).
 */
export function ClaudeDesktopConnect() {
  const queryClient = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['integrations', 'claude-desktop'],
    queryFn: () => fetchJSON<ClaudeDesktopStatus>('/api/integrations/claude-desktop'),
  })

  const act = useMutation({
    mutationFn: (action: 'connect' | 'disconnect') =>
      fetchJSON<ClaudeDesktopStatus>(`/api/integrations/claude-desktop/${action}`, {
        method: 'POST',
      }),
    onSuccess: (next, action) => {
      queryClient.setQueryData(['integrations', 'claude-desktop'], next)
      toast.success(
        action === 'connect'
          ? 'Fulcrum MCP added to Claude Desktop — restart Claude Desktop to pick it up.'
          : 'Fulcrum MCP removed from Claude Desktop.'
      )
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  if (!status) return null

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Claude Desktop</h3>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              status.connected
                ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${status.connected ? 'bg-green-500' : 'bg-muted-foreground/50'}`}
            />
            {status.connected ? 'Connected' : status.installed ? 'Not connected' : 'Not detected'}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground truncate">
          {status.connected
            ? `MCP entry installed (${status.command ?? 'fulcrum'} mcp)`
            : 'Give the Claude Desktop app access to Fulcrum tasks, projects, and tools via MCP.'}
        </p>
      </div>
      <Button
        variant={status.connected ? 'outline' : 'default'}
        size="sm"
        onClick={() => act.mutate(status.connected ? 'disconnect' : 'connect')}
        disabled={act.isPending}
      >
        {act.isPending ? 'Working…' : status.connected ? 'Disconnect' : 'Connect'}
      </Button>
    </div>
  )
}
