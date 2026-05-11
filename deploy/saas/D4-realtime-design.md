# D-4: Real-time WebSocket collaboration

**Status**: design (no code yet)
**Author**: Mike (drafted by Claude)
**Sequence**: follows D-3.2 (mention helpers + safeguards); precedes D-5 (sharing/ACLs)

## Goal

When user A creates / assigns / mentions on a task, every other connected
user who can see that task sees the change immediately — no manual refresh.
Same for projects.

Out of scope here: who's *allowed* to see what (D-5). For now assume every
authenticated user in the tenant container can see everything. Per-resource
ACLs gate the fan-out later by adding a filter step before send.

## What we already have

| Piece | Where | Today's behavior |
|---|---|---|
| WS upgrade | `server/index.ts` upgrades requests on `/ws/terminal` | No identity check beyond CF Access wrapping the whole app |
| `broadcast(msg)` | `server/websocket/terminal-ws.ts` | Sends one JSON message to **every** connected client |
| Typed events | `server/types.ts` `ServerMessage` union | Includes `task:updated`, `project:updated`, plus terminal/tab/messaging events |
| Call sites | Route handlers in `server/routes/tasks.ts`, `server/routes/projects.ts` | Already broadcast `task:updated` / `project:updated` after mutations |

The substrate exists. D-4 is about **identifying the socket**, **subscribing
the socket to topics**, and **adding the social event types** (mention,
assign) that don't exist yet.

## Design

### 1. Authentication on the WS upgrade

WebSocket upgrade requests carry the same headers as the original HTTP
request. Cloudflare Access injects `Cf-Access-Authenticated-User-Email`
on every request (incl. WS upgrades) before it reaches our Hono app, so
we can reuse `current-user.ts` middleware verbatim on the upgrade route.

Concretely: extend `clients` (the `Map<WSContext, ClientData>` in
`terminal-ws.ts`) to also carry the resolved `userId` and `email`. If
the upgrade has no derivable user, accept the socket (terminals must keep
working in dev) but tag it as anonymous — no social events fan out to it.

```ts
interface ClientData {
  id: string
  userId: string | null
  email: string | null
  attachedTerminals: Set<string>
  subscriptions: Set<string>  // see (3) below
}
```

### 2. Event taxonomy

Two new events; the rest already exist in `types.ts`:

```ts
interface TaskMentionedMessage {
  type: 'task:mentioned'
  payload: { taskId: string; mentionedUserId: string; authorEmail: string | null }
}

interface TaskAssignedMessage {
  type: 'task:assigned'
  payload: { taskId: string; assigneeUserId: string | null; previousAssigneeUserId: string | null }
}
```

`project:mentioned` mirrors `task:mentioned`. We **don't** add per-mention
notification events to the WS layer — `notification-service` already fans
out to Slack/Discord/etc., and the WS is for in-app awareness only.
Overlap is acceptable; deduplication would be premature.

### 3. Subscription model

Client opt-in via the existing `ClientMessage` union. Two new shapes:

```ts
interface SubscribeMessage {
  type: 'subscribe'
  payload: { topics: string[] }  // e.g. ['task:*', 'project:abc', 'me']
}
interface UnsubscribeMessage {
  type: 'unsubscribe'
  payload: { topics: string[] }
}
```

Topic grammar (intentionally tiny):

- `task:*` — every task event in the tenant
- `task:<id>` — events for one task
- `project:*` — every project event
- `project:<id>` — events for one project
- `me` — every event where the current user is the subject (assigned-to, mentioned)

Server keeps a per-socket `subscriptions: Set<string>`. On broadcast,
filter call sites match topic patterns and only `ws.send` to sockets
that match. `broadcast(...)` keeps its current signature but internally
uses topic dispatch; legacy callers that want "everyone" can pass the
explicit `to: '*'` and we'll migrate them off over time.

### 4. Fan-out call sites

Wire these into existing route handlers (most are one-line additions
alongside existing `broadcast` calls):

| Mutation | Event | Topics it lands on |
|---|---|---|
| Task create | `task:updated` (exists) | `task:*` |
| Task PATCH | `task:updated` (exists) | `task:*`, `task:<id>` |
| Assignee change | `task:assigned` (new) | `task:*`, `task:<id>`, `me` (for new + old assignee) |
| Mention added | `task:mentioned` (new) | `task:*`, `task:<id>`, `me` (per mentioned user) |
| Project mutations | `project:updated` (exists) | `project:*`, `project:<id>` |
| Project mention | `project:mentioned` (new) | `project:*`, `project:<id>`, `me` |

Mention sync already returns `{added, removed, current}` from
`syncMentionsForSource` — D-4 just adds a broadcast per added user.

### 5. Presence (deferred from this PR)

`user:online` / `user:offline` events are valuable but orthogonal — they
need a heartbeat protocol. Punt to D-4.1 unless the first PR ends up
small enough to absorb it.

## Implementation plan

Three small PRs in order:

1. **D-4 PR 1 — auth + subscription substrate**. Extend `ClientData`,
   plumb identity into the upgrade, accept `subscribe` / `unsubscribe`
   client messages, add a topic-aware `broadcastTo(topic, msg)` helper.
   No new event types; existing `task:updated` keeps working unchanged.
2. **D-4 PR 2 — social events**. Add `task:assigned`, `task:mentioned`,
   `project:mentioned`. Wire route handlers to emit them.
3. **D-4 PR 3 — frontend wiring**. React Query invalidation on receipt
   of relevant events; visible toast on `task:mentioned` when subject is
   the current user.

E2E coverage for each:
- PR 1: spec that connects two WS clients with different identities,
  subscribes one to `task:*`, mutates a task via REST, verifies only
  the subscribed socket receives the event.
- PR 2: spec that mentions user A in a task description, verifies user
  A's `me`-subscribed socket gets `task:mentioned`.

## What this is **not**

- Not an ACL system (D-5).
- Not a CRDT or operational-transform layer. We broadcast invalidation
  events, not deltas; client refetches via React Query. Concurrent edits
  follow "last write wins" until a real need surfaces.
- Not a queue or persisted event log. Sockets get live events; offline
  users catch up by reading the REST API on reconnect.

## Open questions

- Reconnect strategy: does the client store last-seen-event-id and ask
  for catch-up on reconnect? **Tentative**: no. React Query refetches
  on mount cover the case; deferring until users complain.
- Topic auth: today a client can subscribe to any topic. Post-D-5,
  subscribe should be filtered by what the user is allowed to read.
- WS heartbeat / idle timeout: Hono's WS layer has a default; we
  haven't tuned it. Fine for now.
