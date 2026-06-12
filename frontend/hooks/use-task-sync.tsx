import { useEffect, useRef, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useCurrentUser } from './use-current-user'
import { openTeamChat } from '@/lib/dm-bus'

interface TaskUpdatedMessage {
  type: 'task:updated'
  payload: { taskId: string }
}

interface NotificationMessage {
  type: 'notification'
  payload: {
    id: string
    title: string
    message: string
    notificationType: 'success' | 'info' | 'warning' | 'error'
    taskId?: string
    showToast?: boolean
    showDesktop?: boolean
    playSound?: boolean
    isCustomSound?: boolean
  }
}

// D-4 PR 2 social events. Server fans these out to sockets subscribed
// to `me` whose userId matches the targeted recipient — so receipt
// alone implies relevance.
interface TaskMentionedMessage {
  type: 'task:mentioned'
  payload: {
    taskId: string
    mentionedUserId: string
    authorEmail: string | null
    // D-13 PR 3: present when the mention came from a comment so callers
    // can deep-link or distinguish copy. Optional for back-compat.
    commentId?: string
  }
}

// D-13 PR 3: live updates for the comments list on the task panel.
interface TaskCommentAddedMessage {
  type: 'task:comment-added'
  payload: { taskId: string; commentId: string }
}
interface TaskCommentDeletedMessage {
  type: 'task:comment-deleted'
  payload: { taskId: string; commentId: string }
}
interface TaskAssignedMessage {
  type: 'task:assigned'
  payload: {
    taskId: string
    assigneeUserId: string | null
    previousAssigneeUserId: string | null
  }
}
interface ProjectMentionedMessage {
  type: 'project:mentioned'
  payload: { projectId: string; mentionedUserId: string; authorEmail: string | null }
}

interface ProjectUpdatedMessage {
  type: 'project:updated'
  payload: { projectId: string }
}

// Team chat fan-out. Channel messages (recipientUserId null) arrive via
// tenant-wide broadcast and land in the ['team-chat'] cache; DMs arrive
// participant-scoped and land in ['dm', <peerId>] keyed by the OTHER
// participant. Unread counters mirror that split.
export interface TeamChatMessage {
  id: string
  authorUserId: string
  authorEmail: string | null
  authorName: string | null
  recipientUserId?: string | null
  body: string
  createdAt: string
}
interface TeamMessageMessage {
  type: 'team:message'
  payload: TeamChatMessage
}
interface TeamMessageDeletedMessage {
  type: 'team:message-deleted'
  payload: { id: string; authorUserId?: string; recipientUserId?: string | null }
}
interface ChatMentionedMessage {
  type: 'chat:mentioned'
  payload: { messageId: string; mentionedUserId: string; authorEmail: string | null }
}

// Presence roster — full state on every change, cached under ['presence'].
export interface PresenceUser {
  userId: string
  email: string | null
  route: string | null
  lastActiveAt: string
}
interface PresenceStateMessage {
  type: 'presence:state'
  payload: { users: PresenceUser[] }
}

type ServerMessage =
  | TaskUpdatedMessage
  | NotificationMessage
  | TaskMentionedMessage
  | TaskAssignedMessage
  | ProjectMentionedMessage
  | ProjectUpdatedMessage
  | TaskCommentAddedMessage
  | TaskCommentDeletedMessage
  | TeamMessageMessage
  | TeamMessageDeletedMessage
  | ChatMentionedMessage
  | PresenceStateMessage
  | { type: string }

function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/terminal`
}

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_INTERVAL = 2000

export function useTaskSync() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: currentUser } = useCurrentUser()
  // Keep the userId in a ref so the message handler reads the latest value
  // without re-creating itself (and tearing the WS) every time the user
  // mutation hook resolves.
  const userIdRef = useRef<string | null>(null)
  userIdRef.current = currentUser?.id ?? null
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  const connectRef = useRef<(() => void) | undefined>(undefined)

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message: ServerMessage = JSON.parse(event.data)
        if (message.type === 'task:updated') {
          queryClient.invalidateQueries({ queryKey: ['tasks'] })
          queryClient.invalidateQueries({ queryKey: ['acls'] })
        } else if (message.type === 'project:updated') {
          // Teammates editing projects / members / visibility — refresh
          // project queries live across every connected client.
          queryClient.invalidateQueries({ queryKey: ['projects'] })
          queryClient.invalidateQueries({ queryKey: ['acls'] })
        } else if (message.type === 'presence:state' && 'payload' in message) {
          queryClient.setQueryData(
            ['presence'],
            (message as PresenceStateMessage).payload.users
          )
        } else if (message.type === 'team:message' && 'payload' in message) {
          const msg = (message as TeamMessageMessage).payload
          const me = userIdRef.current
          if (msg.recipientUserId) {
            // DM — keyed by the other participant. Receipt is already
            // participant-scoped server-side.
            const peer = msg.authorUserId === me ? msg.recipientUserId : msg.authorUserId
            queryClient.setQueryData<TeamChatMessage[]>(['dm', peer], (old) => {
              if (!old) return [msg]
              if (old.some((m) => m.id === msg.id)) return old
              return [...old, msg]
            })
            if (msg.authorUserId !== me) {
              queryClient.setQueryData<Record<string, number>>(['dm-unread'], (m) => ({
                ...(m ?? {}),
                [peer]: (m?.[peer] ?? 0) + 1,
              }))
            }
          } else {
            queryClient.setQueryData<TeamChatMessage[]>(['team-chat'], (old) => {
              if (!old) return [msg]
              if (old.some((m) => m.id === msg.id)) return old
              return [...old, msg]
            })
            // Unread counter for the floating-widget badge. The Team tab
            // resets this when visible; our own messages never count.
            if (msg.authorUserId !== me) {
              queryClient.setQueryData<number>(['team-chat-unread'], (n) => (n ?? 0) + 1)
            }
          }
        } else if (message.type === 'team:message-deleted' && 'payload' in message) {
          const { id, authorUserId, recipientUserId } = (message as TeamMessageDeletedMessage)
            .payload
          if (recipientUserId) {
            const me = userIdRef.current
            const peer = authorUserId === me ? recipientUserId : authorUserId
            if (peer) {
              queryClient.setQueryData<TeamChatMessage[]>(['dm', peer], (old) =>
                old ? old.filter((m) => m.id !== id) : old
              )
            }
          } else {
            queryClient.setQueryData<TeamChatMessage[]>(['team-chat'], (old) =>
              old ? old.filter((m) => m.id !== id) : old
            )
          }
        } else if (message.type === 'chat:mentioned' && 'payload' in message) {
          // Server already targeted this to us. Toast with a jump into the
          // team chat tab of the floating widget.
          const { authorEmail } = (message as ChatMentionedMessage).payload
          const by = authorEmail ? ` by ${authorEmail}` : ''
          toast.info(`You were mentioned in team chat${by}`, {
            action: { label: 'Open', onClick: () => openTeamChat() },
          })
        } else if (message.type === 'task:mentioned' && 'payload' in message) {
          // D-4 PR 3: server already filtered this to the right recipient
          // (us). Show a toast + invalidate tasks so the list reflects any
          // new mention state.
          const { taskId, authorEmail } = (message as TaskMentionedMessage).payload
          const by = authorEmail ? ` by ${authorEmail}` : ''
          toast.info(`You were mentioned${by}`, {
            description: 'Task',
            action: {
              label: 'View',
              onClick: () => navigate({ to: '/tasks/$taskId', params: { taskId } }),
            },
          })
          queryClient.invalidateQueries({ queryKey: ['tasks'] })
        } else if (message.type === 'project:mentioned' && 'payload' in message) {
          const { projectId, authorEmail } = (message as ProjectMentionedMessage).payload
          const by = authorEmail ? ` by ${authorEmail}` : ''
          toast.info(`You were mentioned${by}`, {
            description: 'Project',
            action: {
              label: 'View',
              onClick: () => navigate({ to: '/projects/$projectId', params: { projectId } }),
            },
          })
          queryClient.invalidateQueries({ queryKey: ['projects'] })
        } else if (
          (message.type === 'task:comment-added' || message.type === 'task:comment-deleted') &&
          'payload' in message
        ) {
          // D-13 PR 3: refresh the comments list when any session adds
          // or deletes a comment on this task. We don't toast — the
          // author already saw their action complete, and other viewers
          // get the live update silently.
          const { taskId } = (message as TaskCommentAddedMessage | TaskCommentDeletedMessage).payload
          queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'comments'] })
        } else if (message.type === 'task:assigned' && 'payload' in message) {
          // D-4 PR 3: distinguish "assigned to me" vs "unassigned from me".
          // The server delivers this event to both the previous and new
          // assignees; we compare against the current user's id to pick
          // the right toast copy.
          const { taskId, assigneeUserId, previousAssigneeUserId } = (
            message as TaskAssignedMessage
          ).payload
          const me = userIdRef.current
          const toView = {
            label: 'View',
            onClick: () => navigate({ to: '/tasks/$taskId', params: { taskId } }),
          }
          if (me && assigneeUserId === me) {
            toast.info('You were assigned a task', { action: toView })
          } else if (me && previousAssigneeUserId === me) {
            toast.info('You were unassigned from a task', { action: toView })
          }
          queryClient.invalidateQueries({ queryKey: ['tasks'] })
        } else if (message.type === 'notification' && 'payload' in message) {
          const { id, title, message: description, notificationType, taskId, showToast, showDesktop, playSound, isCustomSound } = (message as NotificationMessage).payload

          // Deduplicate notifications across tabs using localStorage
          // Use a claim mechanism similar to sound deduplication
          const NOTIFICATION_CLAIM_KEY = `fulcrum:notification:${id}`
          const CLAIM_SETTLE_MS = 50
          const CLAIM_TTL_MS = 10000 // Clean up old claims after 10s

          // Check if another tab already claimed this notification
          const existingClaim = localStorage.getItem(NOTIFICATION_CLAIM_KEY)
          if (existingClaim) {
            return // Another tab already showing this notification
          }

          // Make our claim
          const myClaim = `${Date.now()}:${Math.random().toString(36).slice(2)}`
          localStorage.setItem(NOTIFICATION_CLAIM_KEY, myClaim)

          // Wait for all tabs to write their claims, then check if we won
          setTimeout(() => {
            if (localStorage.getItem(NOTIFICATION_CLAIM_KEY) !== myClaim) {
              return // Another tab won the race
            }

            // Clean up claim after TTL
            setTimeout(() => localStorage.removeItem(NOTIFICATION_CLAIM_KEY), CLAIM_TTL_MS)

            // We won - show the notification
            showNotification()
          }, CLAIM_SETTLE_MS)

          function showNotification() {
            // Determine icon: goat if default sound enabled, otherwise logo
          const useGoat = playSound && !isCustomSound
          const iconUrl = useGoat ? '/goat.jpeg' : '/logo.png'

          // Show in-app toast if enabled (default: true for backward compatibility)
          if (showToast !== false) {
            // Create icon element for toast
            const icon = (
              <img
                src={iconUrl}
                alt=""
                className="size-8 shrink-0 aspect-square rounded-sm object-cover"
              />
            )

            // Build toast options with optional action for navigation
            const toastOptions: Parameters<typeof toast.success>[1] = {
              description,
              icon,
              ...(taskId && {
                action: {
                  label: 'View',
                  onClick: () => navigate({ to: '/tasks/$taskId', params: { taskId } }),
                },
              }),
            }

            // Show toast with custom icon and optional action
            switch (notificationType) {
              case 'success':
                toast.success(title, toastOptions)
                break
              case 'error':
                toast.error(title, toastOptions)
                break
              case 'warning':
                toast.warning(title, toastOptions)
                break
              case 'info':
              default:
                toast.info(title, toastOptions)
                break
            }
          }

          // Show browser notification if enabled (skip in iframe - desktop app handles natively)
          // Default: true for backward compatibility
          if (showDesktop !== false && 'Notification' in window && window.parent === window && Notification.permission === 'granted') {
            new Notification(title, {
              body: description,
              icon: iconUrl,
              tag: id,
            })
          }

          // Play notification sound if enabled
          // Try custom sound first (/api/uploads/sound), fall back to default
          // Use localStorage claim mechanism to prevent multiple tabs from playing
          if (playSound) {
            const SOUND_DEBOUNCE_MS = 1000
            const CLAIM_SETTLE_MS = 50
            const storageKey = 'fulcrum:lastSoundPlayed'
            const now = Date.now()

            // Parse existing claim (format: "timestamp:randomId")
            const existing = localStorage.getItem(storageKey)
            if (existing) {
              const ts = parseInt(existing.split(':')[0])
              if (now - ts < SOUND_DEBOUNCE_MS) {
                return // Recent play, skip
              }
            }

            // Make our claim with timestamp:randomId for uniqueness
            const myClaim = `${now}:${Math.random().toString(36).slice(2)}`
            localStorage.setItem(storageKey, myClaim)

            // Wait for all tabs to write their claims, then check if we won
            setTimeout(() => {
              if (localStorage.getItem(storageKey) !== myClaim) {
                return // Another tab won the race
              }

              // We won - play the sound
              let fellBack = false
              const playDefault = () => {
                if (fellBack) return
                fellBack = true
                const defaultAudio = new Audio('/sounds/goat-bleat.mp3')
                defaultAudio.play().catch(() => {})
              }
              const customAudio = new Audio('/api/uploads/sound')
              customAudio.onerror = playDefault
              customAudio.play().catch(playDefault)
            }, CLAIM_SETTLE_MS)
          }

          // Post to parent window for desktop native notifications
          if (window.parent !== window) {
            window.parent.postMessage(
              { type: 'fulcrum:notification', title, message: description, notificationType },
              '*'
            )
          }
          } // end showNotification
        }
      } catch {
        // Ignore parse errors
      }
    },
    [queryClient, navigate]
  )

  const connect = useCallback(() => {
    // Don't connect if already connected or connecting
    const ws = wsRef.current
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return
    }

    const url = getWsUrl()
    const newWs = new WebSocket(url)
    wsRef.current = newWs

    newWs.onopen = () => {
      reconnectAttemptsRef.current = 0
      // D-4 PR 3: subscribe to `me` so social events (mentions, assigns)
      // routed for the current user reach this socket. The server gates
      // each event by recipient userId; subscribing to `me` is the
      // client's opt-in for that fan-out.
      try {
        newWs.send(JSON.stringify({ type: 'subscribe', payload: { topics: ['me'] } }))
      } catch {
        // Best-effort; if the socket closed between open and here, the
        // reconnect path will re-subscribe on the next open.
      }
    }

    newWs.onmessage = handleMessage

    newWs.onclose = () => {
      if (wsRef.current === newWs) {
        wsRef.current = null
      }

      if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current++
        reconnectTimeoutRef.current = setTimeout(() => {
          connectRef.current?.()
        }, RECONNECT_INTERVAL)
      }
    }

    newWs.onerror = () => {}
  }, [handleMessage])

  // Keep connectRef in sync with connect
  connectRef.current = connect

  // Request browser notification permission on first load
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      const ws = wsRef.current
      if (ws) {
        // Don't close WebSocket if it's still connecting - this causes
        // "WebSocket is closed before the connection is established" errors in WebKit.
        // Let it naturally complete or fail, then it will close on its own.
        if (ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
        wsRef.current = null
      }
    }
  }, [connect])
}
