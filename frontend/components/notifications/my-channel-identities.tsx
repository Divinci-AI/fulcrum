/**
 * My Channel Identities (D-7 PR 3).
 *
 * One row per supported channel (Slack / Discord / Telegram / WhatsApp).
 * Users paste their channel-native ID so future per-user routing can DM
 * them via that identity instead of the tenant-wide channel.
 *
 * The per-channel dispatcher integrations are follow-up work — this UI
 * lets users register their IDs today so once the routing lands the data
 * is already in place.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { HugeiconsIcon } from '@hugeicons/react'
import { Delete02Icon, Loading03Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import {
  useMyChannelIdentities,
  useUpsertChannelIdentity,
  useDeleteChannelIdentity,
  type ChannelType,
} from '@/hooks/use-channel-identities'

interface ChannelMeta {
  type: ChannelType
  label: string
  placeholder: string
  help: string
}

const CHANNELS: ChannelMeta[] = [
  {
    type: 'slack',
    label: 'Slack',
    placeholder: 'U01ABC...',
    help: 'Your Slack member ID. Open your profile → "Copy member ID" (under the kebab menu).',
  },
  {
    type: 'discord',
    label: 'Discord',
    placeholder: '123456789012345678',
    help: 'Your Discord user ID (snowflake). Enable Developer Mode in Discord settings → right-click your name → Copy User ID.',
  },
  {
    type: 'telegram',
    label: 'Telegram',
    placeholder: '987654321',
    help: 'Your Telegram chat ID. Send /start to your Fulcrum bot, then the bot will report your chat_id in its logs.',
  },
  {
    type: 'whatsapp',
    label: 'WhatsApp',
    placeholder: '+15551234567@s.whatsapp.net',
    help: 'Your WhatsApp JID (phone number with the @s.whatsapp.net suffix).',
  },
]

export function MyChannelIdentities() {
  const { data: mappings, isLoading } = useMyChannelIdentities()
  const upsert = useUpsertChannelIdentity()
  const removeMapping = useDeleteChannelIdentity()
  const [drafts, setDrafts] = useState<Partial<Record<ChannelType, string>>>({})
  const [savingType, setSavingType] = useState<ChannelType | null>(null)

  const currentMappingOf = (type: ChannelType) =>
    mappings?.find((m) => m.channelType === type)

  const handleSave = async (type: ChannelType) => {
    const value = (drafts[type] ?? '').trim()
    if (!value) return
    setSavingType(type)
    try {
      await upsert.mutateAsync({ channelType: type, channelUserId: value })
      toast.success(`${type} identity saved`)
      setDrafts((d) => ({ ...d, [type]: '' }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingType(null)
    }
  }

  const handleClear = async (type: ChannelType) => {
    try {
      await removeMapping.mutateAsync(type)
      toast.success(`${type} identity cleared`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">My channel identities</h3>
        <p className="text-xs text-muted-foreground">
          Paste your channel-native IDs so notifications addressed to you can DM
          you directly. Per-channel routing into the dispatcher is a follow-up
          (one PR per platform). For now this is storage — your IDs are
          recorded but the dispatcher still uses the tenant-wide channel.
        </p>
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground">
          <HugeiconsIcon icon={Loading03Icon} className="inline mr-1 h-3 w-3 animate-spin" />
          Loading…
        </p>
      )}

      {CHANNELS.map((c) => {
        const current = currentMappingOf(c.type)
        const draft = drafts[c.type] ?? ''
        return (
          <div key={c.type} className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.label}</p>
                {current ? (
                  <p className="text-xs text-muted-foreground font-mono break-all">
                    {current.channelUserId}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Not configured.</p>
                )}
              </div>
              {current && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => handleClear(c.type)}
                  title="Clear"
                >
                  <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5 text-destructive" />
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{c.help}</p>
            <div className="flex gap-2">
              <Input
                value={draft}
                onChange={(e) => setDrafts((d) => ({ ...d, [c.type]: e.target.value }))}
                placeholder={c.placeholder}
                className="flex-1 font-mono text-sm"
              />
              <Button
                onClick={() => handleSave(c.type)}
                disabled={savingType === c.type || !draft.trim()}
                size="sm"
              >
                {savingType === c.type ? (
                  <HugeiconsIcon icon={Loading03Icon} className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <HugeiconsIcon icon={Tick02Icon} className="mr-1 h-3.5 w-3.5" />
                )}
                {current ? 'Update' : 'Save'}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
