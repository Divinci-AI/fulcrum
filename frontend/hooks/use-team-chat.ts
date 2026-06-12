/**
 * Team chat data layer. History comes from GET /api/team-chat; live
 * messages are appended into the same query caches by the WS handler in
 * use-task-sync.tsx, so consumers just read the query.
 *
 * Two cache families: ['team-chat'] for the tenant channel, and
 * ['dm', <peerUserId>] for each 1:1 thread. Unread counters mirror that:
 * ['team-chat-unread'] (number) and ['dm-unread'] (peerId → count).
 */
import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'
import type { TeamChatMessage } from './use-task-sync'

export type { TeamChatMessage }

function cacheKey(peerId?: string | null): readonly unknown[] {
  return peerId ? ['dm', peerId] : ['team-chat']
}

/** Channel history, or — with `peerId` — the 1:1 thread with that user. */
export function useTeamMessages(peerId?: string | null) {
  return useQuery({
    queryKey: cacheKey(peerId),
    queryFn: () =>
      fetchJSON<{ messages: TeamChatMessage[] }>(
        `/api/team-chat?limit=100${peerId ? `&with=${encodeURIComponent(peerId)}` : ''}`
      ).then((r) => r.messages),
    // WS keeps this fresh; avoid clobbering appended messages with refetches.
    staleTime: 5 * 60 * 1000,
  })
}

export function useSendTeamMessage(peerId?: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: string) =>
      fetchJSON<TeamChatMessage>('/api/team-chat', {
        method: 'POST',
        body: JSON.stringify({ body, ...(peerId ? { recipientUserId: peerId } : {}) }),
      }),
    onSuccess: (msg) => {
      // The WS broadcast also delivers this message (dedup by id in the
      // sync handler) — set it here too so the sender sees it instantly
      // even if the socket is reconnecting.
      queryClient.setQueryData<TeamChatMessage[]>([...cacheKey(peerId)], (old) => {
        if (!old) return [msg]
        if (old.some((m) => m.id === msg.id)) return old
        return [...old, msg]
      })
    },
  })
}

export function useDeleteTeamMessage(peerId?: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => fetchJSON(`/api/team-chat/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<TeamChatMessage[]>([...cacheKey(peerId)], (old) =>
        old ? old.filter((m) => m.id !== id) : old
      )
    },
  })
}

/** Unread count for the team channel (incremented by the WS handler,
 * reset by the Team tab when visible). */
export function useTeamChatUnread() {
  return useQuery({
    queryKey: ['team-chat-unread'],
    queryFn: () => 0,
    staleTime: Infinity,
    initialData: 0,
  })
}

export function useMarkTeamChatRead() {
  const queryClient = useQueryClient()
  return () => queryClient.setQueryData(['team-chat-unread'], 0)
}

/** Per-peer DM unread counts: { [peerUserId]: count }. */
export function useDmUnread() {
  return useQuery({
    queryKey: ['dm-unread'],
    queryFn: () => ({}) as Record<string, number>,
    staleTime: Infinity,
    initialData: {} as Record<string, number>,
  })
}

export function useMarkDmRead() {
  const queryClient = useQueryClient()
  return useCallback(
    (peerId: string) => {
      queryClient.setQueryData<Record<string, number>>(['dm-unread'], (m) =>
        m?.[peerId] ? { ...m, [peerId]: 0 } : (m ?? {})
      )
    },
    [queryClient]
  )
}

/** Online users roster (pushed by the server's presence:state events). */
export function usePresence() {
  return useQuery({
    queryKey: ['presence'],
    queryFn: () => [] as import('./use-task-sync').PresenceUser[],
    staleTime: Infinity,
    initialData: [],
  })
}
