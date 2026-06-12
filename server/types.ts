// Shared types for WebSocket terminal protocol

export type TerminalStatus = 'running' | 'exited' | 'error'

// Tab info - tabs are first-class entities
export interface TabInfo {
  id: string
  name: string
  position: number
  directory?: string // Optional default directory for terminals in this tab
  createdAt: number
}

// Terminal info - terminals can optionally belong to a tab
export interface TerminalInfo {
  id: string
  name: string
  cwd: string
  status: TerminalStatus
  exitCode?: number
  cols: number
  rows: number
  createdAt: number
  tabId?: string // Which tab this terminal belongs to (nullable)
  positionInTab?: number // Order within the tab
}

/**
 * Base interface for messages that support request correlation.
 * The server echoes requestId back in responses for optimistic update confirmation.
 */
interface RequestCorrelation {
  /** Client-generated ID for correlating request with response */
  requestId?: string
  /** Temporary client-side ID for optimistic entity creation */
  tempId?: string
}

// Client -> Server messages

// Terminal messages
export interface TerminalCreateMessage {
  type: 'terminal:create'
  payload: {
    name: string
    cols: number
    rows: number
    cwd?: string
    tabId?: string // Assign to tab on creation
    positionInTab?: number
    taskId?: string
  } & RequestCorrelation
}

export interface TerminalDestroyMessage {
  type: 'terminal:destroy'
  payload: {
    terminalId: string
    /**
     * Required when destroying a terminal that belongs to a tab.
     * Tab terminals should only be destroyed by explicit user action.
     */
    force?: boolean
    /**
     * Reason for deletion (for audit logging).
     * Examples: 'user_closed', 'tab_deleted', 'task_cleanup'
     */
    reason?: string
  }
}

export interface TerminalInputMessage {
  type: 'terminal:input'
  payload: {
    terminalId: string
    data: string
  }
}

export interface TerminalResizeMessage {
  type: 'terminal:resize'
  payload: {
    terminalId: string
    cols: number
    rows: number
  }
}

export interface TerminalAttachMessage {
  type: 'terminal:attach'
  payload: {
    terminalId: string
    /**
     * Client's current xterm dimensions. When provided, the server resizes the
     * PTY (and SIGWINCHes the running TUI) before capturing the replay buffer,
     * so the buffer reflects content rendered at the dimensions the client will
     * actually display it at. Eliminates row/column-mismatch garbling on attach.
     */
    cols?: number
    rows?: number
  }
}

export interface TerminalsListMessage {
  type: 'terminals:list'
}

export interface TerminalRenameMessage {
  type: 'terminal:rename'
  payload: {
    terminalId: string
    name: string
  }
}

export interface TerminalAssignTabMessage {
  type: 'terminal:assignTab'
  payload: {
    terminalId: string
    tabId: string | null // null to unassign
    positionInTab?: number
  }
}

export interface TerminalClearBufferMessage {
  type: 'terminal:clearBuffer'
  payload: {
    terminalId: string
  }
}

// Tab messages
export interface TabCreateMessage {
  type: 'tab:create'
  payload: {
    name: string
    position?: number
    directory?: string
    adoptTerminalId?: string // Adopt existing terminal into new tab
  } & RequestCorrelation
}

export interface TabUpdateMessage {
  type: 'tab:update'
  payload: {
    tabId: string
    name?: string
    directory?: string | null // null to clear directory
  }
}

export interface TabDeleteMessage {
  type: 'tab:delete'
  payload: {
    tabId: string
  }
}

export interface TabReorderMessage {
  type: 'tab:reorder'
  payload: {
    tabId: string
    position: number
  }
}

export interface TabsListMessage {
  type: 'tabs:list'
}

// Theme sync messages
export interface ThemeSyncMessage {
  type: 'theme:sync'
  payload: {
    theme: 'light' | 'dark' | 'system'
  }
}

// D-4 subscription messages — let a connected client opt into specific
// event topics (task:*, task:<id>, project:*, project:<id>, me, or *).
export interface SubscribeMessage {
  type: 'subscribe'
  payload: { topics: string[] }
}
export interface UnsubscribeMessage {
  type: 'unsubscribe'
  payload: { topics: string[] }
}

// D-9 Phase C — frontend publishes its page context so MCP tools can
// answer "what is the user looking at right now?" without polling the
// browser. Server caches per userId; payload shape mirrors
// `PageContext` in services/page-context-service.ts.
export interface PageContextUpdateMessage {
  type: 'page-context:update'
  payload: {
    route: string
    selection?: { kind: string; id: string } | null
    visibleEntities?: Record<string, string[] | undefined>
    metadata?: Record<string, unknown>
  }
}

export type ClientMessage =
  | TerminalCreateMessage
  | TerminalDestroyMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalAttachMessage
  | TerminalsListMessage
  | TerminalRenameMessage
  | TerminalAssignTabMessage
  | TerminalClearBufferMessage
  | TabCreateMessage
  | TabUpdateMessage
  | TabDeleteMessage
  | TabReorderMessage
  | TabsListMessage
  | ThemeSyncMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | PageContextUpdateMessage

// Server -> Client messages

export interface TerminalCreatedMessage {
  type: 'terminal:created'
  payload: {
    terminal: TerminalInfo
    isNew: boolean // true if newly created, false if returning existing terminal
    /** Echo of client requestId for optimistic update confirmation */
    requestId?: string
    /** Client's temporary ID that should be replaced with terminal.id */
    tempId?: string
  }
}

export interface TerminalOutputMessage {
  type: 'terminal:output'
  payload: {
    terminalId: string
    data: string
  }
}

export interface TerminalExitMessage {
  type: 'terminal:exit'
  payload: {
    terminalId: string
    exitCode: number
    status: TerminalStatus
  }
}

export interface TerminalAttachedMessage {
  type: 'terminal:attached'
  payload: {
    terminalId: string
    buffer: string
  }
}

export interface TerminalsListResponseMessage {
  type: 'terminals:list'
  payload: {
    terminals: TerminalInfo[]
  }
}

export interface TerminalErrorMessage {
  type: 'terminal:error'
  payload: {
    terminalId?: string
    error: string
    /** Echo of client requestId for optimistic update rollback */
    requestId?: string
    /** Client's temporary ID that should be rolled back */
    tempId?: string
  }
}

export interface TerminalRenamedMessage {
  type: 'terminal:renamed'
  payload: {
    terminalId: string
    name: string
  }
}

export interface TerminalDestroyedMessage {
  type: 'terminal:destroyed'
  payload: {
    terminalId: string
  }
}

export interface TerminalTabAssignedMessage {
  type: 'terminal:tabAssigned'
  payload: {
    terminalId: string
    tabId: string | null
    positionInTab: number
  }
}

export interface TerminalBufferClearedMessage {
  type: 'terminal:bufferCleared'
  payload: {
    terminalId: string
  }
}

// Tab response messages
export interface TabCreatedMessage {
  type: 'tab:created'
  payload: {
    tab: TabInfo
    /** Echo of client requestId for optimistic update confirmation */
    requestId?: string
    /** Client's temporary ID that should be replaced with tab.id */
    tempId?: string
    /** If set, an existing terminal was adopted into this tab (skip creating new terminal) */
    adoptTerminalId?: string
  }
}

export interface TabUpdatedMessage {
  type: 'tab:updated'
  payload: {
    tabId: string
    name?: string
    directory?: string | null
  }
}

export interface TabDeletedMessage {
  type: 'tab:deleted'
  payload: {
    tabId: string
  }
}

export interface TabReorderedMessage {
  type: 'tab:reordered'
  payload: {
    tabId: string
    position: number
  }
}

export interface TabsListResponseMessage {
  type: 'tabs:list'
  payload: {
    tabs: TabInfo[]
  }
}

export interface TaskUpdatedMessage {
  type: 'task:updated'
  payload: {
    taskId: string
  }
}

export interface NotificationMessage {
  type: 'notification'
  payload: {
    id: string
    title: string
    message: string
    notificationType: 'success' | 'info' | 'warning' | 'error'
    taskId?: string
    playSound?: boolean // Tell desktop app to play local sound
    showToast?: boolean // Whether to show in-app toast
    showDesktop?: boolean // Whether to show browser/desktop notification
    isCustomSound?: boolean // Whether user has a custom sound file
  }
}

/**
 * Sent when an operation references a stale or deleted entity.
 * Client should refresh state and/or rollback optimistic updates.
 */
export interface SyncStaleMessage {
  type: 'sync:stale'
  payload: {
    /** Echo of client requestId for optimistic update rollback */
    requestId?: string
    /** Client's temporary ID that should be rolled back */
    tempId?: string
    /** The entity type that was stale */
    entityType: 'terminal' | 'tab'
    /** The entity ID that was referenced */
    entityId: string
    /** Human-readable error message */
    error: string
  }
}

export interface ThemeSyncedMessage {
  type: 'theme:synced'
  payload: {
    theme: 'light' | 'dark' | 'system'
  }
}

// Messaging channel events
export interface MessagingStatusMessage {
  type: 'messaging:status'
  payload: {
    connectionId: string
    // Keep this aligned with ConnectionStatus in
    // server/services/channels/types.ts (don't import — server/types.ts
    // is also consumed by the frontend and we don't want the channel
    // internals leaking across that boundary).
    status: 'disconnected' | 'connecting' | 'connected' | 'qr_pending' | 'credentials_required'
  }
}

export interface MessagingQRMessage {
  type: 'messaging:qr'
  payload: {
    connectionId: string
    qrDataUrl: string
  }
}

export interface MessagingDisplayNameMessage {
  type: 'messaging:displayName'
  payload: {
    connectionId: string
    displayName: string
  }
}

// D-4 events. Existing call sites already emit `project:updated` and
// `repositories:updated`; this is the first place they're typed.
export interface ProjectUpdatedMessage {
  type: 'project:updated'
  payload: { projectId: string }
}
export interface RepositoriesUpdatedMessage {
  type: 'repositories:updated'
}

/**
 * D-4 subscription acknowledgement. Sent in response to a `subscribe` or
 * `unsubscribe` ClientMessage so the client knows its topics took effect.
 * `topics` echoes the post-change membership for that socket.
 */
export interface SubscriptionAckMessage {
  type: 'subscription:ack'
  payload: { topics: string[] }
}

// D-4 PR 2 social events. Fanned out via broadcastToTopic with both a
// resource-scoped topic (`task:<id>` / `project:<id>`) and the `me`
// convention (per-user targeting). Clients subscribed to either receive
// the event.
export interface TaskMentionedMessage {
  type: 'task:mentioned'
  // commentId is populated when the mention came from a task comment;
  // omitted for mentions in the task description/title (where the
  // mention belongs to the task itself).
  payload: { taskId: string; mentionedUserId: string; authorEmail: string | null; commentId?: string }
}
export interface TaskAssignedMessage {
  type: 'task:assigned'
  payload: {
    taskId: string
    assigneeUserId: string | null
    previousAssigneeUserId: string | null
  }
}
export interface ProjectMentionedMessage {
  type: 'project:mentioned'
  payload: { projectId: string; mentionedUserId: string; authorEmail: string | null }
}
// D-13 PR 3 task-comments. Broadcast on create/delete so other open
// sessions can refresh the comment list live.
export interface TaskCommentAddedMessage {
  type: 'task:comment-added'
  payload: { taskId: string; commentId: string }
}
export interface TaskCommentDeletedMessage {
  type: 'task:comment-deleted'
  payload: { taskId: string; commentId: string }
}

// Team chat fan-out. Tenant-wide channel, so plain broadcast() — every
// connected client gets it; the table is the durable history.
export interface TeamMessageMessage {
  type: 'team:message'
  payload: {
    id: string
    authorUserId: string
    authorEmail: string | null
    authorName: string | null
    body: string
    createdAt: string
  }
}
export interface TeamMessageDeletedMessage {
  type: 'team:message-deleted'
  payload: { id: string }
}

// Presence roster. Broadcast on connect/disconnect and page-context
// updates; also sent directly to a socket right after it identifies, so
// new clients see the room immediately.
export interface PresenceStateMessage {
  type: 'presence:state'
  payload: {
    users: Array<{
      userId: string
      email: string | null
      route: string | null
      lastActiveAt: string
    }>
  }
}

export type ServerMessage =
  | TerminalCreatedMessage
  | TerminalOutputMessage
  | TerminalExitMessage
  | TerminalAttachedMessage
  | TerminalBufferClearedMessage
  | TerminalsListResponseMessage
  | TerminalErrorMessage
  | TerminalRenamedMessage
  | TerminalDestroyedMessage
  | TerminalTabAssignedMessage
  | TabCreatedMessage
  | TabUpdatedMessage
  | TabDeletedMessage
  | TabReorderedMessage
  | TabsListResponseMessage
  | TaskUpdatedMessage
  | NotificationMessage
  | SyncStaleMessage
  | ThemeSyncedMessage
  | MessagingStatusMessage
  | MessagingQRMessage
  | MessagingDisplayNameMessage
  | ProjectUpdatedMessage
  | RepositoriesUpdatedMessage
  | SubscriptionAckMessage
  | TaskMentionedMessage
  | TaskAssignedMessage
  | ProjectMentionedMessage
  | TaskCommentAddedMessage
  | TaskCommentDeletedMessage
  | TeamMessageMessage
  | TeamMessageDeletedMessage
  | PresenceStateMessage
