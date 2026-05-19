import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'
import type { TaskComment } from '@/types'

const commentsKey = (taskId: string) => ['tasks', taskId, 'comments'] as const

export function useTaskComments(taskId: string) {
  return useQuery({
    queryKey: commentsKey(taskId),
    queryFn: () =>
      fetchJSON<{ comments: TaskComment[] }>(`/api/tasks/${taskId}/comments`).then(
        (r) => r.comments
      ),
    enabled: !!taskId,
  })
}

export function useCreateTaskComment(taskId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: string) =>
      fetchJSON<{ comment: TaskComment }>(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }).then((r) => r.comment),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commentsKey(taskId) })
    },
  })
}

export function useDeleteTaskComment(taskId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (commentId: string) =>
      fetchJSON<{ success: boolean }>(`/api/tasks/${taskId}/comments/${commentId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commentsKey(taskId) })
    },
  })
}
