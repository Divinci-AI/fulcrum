import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { fetchJSON } from '@/lib/api'

interface ExecutorNode {
  id: string
  name: string
  platform: string | null
  version: string | null
  lastSeenAt: string | null
  online: boolean
}

interface ConfigValue {
  key: string
  value: unknown
}

async function getConfig(key: string): Promise<unknown> {
  const r = await fetchJSON<ConfigValue>(`/api/config/${encodeURIComponent(key)}`)
  return r.value
}

async function putConfig(key: string, value: unknown): Promise<void> {
  await fetchJSON(`/api/config/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
}

/**
 * D-18 PR 1 settings surface, both directions:
 *  - "Execution nodes": machines registered against THIS instance
 *    (meaningful on the SaaS) — live online status via executor:status.
 *  - "Connect as executor": configure THIS instance to dial out to a
 *    remote Fulcrum (meaningful on the local/desktop instance).
 */
export function ExecutorSettings() {
  const queryClient = useQueryClient()

  const { data: nodes } = useQuery({
    queryKey: ['executors'],
    queryFn: () => fetchJSON<{ nodes: ExecutorNode[] }>('/api/executors').then((r) => r.nodes),
    refetchInterval: 30_000,
  })

  const { data: config } = useQuery({
    queryKey: ['executor-config'],
    queryFn: async () => ({
      enabled: (await getConfig('executor.enabled')) === true,
      remoteUrl: ((await getConfig('executor.remoteUrl')) as string | null) ?? '',
      // apiToken comes back redacted ('***') when set — treat as sentinel.
      apiToken: ((await getConfig('executor.apiToken')) as string | null) ?? '',
      nodeName: ((await getConfig('executor.nodeName')) as string | null) ?? '',
    }),
  })

  const [enabled, setEnabled] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [nodeName, setNodeName] = useState('')
  useEffect(() => {
    if (config) {
      setEnabled(config.enabled)
      setRemoteUrl(config.remoteUrl)
      setApiToken(config.apiToken)
      setNodeName(config.nodeName)
    }
  }, [config])

  const save = useMutation({
    mutationFn: async () => {
      await putConfig('executor.enabled', enabled)
      await putConfig('executor.remoteUrl', remoteUrl.trim() || null)
      if (apiToken && apiToken !== '***') {
        await putConfig('executor.apiToken', apiToken.trim() || null)
      }
      await putConfig('executor.nodeName', nodeName.trim() || null)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['executor-config'] })
      toast.success('Executor settings saved. Restart the server to apply.')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const forget = useMutation({
    mutationFn: (id: string) => fetchJSON(`/api/executors/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['executors'] }),
  })

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium">Execution nodes</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Your machines that run terminals and worktrees for tasks on this instance.
        </p>
      </div>

      <div className="space-y-1.5">
        {(nodes ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground italic">No nodes registered yet.</p>
        )}
        {(nodes ?? []).map((n) => (
          <div key={n.id} className="flex items-center gap-2 text-sm">
            <span className={`w-2 h-2 rounded-full ${n.online ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
            <span className="font-medium">{n.name}</span>
            <span className="text-xs text-muted-foreground">
              {n.platform ?? ''}
              {n.online
                ? ' · online'
                : n.lastSeenAt
                  ? ` · last seen ${formatDistanceToNow(new Date(n.lastSeenAt), { addSuffix: true })}`
                  : ''}
            </span>
            <button
              onClick={() => forget.mutate(n.id)}
              className="ml-auto text-xs text-muted-foreground hover:text-destructive"
            >
              Forget
            </button>
          </div>
        ))}
      </div>

      <div className="border-t pt-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm">Connect this instance as an executor</h4>
            <p className="text-xs text-muted-foreground">
              Dial out to a remote Fulcrum (e.g. your cloud tenant) and run its terminals here.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {enabled && (
          <div className="space-y-2">
            <Input
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://fulcrum-acme.divinci.ai"
              className="h-8 text-sm font-mono"
            />
            <Input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="fulc_… (mint at the remote's Settings → API Tokens)"
              className="h-8 text-sm font-mono"
            />
            <Input
              value={nodeName}
              onChange={(e) => setNodeName(e.target.value)}
              placeholder="Node name (defaults to hostname)"
              className="h-8 text-sm"
            />
          </div>
        )}

        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
