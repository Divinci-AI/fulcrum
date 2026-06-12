import { useDmUnread, usePresence } from '@/hooks/use-team-chat'
import { useCurrentUser } from '@/hooks/use-current-user'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openDm } from '@/lib/dm-bus'

const MAX_AVATARS = 5

function initials(email: string | null): string {
  if (!email) return '?'
  const name = email.split('@')[0]
  const parts = name.split(/[._-]/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function routeLabel(route: string | null): string {
  if (!route || route === '/') return 'Home'
  const segments = route.split('/').filter(Boolean)
  if (segments.length === 1) return segments[0][0].toUpperCase() + segments[0].slice(1)
  // e.g. /tasks/<id> → "a task", /projects/<id> → "a project"
  const noun = segments[0].replace(/s$/, '')
  return `a ${noun}`
}

/**
 * Header avatar stack: who's connected right now and what they're looking
 * at. Fed by the presence:state WS events (see use-task-sync), so it
 * updates live as teammates arrive, leave, and navigate. Clicking an
 * avatar opens a 1:1 DM thread with that user in the chat widget.
 */
export function OnlineUsers() {
  const { data: presence } = usePresence()
  const { data: currentUser } = useCurrentUser()
  const { data: dmUnread } = useDmUnread()

  const others = (presence ?? []).filter((u) => u.userId !== currentUser?.id)
  if (others.length === 0) return null

  const shown = others.slice(0, MAX_AVATARS)
  const overflow = others.length - shown.length

  return (
    <div className="hidden md:flex items-center -space-x-1.5 mr-1">
      {shown.map((u) => {
        const unread = dmUnread?.[u.userId] ?? 0
        return (
          <Tooltip key={u.userId}>
            <TooltipTrigger
              onClick={() => openDm({ userId: u.userId, email: u.email, name: null })}
              className="relative w-6 h-6 rounded-full bg-accent/20 border border-background flex items-center justify-center text-[9px] font-semibold text-accent cursor-pointer hover:bg-accent/30 transition-colors"
            >
              {initials(u.email)}
              <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 border border-background" />
              {unread > 0 && (
                <div className="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 rounded-full bg-red-500 text-white text-[8px] font-bold flex items-center justify-center border border-background">
                  {unread > 9 ? '9+' : unread}
                </div>
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {u.email ?? 'Unknown'} — viewing {routeLabel(u.route)}. Click to chat.
            </TooltipContent>
          </Tooltip>
        )
      })}
      {overflow > 0 && (
        <div className="w-6 h-6 rounded-full bg-muted border border-background flex items-center justify-center text-[9px] font-medium text-muted-foreground">
          +{overflow}
        </div>
      )}
    </div>
  )
}
