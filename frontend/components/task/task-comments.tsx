import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DescriptionTextarea } from '@/components/ui/description-textarea'
import { useListUsers } from '@/hooks/use-users-admin'
import { useCurrentUser } from '@/hooks/use-current-user'
import {
  useTaskComments,
  useCreateTaskComment,
  useDeleteTaskComment,
} from '@/hooks/use-task-comments'
import type { TaskComment } from '@/types'
import { cn } from '@/lib/utils'

interface TaskCommentsProps {
  taskId: string
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

/**
 * Task comments — flat list, oldest first, with a new-comment form at the
 * bottom. The form reuses DescriptionTextarea, so @-mention autocomplete
 * (D-13 PR 2) just works.
 *
 * Authorship + author labels are rendered inline by looking up each
 * comment's authorUserId in the tenant user list (the same query the
 * Assignee picker and mention picker both consume).
 */
export function TaskComments({ taskId }: TaskCommentsProps) {
  const { data: comments } = useTaskComments(taskId)
  const { data: users } = useListUsers()
  const { data: currentUser } = useCurrentUser()
  const createComment = useCreateTaskComment(taskId)
  const deleteComment = useDeleteTaskComment(taskId)
  const [draft, setDraft] = useState('')

  const userLabel = (userId: string): string => {
    const u = users?.find((u) => u.id === userId)
    if (!u) return 'Unknown user'
    return u.displayName?.trim() || u.email
  }

  const handleSubmit = () => {
    const text = draft.trim()
    if (!text) return
    createComment.mutate(text, {
      onSuccess: () => setDraft(''),
    })
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground">Comments</h3>

      <div className="space-y-3">
        {comments?.length === 0 && (
          <div className="text-sm text-muted-foreground">No comments yet.</div>
        )}
        {comments?.map((c: TaskComment) => {
          const isMine = currentUser?.id === c.authorUserId
          return (
            <div key={c.id} className="rounded-md border p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{userLabel(c.authorUserId)}</span>
                  <span className="mx-1.5">·</span>
                  <span>{formatTimestamp(c.createdAt)}</span>
                </div>
                {isMine && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => deleteComment.mutate(c.id)}
                  >
                    Delete
                  </Button>
                )}
              </div>
              <div className="text-sm whitespace-pre-wrap">{c.body}</div>
            </div>
          )
        })}
      </div>

      <div className="space-y-2 pt-2 border-t">
        <DescriptionTextarea
          value={draft}
          onValueChange={setDraft}
          placeholder="Leave a comment… use @ to mention someone"
          rows={3}
          className={cn('text-sm')}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!draft.trim() || createComment.isPending}
          >
            {createComment.isPending ? 'Posting…' : 'Post Comment'}
          </Button>
        </div>
      </div>
    </div>
  )
}
