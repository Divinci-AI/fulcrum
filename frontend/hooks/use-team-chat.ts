/**
 * Team chat data layer. History comes from GET /api/team-chat; live
 * messages are appended into the same ['team-chat'] cache by the WS
 * handler in use-task-sync.tsx, so consumers just read the query.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'
import type { TeamChatMessage } from './use-task-sync'

export type { TeamChatMessage }

export function useTeamMessages() {
  return useQuery({
    queryKey: ['team-chat'],
    queryFn: () =>
      fetchJSON<{ messages: TeamChatMessage[] }>('/api/team-chat?limit=100').then(
        (r) => r.messages
      ),
    // WS keeps this fresh; avoid clobbering appended messages with refetches.
    staleTime: 5 * 60 * 1000,
  })
}

export function useSendTeamMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: string) =>
      fetchJSON<TeamChatMessage>('/api/team-chat', {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: (msg) => {
      // The WS broadcast also delivers this message (dedup by id in the
      // sync handler) — set it here too so the sender sees it instantly
      // even if the socket is reconnecting.
      queryClient.setQueryData<TeamChatMessage[]>(['team-chat'], (old) => {
        if (!old) return [msg]
        if (old.some((m) => m.id === msg.id)) return old
        return [...old, msg]
      })
    },
  })
}

export function useDeleteTeamMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => fetchJSON(`/api/team-chat/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<TeamChatMessage[]>(['team-chat'], (old) =>
        old ? old.filter((m) => m.id !== id) : old
      )
    },
  })
}

/** Unread count for the floating-widget badge (incremented by the WS
 * handler, reset by the Team tab when visible). */
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

/** Online users roster (pushed by the server's presence:state events). */
export function usePresence() {
  return useQuery({
    queryKey: ['presence'],
    queryFn: () => [] as import('./use-task-sync').PresenceUser[],
    staleTime: Infinity,
    initialData: [],
  })
}
