import type { Context } from 'hono'
import type { WSContext, WSEvents } from 'hono/ws'
import type { ClientMessage, ServerMessage } from '../types'
import { getPTYManager } from '../terminal/pty-instance'
import { getTabManager } from '../terminal/tab-manager'
import { getWorktreeBasePath, getSettings, updateSettingByPath } from '../lib/settings'
import { log } from '../lib/logger'
import { anyTopicMatches } from './topic-matcher'
import type { CurrentUserContext } from '../middleware/current-user'

interface ClientData {
  id: string
  attachedTerminals: Set<string>
  // D-4: identity tagged at connect time. null when no CF Access header was
  // present and no FULCRUM_DEV_USER_EMAIL fallback was set. Anonymous sockets
  // still receive everything via `broadcast()` (legacy blast-to-all) but can't
  // receive `me`-targeted events from `broadcastToTopic`.
  userId: string | null
  userEmail: string | null
  // D-4: topics this socket has subscribed to. Empty by default —
  // subscribers explicitly opt in via the `subscribe` ClientMessage.
  subscriptions: Set<string>
}

// Store client data keyed by WSContext
const clients = new Map<WSContext, ClientData>()

export function broadcast(message: ServerMessage): void {
  const json = JSON.stringify(message)
  for (const ws of clients.keys()) {
    try {
      ws.send(json)
    } catch {
      // Client might be disconnected
    }
  }
}

/**
 * D-4 topic-aware broadcast. Sends the message only to clients whose
 * subscription set matches the given event topic. Optionally also targets
 * specific user IDs via the `me` subscription convention — clients
 * subscribed to `me` receive the message iff their `userId` appears in
 * the optional `toUserIds` set.
 *
 * Wildcard subscriptions (`*` and prefix wildcards like `task:*`) are
 * matched via the pure `anyTopicMatches` helper.
 *
 * Substrate-only in D-4 PR 1 — no call sites yet. D-4 PR 2 wires this
 * into the route layer for mention / assign / update events.
 */
export function broadcastToTopic(
  topic: string,
  message: ServerMessage,
  options: { toUserIds?: ReadonlySet<string> } = {}
): void {
  const json = JSON.stringify(message)
  const { toUserIds } = options
  for (const [ws, data] of clients.entries()) {
    const matchesTopic = anyTopicMatches(data.subscriptions, topic)
    const matchesMe =
      toUserIds !== undefined &&
      data.userId !== null &&
      toUserIds.has(data.userId) &&
      data.subscriptions.has('me')
    if (!matchesTopic && !matchesMe) continue
    try {
      ws.send(json)
    } catch {
      // Client might be disconnected
    }
  }
}

/**
 * Extract identity from a Hono context resolved by the `currentUser`
 * middleware. Exported as a factory shape because the WS upgrade
 * machinery passes the context to a factory that returns the handlers.
 */
export function makeTerminalWebSocketHandlers(c: Context<CurrentUserContext>): WSEvents {
  const user = c.var.user
  const identity = {
    userId: user?.id ?? null,
    userEmail: user?.email ?? null,
  }
  return buildHandlers(identity)
}

export function broadcastToTerminal(terminalId: string, message: ServerMessage): void {
  const json = JSON.stringify(message)
  let sentCount = 0
  const attachedClients: string[] = []

  for (const [ws, data] of clients.entries()) {
    if (data.attachedTerminals.has(terminalId)) {
      attachedClients.push(data.id)
      try {
        ws.send(json)
        sentCount++
      } catch {
        // Client might be disconnected
      }
    }
  }

  // Log for terminal:output messages to trace the broadcast
  if (message.type === 'terminal:output') {
    log.ws.info('broadcastToTerminal', {
      terminalId,
      totalClients: clients.size,
      attachedClients: attachedClients.length,
      sentCount,
      dataLen: (message.payload as { data?: string }).data?.length ?? 0,
    })
  }
}

function sendTo(ws: WSContext, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message))
  } catch {
    // Client might be disconnected
  }
}

interface SocketIdentity {
  userId: string | null
  userEmail: string | null
}

function buildHandlers(identity: SocketIdentity): WSEvents {
  return {
  onOpen(evt, ws) {
    const clientData: ClientData = {
      id: crypto.randomUUID(),
      attachedTerminals: new Set(),
      userId: identity.userId,
      userEmail: identity.userEmail,
      subscriptions: new Set(),
    }
    clients.set(ws, clientData)
    log.ws.info('Client connected', {
      totalClients: clients.size,
      userId: clientData.userId,
      userEmail: clientData.userEmail,
    })

    // Send list of existing terminals and tabs
    const ptyManager = getPTYManager()
    const tabManager = getTabManager()

    // Ensure at least one tab exists
    tabManager.ensureDefaultTab()

    const terminalsList = ptyManager.listTerminals()
    log.ws.debug('Sending terminals:list to new client', {
      clientId: clientData.id,
      terminalCount: terminalsList.length,
      terminals: terminalsList.map((t) => ({ id: t.id, name: t.name, cwd: t.cwd, tabId: t.tabId })),
    })
    sendTo(ws, {
      type: 'terminals:list',
      payload: { terminals: terminalsList },
    })
    sendTo(ws, {
      type: 'tabs:list',
      payload: { tabs: tabManager.list() },
    })

    // Send current theme to newly connected client
    const settings = getSettings()
    const theme = settings.appearance?.theme ?? null
    sendTo(ws, {
      type: 'theme:synced',
      payload: { theme: theme || 'system' },
    })
  },

  async onMessage(evt, ws) {
    const clientData = clients.get(ws)
    if (!clientData) return

    try {
      const message: ClientMessage = JSON.parse(
        typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)
      )
      const ptyManager = getPTYManager()
      const tabManager = getTabManager()

      switch (message.type) {
        // Terminal messages
        case 'terminal:create': {
          const { name, cols, rows, cwd, tabId, positionInTab, requestId, tempId, taskId } = message.payload

          // If tabId provided but no cwd, use the tab's directory as default
          let effectiveCwd = cwd
          if (tabId && !cwd) {
            const tab = tabManager.get(tabId)
            if (tab?.directory) {
              effectiveCwd = tab.directory
            }
          }

          // Get all existing terminals for comprehensive logging
          const existingTerminals = ptyManager.listTerminals()

          log.ws.info('terminal:create request received', {
            name,
            cwd: effectiveCwd,
            tabId,
            taskId,
            clientId: clientData.id,
            requestId,
            tempId,
            existingTerminalCount: existingTerminals.length,
            existingTerminals: existingTerminals.map((t) => ({
              id: t.id,
              name: t.name,
              cwd: t.cwd,
              tabId: t.tabId,
            })),
          })

          // Prevent duplicate terminals for same cwd - but only for task terminals (no tabId)
          // Regular tabs can have multiple terminals in the same directory
          if (effectiveCwd && !tabId) {
            const existing = existingTerminals.find((t) => t.cwd === effectiveCwd && !t.tabId)
            if (existing) {
              // Return existing terminal instead of creating duplicate
              log.ws.info('terminal:create DUPLICATE FOUND, returning existing', {
                existingTerminalId: existing.id,
                existingName: existing.name,
                cwd: effectiveCwd,
                requestId,
                tempId,
                clientId: clientData.id,
              })
              clientData.attachedTerminals.add(existing.id)
              sendTo(ws, {
                type: 'terminal:created',
                payload: { terminal: existing, isNew: false, requestId, tempId },
              })
              break
            } else {
              // Log why no duplicate was found
              const taskTerminals = existingTerminals.filter((t) => !t.tabId)
              log.ws.debug('terminal:create no duplicate found', {
                cwd: effectiveCwd,
                taskTerminalCount: taskTerminals.length,
                taskTerminalCwds: taskTerminals.map((t) => t.cwd),
              })
            }
          }

          const terminal = ptyManager.create({ name, cols, rows, cwd: effectiveCwd, tabId, positionInTab, taskId })
          log.ws.info('terminal:create CREATED NEW', {
            terminalId: terminal.id,
            name,
            cwd: effectiveCwd,
            taskId,
            clientId: clientData.id,
            requestId,
            tempId,
          })
          clientData.attachedTerminals.add(terminal.id)
          log.ws.debug('terminal:create added to attachedTerminals', {
            terminalId: terminal.id,
            clientId: clientData.id,
            totalAttached: clientData.attachedTerminals.size,
          })
          broadcast({
            type: 'terminal:created',
            payload: { terminal, isNew: true, requestId, tempId },
          })
          break
        }

        case 'terminal:destroy': {
          const { terminalId, force, reason } = message.payload
          const terminalInfo = ptyManager.getInfo(terminalId)

          // Protection: Tab terminals require explicit force flag
          if (terminalInfo?.tabId && !force) {
            log.ws.warn('terminal:destroy BLOCKED - tab terminal requires force flag', {
              terminalId,
              tabId: terminalInfo.tabId,
              name: terminalInfo.name,
              clientId: clientData.id,
              reason,
            })
            sendTo(ws, {
              type: 'terminal:error',
              payload: {
                terminalId,
                error: 'Tab terminals require explicit force flag to destroy',
              },
            })
            break
          }

          // Protection: Task terminals (no tabId, in worktrees dir) require force flag
          // This prevents accidental deletion from frontend bugs or stale state
          const worktreeBasePath = getWorktreeBasePath()
          const isTaskTerminal = !terminalInfo?.tabId && terminalInfo?.cwd?.startsWith(worktreeBasePath)
          if (isTaskTerminal && !force) {
            log.ws.warn('terminal:destroy BLOCKED - task terminal requires force flag', {
              terminalId,
              cwd: terminalInfo?.cwd,
              name: terminalInfo?.name,
              clientId: clientData.id,
              reason,
            })
            sendTo(ws, {
              type: 'terminal:error',
              payload: {
                terminalId,
                error: 'Task terminals require explicit force flag to destroy',
              },
            })
            break
          }

          // Audit log: Record all deletions with full context
          log.ws.info('terminal:destroy EXECUTING', {
            terminalId,
            name: terminalInfo?.name,
            cwd: terminalInfo?.cwd,
            tabId: terminalInfo?.tabId,
            clientId: clientData.id,
            reason: reason ?? 'unspecified',
            force: force ?? false,
          })

          const destroyed = ptyManager.destroy(terminalId)
          if (destroyed) {
            broadcast({
              type: 'terminal:destroyed',
              payload: { terminalId },
            })
          }
          break
        }

        case 'terminal:input': {
          log.ws.debug('terminal:input', { terminalId: message.payload.terminalId, dataLen: message.payload.data.length })
          ptyManager.write(message.payload.terminalId, message.payload.data)
          break
        }

        case 'terminal:resize': {
          ptyManager.resize(message.payload.terminalId, message.payload.cols, message.payload.rows)
          break
        }

        case 'terminal:attach': {
          const { terminalId, cols, rows } = message.payload
          // Ensure terminal is attached to dtach (connects PTY if not already)
          // This is async because it polls for the socket to exist (race condition fix)
          await ptyManager.attach(terminalId)

          // Resize the PTY to the client's current dimensions BEFORE capturing
          // the replay buffer. This SIGWINCHes any running TUI so it redraws at
          // the size the client will render at, and resizes the canonical
          // emulator so its serialization is at matching dimensions.
          if (typeof cols === 'number' && typeof rows === 'number') {
            ptyManager.resize(terminalId, cols, rows)
          }
          // Wait for the emulator to drain pending writes so the snapshot is
          // consistent. Replaces the previous 60 ms setTimeout guess with a
          // deterministic boundary — works regardless of how slowly the TUI
          // emits its post-SIGWINCH redraw.
          await ptyManager.flushPending(terminalId)

          const buffer = ptyManager.getBuffer(terminalId)
          log.ws.info('terminal:attach adding to attachedTerminals', {
            terminalId,
            bufferLength: buffer?.length ?? null,
            clientId: clientData.id,
            priorAttached: Array.from(clientData.attachedTerminals),
          })
          if (buffer !== null) {
            clientData.attachedTerminals.add(terminalId)
            log.ws.debug('terminal:attach sending terminal:attached', {
              terminalId,
              bufferLength: buffer.length,
              clientId: clientData.id,
            })
            sendTo(ws, {
              type: 'terminal:attached',
              payload: {
                terminalId,
                buffer,
              },
            })
          } else {
            log.ws.warn('terminal:attach buffer is null, not sending terminal:attached', {
              terminalId,
              clientId: clientData.id,
            })
          }
          break
        }

        case 'terminals:list': {
          sendTo(ws, {
            type: 'terminals:list',
            payload: { terminals: ptyManager.listTerminals() },
          })
          break
        }

        case 'terminal:rename': {
          const { terminalId, name } = message.payload
          const success = ptyManager.rename(terminalId, name)
          if (success) {
            broadcast({
              type: 'terminal:renamed',
              payload: { terminalId, name },
            })
          } else {
            // Terminal doesn't exist - send sync:stale
            log.ws.warn('terminal:rename failed - terminal not found', { terminalId, clientId: clientData.id })
            sendTo(ws, {
              type: 'sync:stale',
              payload: {
                entityType: 'terminal',
                entityId: terminalId,
                error: `Terminal ${terminalId} not found`,
              },
            })
          }
          break
        }

        case 'terminal:assignTab': {
          const { terminalId, tabId, positionInTab } = message.payload
          const success = ptyManager.assignTab(terminalId, tabId, positionInTab)
          if (success) {
            const info = ptyManager.getInfo(terminalId)
            broadcast({
              type: 'terminal:tabAssigned',
              payload: {
                terminalId,
                tabId,
                positionInTab: info?.positionInTab ?? 0,
              },
            })
          } else {
            // Terminal or tab doesn't exist
            log.ws.warn('terminal:assignTab failed', { terminalId, tabId, clientId: clientData.id })
            sendTo(ws, {
              type: 'sync:stale',
              payload: {
                entityType: 'terminal',
                entityId: terminalId,
                error: `Terminal ${terminalId} or tab ${tabId} not found`,
              },
            })
          }
          break
        }

        case 'terminal:clearBuffer': {
          const { terminalId } = message.payload
          const success = ptyManager.clearBuffer(terminalId)
          if (success) {
            broadcastToTerminal(terminalId, {
              type: 'terminal:bufferCleared',
              payload: { terminalId },
            })
          }
          break
        }

        // Tab messages
        case 'tab:create': {
          const { name, position, directory, adoptTerminalId, requestId, tempId } = message.payload
          log.ws.debug('tab:create request', { name, position, directory, adoptTerminalId, clientId: clientData.id, requestId, tempId })
          const tab = tabManager.create({ name, position, directory })
          log.ws.info('tab:create created', { tabId: tab.id, name: tab.name, directory: tab.directory, requestId, tempId })
          broadcast({
            type: 'tab:created',
            payload: { tab, requestId, tempId, adoptTerminalId },
          })

          // Adopt existing terminal into the new tab if specified
          if (adoptTerminalId) {
            const success = ptyManager.assignTab(adoptTerminalId, tab.id)
            if (success) {
              const info = ptyManager.getInfo(adoptTerminalId)
              log.ws.info('tab:create adopted terminal', { terminalId: adoptTerminalId, tabId: tab.id })
              broadcast({
                type: 'terminal:tabAssigned',
                payload: {
                  terminalId: adoptTerminalId,
                  tabId: tab.id,
                  positionInTab: info?.positionInTab ?? 0,
                },
              })
            } else {
              log.ws.warn('tab:create failed to adopt terminal', { terminalId: adoptTerminalId, tabId: tab.id })
            }
          }
          break
        }

        case 'tab:update': {
          const { tabId, name, directory } = message.payload
          const success = tabManager.update(tabId, { name, directory })
          if (success) {
            broadcast({
              type: 'tab:updated',
              payload: { tabId, name, directory },
            })
          } else {
            // Tab doesn't exist
            log.ws.warn('tab:update failed - tab not found', { tabId, clientId: clientData.id })
            sendTo(ws, {
              type: 'sync:stale',
              payload: {
                entityType: 'tab',
                entityId: tabId,
                error: `Tab ${tabId} not found`,
              },
            })
          }
          break
        }

        case 'tab:delete': {
          const { tabId } = message.payload
          const tabInfo = tabManager.get(tabId)

          log.ws.info('tab:delete received', {
            tabId,
            tabName: tabInfo?.name,
            clientId: clientData.id,
          })

          // Cascade: Destroy all terminals in this tab first
          const terminalsInTab = ptyManager.listTerminals().filter((t) => t.tabId === tabId)

          for (const terminal of terminalsInTab) {
            log.ws.info('tab:delete CASCADE destroying terminal', {
              terminalId: terminal.id,
              terminalName: terminal.name,
              tabId,
              clientId: clientData.id,
            })

            const destroyed = ptyManager.destroy(terminal.id)
            if (destroyed) {
              broadcast({
                type: 'terminal:destroyed',
                payload: { terminalId: terminal.id },
              })
            }
          }

          // Now delete the tab
          const success = tabManager.delete(tabId)
          if (success) {
            log.ws.info('tab:delete SUCCESS', {
              tabId,
              tabName: tabInfo?.name,
              terminalsDestroyed: terminalsInTab.length,
              clientId: clientData.id,
            })
            broadcast({
              type: 'tab:deleted',
              payload: { tabId },
            })
          }
          break
        }

        case 'tab:reorder': {
          const { tabId, position } = message.payload
          const success = tabManager.reorder(tabId, position)
          if (success) {
            // Broadcast full tabs list since reorder shifts multiple tab positions
            broadcast({
              type: 'tabs:list',
              payload: { tabs: tabManager.list() },
            })
          } else {
            // Tab doesn't exist
            log.ws.warn('tab:reorder failed - tab not found', { tabId, position, clientId: clientData.id })
            sendTo(ws, {
              type: 'sync:stale',
              payload: {
                entityType: 'tab',
                entityId: tabId,
                error: `Tab ${tabId} not found`,
              },
            })
          }
          break
        }

        case 'tabs:list': {
          sendTo(ws, {
            type: 'tabs:list',
            payload: { tabs: tabManager.list() },
          })
          break
        }

        // Theme sync
        case 'theme:sync': {
          const { theme } = message.payload
          if (!['light', 'dark', 'system'].includes(theme)) {
            log.ws.warn('theme:sync invalid theme', { theme, clientId: clientData.id })
            break
          }

          // Save to settings file (null for system)
          updateSettingByPath('appearance.theme', theme === 'system' ? null : theme)
          log.ws.info('theme:sync', { theme, clientId: clientData.id })

          // Broadcast to all clients
          broadcast({
            type: 'theme:synced',
            payload: { theme },
          })
          break
        }

        // D-4: per-socket topic subscription. Client tells the server which
        // event topics it cares about; subsequent `broadcastToTopic` calls
        // dispatch only to matching sockets. Empty / unknown topics are
        // ignored. Server echoes the post-change topic set so the client
        // can confirm what's now active.
        case 'subscribe': {
          for (const topic of message.payload.topics) {
            if (typeof topic === 'string' && topic.trim() !== '') {
              clientData.subscriptions.add(topic)
            }
          }
          sendTo(ws, {
            type: 'subscription:ack',
            payload: { topics: Array.from(clientData.subscriptions) },
          })
          break
        }

        case 'unsubscribe': {
          for (const topic of message.payload.topics) {
            clientData.subscriptions.delete(topic)
          }
          sendTo(ws, {
            type: 'subscription:ack',
            payload: { topics: Array.from(clientData.subscriptions) },
          })
          break
        }

        // D-9 Phase C — frontend publishes its page context. Server
        // caches per userId so MCP tools can read it via HTTP. Drop
        // silently for anonymous sockets — no userId to key on.
        case 'page-context:update': {
          if (clientData.userId) {
            const { setPageContext } = await import('../services/page-context-service')
            setPageContext(clientData.userId, message.payload)
          }
          break
        }
      }
    } catch (error) {
      log.ws.error('Failed to handle message', { error: String(error) })
    }
  },

  onClose(evt, ws) {
    clients.delete(ws)
    log.ws.info('Client disconnected', { remainingClients: clients.size })
  },

  onError(evt, ws) {
    log.ws.error('WebSocket error', { error: String(evt) })
    clients.delete(ws)
  },
  }
}

/**
 * Legacy export — kept so server/index.ts can register the handlers
 * without an identity-aware factory while we transition. New code
 * should use `makeTerminalWebSocketHandlers(c)` from the upgrade factory
 * so the socket can be tagged with the current user.
 */
export const terminalWebSocketHandlers: WSEvents = buildHandlers({
  userId: null,
  userEmail: null,
})
