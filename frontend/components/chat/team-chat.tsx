import { useEffect, useRef, useState } from 'react'
import { Send, Trash2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'
import { useCurrentUser } from '@/hooks/use-current-user'
import {
  useDeleteTeamMessage,
  useMarkTeamChatRead,
  useSendTeamMessage,
  useTeamMessages,
  type TeamChatMessage,
} from '@/hooks/use-team-chat'
import { usePresence } from '@/hooks/use-team-chat'

function authorLabel(msg: TeamChatMessage): string {
  return msg.authorName?.trim() || msg.authorEmail || 'Unknown'
}

/**
 * Team chat tab body for the floating assistant widget. One tenant-wide
 * channel; history via REST, live messages via the shared task-sync WS.
 */
export function TeamChat() {
  const { data: messages, isLoading } = useTeamMessages()
  const { data: presence } = usePresence()
  const { data: currentUser } = useCurrentUser()
  const sendMessage = useSendTeamMessage()
  const deleteMessage = useDeleteTeamMessage()
  const markRead = useMarkTeamChatRead()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Visible team tab == read.
  useEffect(() => {
    markRead()
  }, [messages?.length, markRead])

  // Pin scroll to the latest message.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages?.length])

  const handleSend = () => {
    const body = draft.trim()
    if (!body || sendMessage.isPending) return
    sendMessage.mutate(body, { onSuccess: () => setDraft('') })
    inputRef.current?.focus()
  }

  const onlineCount = presence?.length ?? 0

  return (
    <div className="flex flex-col min-h-0">
      {/* Online roster strip */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] text-muted-foreground border-b border-border/50">
        <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
        <span>
          {onlineCount === 0
            ? 'Just you here'
            : `${onlineCount} online${
                onlineCount > 0
                  ? ': ' +
                    (presence ?? [])
                      .map((u) => u.email?.split('@')[0] ?? 'someone')
                      .slice(0, 5)
                      .join(', ')
                  : ''
              }`}
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="overflow-y-auto px-4 py-2 max-h-[330px] min-h-[120px] scrollbar-thin scrollbar-track-transparent scrollbar-thumb-muted"
      >
        {isLoading && (
          <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>
        )}
        {!isLoading && (messages?.length ?? 0) === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground italic">
            No messages yet — say hi to your team.
          </div>
        )}
        {(messages ?? []).map((msg, i) => {
          const prev = (messages ?? [])[i - 1]
          const sameAuthorRun = prev?.authorUserId === msg.authorUserId
          const isMine = msg.authorUserId === currentUser?.id
          return (
            <div key={msg.id} className={cn('group', sameAuthorRun ? 'mt-0.5' : 'mt-3')}>
              {!sameAuthorRun && (
                <div className="flex items-baseline gap-2">
                  <span className={cn('text-xs font-medium', isMine ? 'text-accent' : 'text-foreground')}>
                    {isMine ? 'You' : authorLabel(msg)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                  </span>
                </div>
              )}
              <div className="flex items-start gap-1">
                <p className="flex-1 text-sm whitespace-pre-wrap break-words text-foreground/90">
                  {msg.body}
                </p>
                {isMine && (
                  <button
                    onClick={() => deleteMessage.mutate(msg.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-destructive transition-opacity"
                    title="Delete message"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Input */}
      <div className="flex items-end gap-2 px-4 py-3 border-t border-border/50">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="Message your team…"
          rows={1}
          className="flex-1 resize-none rounded-lg bg-muted/60 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-accent/50 max-h-24"
        />
        <button
          onClick={handleSend}
          disabled={!draft.trim() || sendMessage.isPending}
          className="p-2 rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40 transition-colors"
          title="Send"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
