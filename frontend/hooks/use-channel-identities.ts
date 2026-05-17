/**
 * Per-user channel identity mappings (D-7 PR 3).
 *
 * Reads/writes the calling user's channel-native IDs (Slack user_id,
 * Discord snowflake, Telegram chat_id, WhatsApp phone JID). The
 * notification dispatcher will consult these in follow-up PRs to DM the
 * recipient via their own identity rather than the tenant-wide channel.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

export type ChannelType = 'slack' | 'discord' | 'telegram' | 'whatsapp'

export interface ChannelMapping {
  channelType: ChannelType
  channelUserId: string
  updatedAt: string
}

const QUERY_KEY = ['users', 'me', 'channel-identities'] as const

export function useMyChannelIdentities() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      fetchJSON<{ mappings: ChannelMapping[] }>('/api/users/me/channel-identities').then(
        (r) => r.mappings
      ),
  })
}

export function useUpsertChannelIdentity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { channelType: ChannelType; channelUserId: string }) =>
      fetchJSON<{ mapping: ChannelMapping }>(
        `/api/users/me/channel-identities/${vars.channelType}`,
        { method: 'PATCH', body: JSON.stringify({ channelUserId: vars.channelUserId }) }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}

export function useDeleteChannelIdentity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channelType: ChannelType) =>
      fetchJSON<{ success: boolean }>(
        `/api/users/me/channel-identities/${channelType}`,
        { method: 'DELETE' }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
