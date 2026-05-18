/**
 * Self-managed API tokens (D-8 PR 3a).
 *
 * Mint, list, revoke. The plaintext is shown ONCE on mint inside a
 * dismissible banner — copy it now or it's lost. Subsequent views show
 * only the prefix (`fulc_AbCdEfGh…`) plus the row's lifecycle metadata.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Copy01Icon,
  Delete02Icon,
  Loading03Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import {
  useMintApiToken,
  useMyApiTokens,
  useRevokeApiToken,
  type ApiTokenView,
  type MintedToken,
} from '@/hooks/use-api-tokens'

function formatTimestamp(value: string | null): string {
  if (!value) return 'never'
  const d = new Date(value)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function MyApiTokens() {
  const { data: tokens, isLoading } = useMyApiTokens()
  const mint = useMintApiToken()
  const revoke = useRevokeApiToken()

  const [name, setName] = useState('')
  const [justMinted, setJustMinted] = useState<MintedToken | null>(null)

  const handleMint = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const result = await mint.mutateAsync({ name: trimmed })
      setJustMinted(result)
      setName('')
      toast.success(`Token "${result.name}" minted — copy it before dismissing.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRevoke = async (t: ApiTokenView) => {
    try {
      await revoke.mutateAsync(t.id)
      toast.success(`Token "${t.name}" revoked`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCopy = async (plaintext: string) => {
    try {
      await navigator.clipboard.writeText(plaintext)
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Clipboard unavailable — select and copy manually')
    }
  }

  const sorted = [...(tokens ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">My API tokens</h3>
        <p className="text-xs text-muted-foreground">
          Bearer tokens for the <code>fulcrum</code> CLI and any future
          API integration that needs to act as you. Tokens are shown once
          on mint — copy them immediately. After that, only the prefix is
          recoverable. Tokens take precedence over CF Access at the
          server, so a CLI request authed with your token resolves to you
          regardless of which gateway identity carried the request.
        </p>
      </div>

      {justMinted && (
        <div className="border rounded-lg p-3 space-y-2 bg-amber-500/10 border-amber-500/30">
          <p className="text-sm font-medium">
            Copy this token now — it will not be shown again.
          </p>
          <div className="flex gap-2">
            <Input
              value={justMinted.plaintext}
              readOnly
              className="flex-1 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              size="sm"
              onClick={() => handleCopy(justMinted.plaintext)}
            >
              <HugeiconsIcon icon={Copy01Icon} className="mr-1 h-3.5 w-3.5" />
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setJustMinted(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="border rounded-lg p-3 space-y-3">
        <p className="text-sm font-medium">Mint a new token</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="laptop-cli"
            className="flex-1 font-mono text-sm"
          />
          <Button
            onClick={handleMint}
            disabled={mint.isPending || !name.trim()}
            size="sm"
          >
            {mint.isPending ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                className="mr-1 h-3.5 w-3.5 animate-spin"
              />
            ) : (
              <HugeiconsIcon icon={PlusSignIcon} className="mr-1 h-3.5 w-3.5" />
            )}
            Mint
          </Button>
        </div>
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground">
          <HugeiconsIcon
            icon={Loading03Icon}
            className="inline mr-1 h-3 w-3 animate-spin"
          />
          Loading…
        </p>
      )}

      <div className="border rounded-lg divide-y">
        {sorted.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{t.name}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">
                {t.prefix}…
              </p>
              <p className="text-[11px] text-muted-foreground">
                minted {formatTimestamp(t.createdAt)} · last used{' '}
                {formatTimestamp(t.lastUsedAt)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => handleRevoke(t)}
              title="Revoke"
            >
              <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        ))}
        {!isLoading && sorted.length === 0 && (
          <p className="text-xs text-muted-foreground p-3">No tokens yet.</p>
        )}
      </div>
    </div>
  )
}
