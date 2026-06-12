# Desktop Connectivity & Sync — Assessment (2026-06-11)

How the Fulcrum desktop app relates to the remote SaaS, Claude Code, the
Claude Desktop application, and Hermes — what exists today, where the gaps
are, and the recommended direction for each.

## 1. Desktop ↔ remote web app

**Today.** The desktop app (Neutralino, `desktop/`) is a shell around a
*bundled local server* (`server/desktop-entry.ts`) with its own SQLite DB at
`~/.fulcrum/`. D-12 added **profiles** (`~/.fulcrum/desktop-settings.json`):
the Local profile renders the bundled server's UI; remote profiles (e.g.
fulcrum-acme.divinci.ai) open in **separate Neutralino windows** because CF
Access sets `X-Frame-Options: DENY`, so remote UIs can't be iframed.

**The honest answer on sync: there is none.** Local and remote are two
complete, independent Fulcrum instances with independent databases. The only
data leaving an instance is the Divinci sync (`divinci-sync-service.ts`),
which is a *push-only RAG upload* (tasks/projects/messages/events → a
Divinci collection for retrieval) — not instance-to-instance sync. A task
created on the desktop never appears on the SaaS and vice versa.

**Why full two-way DB sync is the wrong goal.** ~30 tables, FK webs,
per-user rows, encrypted columns keyed to *different* age.txt keys per
instance, and no conflict-resolution story. Building CRDT/merge sync for all
of it is a quarter-long project with permanent complexity tax.

**Recommended direction: split the planes instead of syncing them.**
- **Data plane = remote.** Tasks, projects, members, chat live on the SaaS —
  it already has multi-user auth (CF Access + Bearer), ACLs, presence, and
  the new live-update WS fabric.
- **Execution plane = local.** What genuinely must be local is terminals,
  worktrees, and agent processes. Introduce a **local executor mode**: the
  desktop's bundled server connects *outbound* to the SaaS (WS + Bearer
  token — outbound means cloudflared/NAT-friendly, and the `/mcp` auth gate
  already accepts Bearer) and registers as an execution node. The SaaS UI
  shows the user's nodes; "Start terminal" on a SaaS task routes the PTY to
  the user's local node over the existing terminal WS protocol.
- **Stepping stones** (each independently shippable):
  1. Desktop remote profiles get the Bearer-token flow built in (mint a
     `fulc_` token from the SaaS, store in desktop-settings) so the desktop
     can call SaaS APIs programmatically, not just render its UI.
  2. One-shot import/export (tasks+projects JSON) between instances for
     manual migration — cheap, kills the worst "my data is split" pain.
  3. Executor registration + remote PTY routing (the real D-18 arc).

## 2. Desktop ↔ Claude Code terminal

**Today.** Solid but implicit. Task terminals launch `claude` via
`buildAgentCommand` (`frontend/lib/agent-commands.ts`) with a system prompt
that teaches `fulcrum current-task ...`, plus repo/task `agentOptions` flags.
Tool access comes from the Fulcrum MCP server — stdio (`fulcrum mcp`) via the
plugin, or HTTP `/mcp` (now auth-gated; localhost agents unaffected).

**Gaps.** (a) Nothing verifies the agent actually has MCP connectivity — a
broken plugin config fails silently inside the terminal. (b) `agentOptions`
are unvalidated free-form flags (audit finding, still open). (c) The
agent-options precedence (task > repo > project > global) is undocumented.

**Recommendation.** Add an MCP health indicator to the task terminal header
(server already knows when a `fulcrum`-CLI/MCP call arrives with
`FULCRUM_TASK_ID`; surface "agent connected" per task). Whitelist agent
flags. Document precedence in CLAUDE.md.

## 3. Desktop ↔ Claude Desktop application

**Today.** No integration exists in the codebase. A user *can* hand-edit
`claude_desktop_config.json` to add `fulcrum mcp` as a stdio server, and it
works — but nothing surfaces, automates, or documents this.

**Recommendation (small, high leverage).** A Settings → Integrations action:
"Connect Claude Desktop" that writes the MCP server entry into
`~/Library/Application Support/Claude/claude_desktop_config.json` (per-OS
path), pointing at the installed `fulcrum mcp` binary, with a status row
showing whether the entry exists. ~1 day of work, makes Claude Desktop a
first-class Fulcrum client.

## 4. Desktop ↔ Hermes (gateway / desktop app / agent terminal)

**Today.** Hermes is wired as an **assistant chat provider only** (D-16):
`hermes-chat-service.ts` streams against a locally running `hermes gateway`
(OpenAI-compatible API at `127.0.0.1:8642/v1`, bearer auth, configured via
`settings.assistant.hermes.*`), and `hermes-mcp-bridge.ts` exposes all ~127
Fulcrum MCP tools to Hermes as OpenAI function calls (Proxy-intercepted
registration, Zod→JSON-Schema via the SDK compat shim). There is **no
"Hermes Desktop app" integration and no Hermes worktree-agent terminal** —
`agent` is still `'claude' | 'opencode'` everywhere.

**Recommendations.**
1. **Hermes as a third worktree agent**: add `'hermes'` to the agent enum and
   a `buildAgentCommand` branch that launches the Hermes CLI in the task
   terminal (same pattern OpenCode followed). The MCP side needs nothing new
   — `/mcp` over HTTP with localhost or a Bearer token already works.
2. **Gateway health**: the chat provider currently fails per-request when
   `hermes gateway` isn't running. Add a health probe + clear status in the
   assistant provider picker (mirror `isOpencodeAvailable`).
3. **Hermes Desktop app**: treat it like Claude Desktop — its MCP client can
   point at `fulcrum mcp` stdio or `https://<tenant>/mcp` with a Bearer
   token. Same one-click config-writer pattern as §3 once its config path is
   confirmed.

## Communication-path inventory (today)

| Path | Transport | Auth | Direction |
|---|---|---|---|
| Desktop shell → bundled server | localhost HTTP/WS | none (loopback) | bidirectional |
| Desktop → remote SaaS | separate Neutralino window → SaaS UI | CF Access (interactive) | UI only, no API |
| Local instance ↔ SaaS instance | — | — | **none (no sync)** |
| Instance → Divinci | HTTPS push (5-min tick) | API key | one-way out |
| Claude Code (task terminal) → Fulcrum | `fulcrum` CLI + MCP stdio / localhost HTTP `/mcp` | loopback (Bearer for remote) | agent → server |
| Claude Desktop → Fulcrum | manual `fulcrum mcp` stdio config | n/a (local process) | agent → server |
| Hermes gateway ↔ Fulcrum | Fulcrum → `127.0.0.1:8642/v1` (chat) + in-process MCP bridge (tools) | bearer (gateway) | bidirectional in-process |
