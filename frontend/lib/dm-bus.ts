/**
 * Tiny cross-component event bus for opening the chat widget from anywhere
 * (e.g. clicking a teammate's avatar in the header opens a 1:1 DM thread
 * in the floating assistant widget). Window CustomEvents keep this free of
 * provider/state plumbing — the widget is a singleton portal anyway.
 */

export interface DmPeer {
  userId: string
  email: string | null
  name?: string | null
}

const OPEN_DM = 'fulcrum:open-dm'
const OPEN_TEAM_CHAT = 'fulcrum:open-team-chat'

/** Open the chat widget on the 1:1 thread with `peer`. */
export function openDm(peer: DmPeer): void {
  window.dispatchEvent(new CustomEvent<DmPeer>(OPEN_DM, { detail: peer }))
}

/** Open the chat widget on the team channel. */
export function openTeamChat(): void {
  window.dispatchEvent(new CustomEvent(OPEN_TEAM_CHAT))
}

/** Subscribe to both open events. Returns an unsubscribe fn. */
export function onChatOpenRequests(handlers: {
  onDm: (peer: DmPeer) => void
  onTeamChat: () => void
}): () => void {
  const dmListener = (e: Event) => handlers.onDm((e as CustomEvent<DmPeer>).detail)
  const teamListener = () => handlers.onTeamChat()
  window.addEventListener(OPEN_DM, dmListener)
  window.addEventListener(OPEN_TEAM_CHAT, teamListener)
  return () => {
    window.removeEventListener(OPEN_DM, dmListener)
    window.removeEventListener(OPEN_TEAM_CHAT, teamListener)
  }
}
