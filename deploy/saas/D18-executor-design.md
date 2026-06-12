# D-18 — Executor Mode

Split the planes: tasks/projects/members live on the SaaS (data plane);
terminals, worktrees, and agent processes run on a user's own machine
(execution plane). The local Fulcrum server dials **outbound** to the SaaS
and registers as an *execution node*; the SaaS routes terminal work to it.

Outbound-only is load-bearing: nodes sit behind NAT/laptops/firewalls, and
the SaaS sits behind Cloudflare. The node initiates a single WS connection
and everything is multiplexed over it.

## Auth

The node authenticates with a `fulc_` API token (D-8 PR 3a) minted by its
owner on the SaaS (Settings → API Tokens) and stored locally via fnox
(`executor.apiToken`, age-encrypted). The `/ws/*` upgrade path already runs
the `currentUser` middleware, so a Bearer header resolves the owner before
the socket opens; sockets without identity are closed immediately. Every
node is owned by exactly one user — the SaaS only routes a user's terminals
to that user's own nodes.

## PR 1 — Registration plane (shipped)

**Hub (SaaS):**
- `executor_nodes` table: id (client-generated, stable per install),
  ownerUserId, name, platform, version, lastSeenAt, createdAt.
- `/ws/executor` endpoint: node sends `executor:register` after open;
  heartbeats every 25s refresh `lastSeenAt`. Live socket = online.
- `GET /api/executors`: caller's nodes with online status.
- `executor:status` broadcast to browsers on connect/disconnect so node
  lists update live (rides the existing task-sync WS).

**Node (local instance):**
- `executor-client.ts`: gated on `executor.enabled` + `remoteUrl` +
  `apiToken` settings; connects with exponential backoff (1s → 60s cap),
  registers, heartbeats. Node id is generated once and persisted
  (`executor.nodeId`).
- Settings UI card: enable toggle, remote URL, API token, node name —
  plus "your nodes" list (which doubles as the SaaS-side view).

## PR 2 — Terminal relay (shipped)

Message envelope over the executor socket (hub ⇄ node), all JSON:

```
hub → node:
  relay:terminal-create   { reqId, terminalId, name, cwd, cols, rows, startup? }
  relay:terminal-input    { terminalId, data }
  relay:terminal-resize   { terminalId, cols, rows }
  relay:terminal-destroy  { terminalId }
  relay:terminal-attach   { terminalId }            // request buffer replay

node → hub:
  relay:terminal-created  { reqId, terminalId, ok, error? }
  relay:terminal-output   { terminalId, data }      // streamed
  relay:terminal-buffer   { terminalId, data }      // attach replay
  relay:terminal-exit     { terminalId, exitCode }
```

Hub keeps `terminalId → nodeId` in memory (rebuilt on node reconnect via a
`relay:terminal-list` exchange). The browser keeps speaking the existing
`/ws/terminal` protocol — the hub's handler checks the routing map and
forwards to the node instead of the local PTYManager when the terminal is
node-backed. Task "Start terminal" gains a node picker (default: the
owner's only online node).

Implementation notes (as shipped): the hub keeps `terminalId → nodeId` in
`executor-ws.ts`; terminal-ws's handler checks `isRelayTerminal()` and
forwards instead of touching the local PTYManager. Nodes resend their live
terminal list with `executor:register`, and the hub drops (and broadcasts
`terminal:destroyed` for) terminals a restarting node no longer has.
Terminal-scoped node→hub messages are ownership-checked — node A can't
inject output into node B's terminals. The node maps hub-assigned relay
ids to its local PTY ids and replays buffers with the same
attach→resize→flush→snapshot sequence the local path uses. The browser's
"Start terminal" overlay gains a node picker when online nodes exist.

Backpressure: terminal output is small relative to WS capacity; v1 relies
on WS buffering; scrollback caps are enforced node-side by the existing
buffer manager.

## PR 3 — Worktree + agent dispatch

`relay:worktree-init { taskId, repoUrl, branch, baseBranch }` so a SaaS
task can materialize a worktree on the node (clone if the repo is absent),
then reuse PR 2 to launch the agent in it. Repo access uses the node's own
git credentials — they never leave the machine.

## Failure semantics

- Node offline → its terminals show "node offline" in the UI; buffers
  survive on the node (dtach) and replay on reconnect.
- Token revoked → hub closes the socket; node surfaces re-auth in settings.
- Multiple nodes per user are fine; terminals are pinned to one node.
