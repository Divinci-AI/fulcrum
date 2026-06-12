import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Send, Trash2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'
import { useCurrentUser } from '@/hooks/use-current-user'
import { useListUsers } from '@/hooks/use-users-admin'
import {
  useDeleteTeamMessage,
  useMarkDmRead,
  useMarkTeamChatRead,
  useSendTeamMessage,
  useTeamMessages,
  type TeamChatMessage,
} from '@/hooks/use-team-chat'
import { usePresence } from '@/hooks/use-team-chat'
import { findMentionTrigger, filterMentionUsers, MentionText } from '@/lib/mentions'
import { openDm, type DmPeer } from '@/lib/dm-bus'

function authorLabel(msg: TeamChatMessage): string {
  return msg.authorName?.trim() || msg.authorEmail || 'Unknown'
}

export function peerLabel(peer: DmPeer): string {
  return peer.name?.trim() || peer.email || 'Unknown'
}

interface TeamChatProps {
  /** When set, render the 1:1 DM thread with this user instead of the
   * team channel. */
  peer?: DmPeer | null
  /** Back-to-channel handler for the DM header. */
  onBack?: () => void
}

/**
 * Team chat tab body for the floating assistant widget. One tenant-wide
 * channel plus 1:1 DM threads; history via REST, live messages via the
 * shared task-sync WS. The composer supports `@mention` autocomplete
 * (same trigger semantics as the task description editor).
 */
export function TeamChat({ peer, onBack }: TeamChatProps) {
  const peerId = peer?.userId ?? null
  const { data: messages, isLoading } = useTeamMessages(peerId)
  const { data: presence } = usePresence()
  const { data: currentUser } = useCurrentUser()
  const { data: tenantUsers } = useListUsers()
  const sendMessage = useSendTeamMessage(peerId)
  const deleteMessage = useDeleteTeamMessage(peerId)
  const markRead = useMarkTeamChatRead()
  const markDmRead = useMarkDmRead()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Mention autocomplete state for the composer.
  const [mentionState, setMentionState] = useState<{ at: number; query: string } | null>(null)
  const [highlightIdx, setHighlightIdx] = useState(0)
  const mentionCandidates = useMemo(
    () =>
      mentionState && tenantUsers
        ? filterMentionUsers(
            tenantUsers.filter((u) => u.id !== currentUser?.id),
            mentionState.query
          )
        : [],
    [tenantUsers, mentionState, currentUser?.id]
  )
  useEffect(() => {
    setHighlightIdx(0)
  }, [mentionState?.query])

  // Visible tab == read.
  useEffect(() => {
    if (peerId) {
      markDmRead(peerId)
    } else {
      markRead()
    }
  }, [messages?.length, peerId, markRead, markDmRead])

  // Pin scroll to the latest message.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages?.length, peerId])

  // Focus composer when switching threads.
  useEffect(() => {
    inputRef.current?.focus()
  }, [peerId])

  const updateMentionState = () => {
    const ta = inputRef.current
    if (!ta) return
    setMentionState(findMentionTrigger(ta.value, ta.selectionStart ?? 0))
  }

  const insertMention = (user: { email: string }) => {
    if (!mentionState) return
    const ta = inputRef.current
    if (!ta) return
    const before = draft.slice(0, mentionState.at)
    const after = draft.slice(ta.selectionStart ?? 0)
    const replacement = `@${user.email} `
    setDraft(before + replacement + after)
    setMentionState(null)
    requestAnimationFrame(() => {
      const node = inputRef.current
      if (!node) return
      const pos = before.length + replacement.length
      node.setSelectionRange(pos, pos)
      node.focus()
    })
  }

  const handleSend = () => {
    const body = draft.trim()
    if (!body || sendMessage.isPending) return
    sendMessage.mutate(body, { onSuccess: () => setDraft('') })
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIdx((i) => (i + 1) % mentionCandidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(mentionCandidates[highlightIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionState(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const others = (presence ?? []).filter((u) => u.userId !== currentUser?.id)
  const peerOnline = peerId ? others.some((u) => u.userId === peerId) : false

  return (
    <div className="flex flex-col min-h-0">
      {/* DM header / online roster strip */}
      {peer ? (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] border-b border-border/50">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="Back to team channel"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
          <div
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              peerOnline ? 'bg-green-500' : 'bg-muted-foreground/40'
            )}
          />
          <span className="font-medium text-foreground">{peerLabel(peer)}</span>
          <span className="text-muted-foreground">{peerOnline ? 'online' : 'offline'}</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] text-muted-foreground border-b border-border/50">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
          <span>
            {others.length === 0 ? (
              'Just you here'
            ) : (
              <>
                {others.length} online:{' '}
                {others.slice(0, 5).map((u, i) => (
                  <button
                    key={u.userId}
                    onClick={() =>
                      openDm({ userId: u.userId, email: u.email, name: null })
                    }
                    className="hover:text-accent hover:underline transition-colors"
                    title={`Message ${u.email ?? 'user'}`}
                  >
                    {u.email?.split('@')[0] ?? 'someone'}
                    {i < Math.min(others.length, 5) - 1 ? ', ' : ''}
                  </button>
                ))}
              </>
            )}
          </span>
        </div>
      )}

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
            {peer
              ? `No messages yet — say hi to ${peerLabel(peer)}.`
              : 'No messages yet — say hi to your team.'}
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
                  <MentionText text={msg.body} />
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
      <div className="relative flex items-end gap-2 px-4 py-3 border-t border-border/50">
        {mentionState && mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 z-50 mb-1 rounded-md border bg-popover p-1 shadow-md">
            <div className="px-2 py-1 text-[10px] text-muted-foreground">
              Mention a user — ↑↓ to navigate, Enter to select
            </div>
            <div className="max-h-40 overflow-y-auto">
              {mentionCandidates.map((u, idx) => (
                <button
                  key={u.id}
                  type="button"
                  // mousedown not click so it fires before the textarea blur.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    insertMention(u)
                  }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  className={cn(
                    'w-full text-left px-2 py-1 rounded text-xs',
                    idx === highlightIdx ? 'bg-accent/20' : 'hover:bg-accent/10'
                  )}
                >
                  <span>{u.displayName?.trim() || u.email}</span>
                  {u.displayName?.trim() && (
                    <span className="ml-2 text-[10px] text-muted-foreground">{u.email}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            requestAnimationFrame(updateMentionState)
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={updateMentionState}
          onClick={updateMentionState}
          onBlur={() => setTimeout(() => setMentionState(null), 150)}
          placeholder={peer ? `Message ${peerLabel(peer)}…` : 'Message your team… (@ to mention)'}
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
