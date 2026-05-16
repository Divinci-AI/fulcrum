# D-6: Per-User Integrations

## Executive summary

The D-arc shipped multi-tenant identity (CF Access SSO → `users` → `requireUser`) and resource-level ACLs, but every Integration secret remains a tenant-singleton in `fnox.toml`. D-6 splits Integrations along the right axis: **infrastructure tokens stay tenant-singleton; identity tokens become per-user**.

The smallest visible-value cut is the **GitHub PAT refactor**, modeled on the existing `googleAccounts` table pattern.

**Surprise finding from the scoping pass**: `googleAccounts` is not actually scoped per-user today. The schema has no `ownerUserId` column — any tenant member sees and can delete every Google account in the table. The "existence proof" is conceptual, not enforced. D-6 therefore opens with a quick PR (D-6.1) to retrofit `ownerUserId` onto `googleAccounts` so the per-user pattern is real before we copy it for GitHub. This also closes a privacy regression that the D-arc shipped without anyone noticing.

## Sequencing

```
D-6.1 (S, prereq)   →   D-6.2 (M, primary)         →   D-6.3 (S, cleanup)   →   D-6.4 (M)
googleAccounts.         GitHub per-user                 Drop tenant PAT          Notification prefs
ownerUserId             + GitHubAccountManager          fallback                 per user
```

Estimated 3.5 working days total. Land D-6.1 + D-6.2 together as one user-visible release; ship D-6.3 a week later once a release-cycle's worth of overlap has passed.

---

## PR D-6.1 — Retrofit `ownerUserId` onto `googleAccounts`

**Size**: S (half day). **Why first**: D-6.2 is a copy of the Google pattern. Fix the pattern once.

### Scope

Add `owner_user_id TEXT` to `google_accounts`, backfill, filter route handlers by `requireUser(c).id`.

### Files

- `server/db/schema.ts` (~line 421) — add `ownerUserId: text('owner_user_id')` to `googleAccounts`.
- `drizzle/00xx_google_owner.sql` — new migration.
- `server/services/google/google-calendar-service.ts` (lines 17, 21) — `listGoogleAccounts(userId)`; filter on `ownerUserId`.
- `server/routes/google-oauth.ts` (line 220) — set `ownerUserId: requireUser(c).id` on insert.
- `server/routes/google.ts` (lines 35, 41, 48, 57, …) — apply `requireUser(c)` + `ownerUserId` filtering on every handler.
- Background workers (`googleCalendarManager`, gmail polling) — keep iterating all accounts; per-user filtering applies only at the route/MCP layer.

### Migration

```sql
ALTER TABLE google_accounts ADD COLUMN owner_user_id TEXT;
-- Backfill: assign every legacy account to the lowest-id user.
UPDATE google_accounts
SET owner_user_id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
WHERE owner_user_id IS NULL;
```

### Compatibility

- Column nullable for one release. Legacy code reading without filter still works.
- New route filter treats `NULL owner_user_id` as visible to everyone (so newly added users see the inherited accounts until they reconnect). Document as a one-release transition; flip to `NOT NULL` in a follow-up.
- Background syncers iterate all accounts (no behavior change).

---

## PR D-6.2 — GitHub PAT moves to `github_accounts` table

**Size**: M (1–1.5 days incl. frontend). **Primary deliverable**.

### Why this is the right first big slice

GitHub PAT has the cleanest blast radius in the entire Integrations surface:
- Exactly one server consumer (`server/services/github.ts`)
- Exactly one route file (`server/routes/github.ts`)
- Exactly one frontend form section (`frontend/routes/settings/index.tsx` lines 1337–1377)
- No background workers (`pr-monitor.ts` shells `gh` CLI — unaffected)

### Scope

New `github_accounts(id, owner_user_id, label, pat_fnox_key, github_login, github_avatar_url, last_validated_at, created_at, updated_at)` table. Per-user CRUD route. Octokit factory becomes `getOctokitForUser(userId)`. GitHub routes call `requireUser(c)` and resolve PAT from the user's row.

### Files

- `server/db/schema.ts` — add `githubAccounts` table after `googleAccounts` (~line 458); export `GithubAccount` / `NewGithubAccount` types.
- `drizzle/00xx_github_accounts.sql` — new table.
- `server/services/github-account-service.ts` — new file: `listForUser(userId)`, `getById(id, userId)`, `create(userId, label, pat)`, `delete(id, userId)`, `validateAndStorePat(id, pat)` (calls `octokit.users.getAuthenticated()` to populate `github_login`/`avatarUrl`).
- `server/services/github.ts`:
  - Replace module-level `octokitClient`/`cachedPat` with a small map keyed by `accountId` (or construct fresh — Octokit is cheap).
  - New signatures: `getAuthenticatedUser(accountId)`, `fetchUserOrgs(accountId)`, `fetchUserIssues(accountId, filter, …)`, `fetchUserPRs(accountId, filter, …)`.
  - Keep `parseGitHubRemoteUrl` as a pure helper.
- `server/routes/github.ts`:
  - `const user = requireUser(c)` at top of every handler.
  - Resolve active account: default to the user's first; allow `?accountId=` to disambiguate when a user has multiple PATs.
  - Add `/api/github/accounts` CRUD subroutes (GET list, POST create, DELETE, PATCH label).
- `server/lib/settings/types.ts` (line 115) and `core.ts` (lines 55, 163, 197) — keep `integrations.githubPat` in the type to avoid blowing up read sites; mark deprecated in JSDoc. Removed in D-6.3.
- `server/services/assistant-knowledge.ts` (lines 568, 661) — update assistant's prompt knowledge.

### Encryption

Store PATs encrypted at rest using **fnox-age** (the existing pattern): write each PAT as `FULCRUM_GH_ACCOUNT_<uuid>` fnox key, store only the key *name* in the DB column. Pros: no new crypto code, reuses key rotation, operator already has `age.txt`.

### Migration

```sql
CREATE TABLE github_accounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  pat_fnox_key TEXT NOT NULL,
  github_login TEXT,
  github_avatar_url TEXT,
  last_validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX github_accounts_owner_label_uq
  ON github_accounts (owner_user_id, label);
```

### Compatibility / rollout

**Hard cutover with a one-shot bootstrap** is cleaner than a long shim:
- On first boot after D-6.2: if `github_accounts` is empty AND a legacy `integrations.githubPat` exists, create one row labeled "imported", owned by the tenant's first user, with the PAT copied into a fresh fnox key. Log a warning.
- **Resolution order in `getOctokitForUser(userId)`**: (1) user's own account(s); (2) for one release, fall back to the imported row regardless of `owner_user_id`; (3) null. Stops Sam (just signed up) from getting 401 until he adds his own PAT. UI nudge: "this is the tenant default — add your own to attribute PR comments to you".
- Step (2) is removed in PR D-6.3.

### Frontend

- Remove the GitHub PAT block at `frontend/routes/settings/index.tsx:1337–1377`.
- Replace with `<GitHubAccountManager />` mirroring `GoogleAccountManager`'s list pattern: header, "Add PAT" button, per-row label/login/avatar/delete/re-validate.
- New `frontend/components/github/github-account-manager.tsx`.
- New `frontend/hooks/use-github.ts` — TanStack Query hooks (`useGitHubAccounts`, `useCreateGitHubAccount`, `useDeleteGitHubAccount`, `useValidateGitHubAccount`).
- `frontend/hooks/use-config.ts` (lines 145, 469) — leave the legacy `useGitHubPat` hook for one release; deprecate.

### Gating

All `/api/github/*` and `/api/github/accounts/*` handlers call `requireUser(c)`. Today the GitHub routes are completely ungated — any anonymous request hits Mike's PAT. After D-6.2: no user → 401. In production CF Access always sets the header; local dev uses `FULCRUM_DEV_USER_EMAIL`.

### Call sites to update

| Call site | File / line | After D-6.2 |
|---|---|---|
| `getOctokit()` factory | `server/services/github.ts:46` | `getOctokitForUser(userId)` |
| `getAuthenticatedUser()` | `server/services/github.ts:76` | Takes `accountId` |
| `fetchUserOrgs()` | `server/services/github.ts:91` | Takes `accountId` |
| `fetchUserIssues()` | `server/services/github.ts:109` | Takes `accountId` |
| `fetchUserPRs()` | `server/services/github.ts:175` | Takes `accountId` |
| Route `/api/github/user` | `server/routes/github.ts:17` | `requireUser` + resolve account |
| Route `/api/github/orgs` | `server/routes/github.ts:26` | Same |
| Route `/api/github/issues` | `server/routes/github.ts:33` | Same |
| Route `/api/github/prs` | `server/routes/github.ts:60` | Same |
| `useGitHubPat` hook | `frontend/hooks/use-config.ts:145` | Removed in D-6.3 |
| Settings form input | `frontend/routes/settings/index.tsx:1337–1377` | Replaced |
| Assistant prompt knowledge | `server/services/assistant-knowledge.ts:568, 661` | Updated |

Nothing else consumes the PAT. `pr-monitor.ts` shells `gh` (system auth); `routes/git.ts:1010` only formats an error message.

---

## PR D-6.3 — Remove tenant `integrations.githubPat` setting

**Size**: S (afternoon). **Why later**: one release of overlap for anyone who hand-edited fnox.

### Scope

- Delete `integrations.githubPat` from `FNOX_CONFIG_MAP` (`fnox.ts:32`), `Settings.integrations.githubPat` (`types.ts:115, 174, 284, 338, 422`), `VALID_SETTING_PATHS`, `core.ts:55,163,197`, `routes/config.ts:37,44,368`.
- Drop fallback step (2) in `getOctokitForUser`.
- Remove the legacy `useGitHubPat` hook (`hooks/use-config.ts:145, 469`).
- Migration: prune the legacy fnox key on next boot, log "Removed obsolete integrations.githubPat".

---

## PR D-6.4 — Notification preferences per user

**Size**: M (1 day). **Second deliverable**.

### Why this and not channel routing

Channel routing (a notification to Sam ends up in Sam's Slack DM) needs inbound-correlation work (see deferred). But a smaller, valuable win exists: **per-user toggles + per-user Pushover keys**. Today `notifications.pushover.userKey` is tenant-singleton; everyone gets pushed to one device. Keep Slack/Discord/Telegram as tenant-wide bot-config; let each user set their own Pushover key and per-channel opt-in.

### Scope

- New `notification_preferences(user_id, pushover_user_key_fnox, toast_enabled, desktop_enabled, sound_enabled, pushover_enabled)` table.
- `getNotificationSettingsForUser(userId)` selector merges tenant defaults with user overrides.
- `sendNotification(payload, { recipientUserId })` selects recipient prefs.

### Files

- `server/db/schema.ts` — add `notificationPreferences` table.
- `server/services/notification-service.ts` (line 288) — `sendNotification` learns optional `recipientUserId`; without it, today's tenant-broadcast behavior.
- Pushover dispatcher — when `recipientUserId` is set, use that user's key; otherwise tenant key.
- `server/routes/config.ts` — add `GET /api/config/me/notifications`, `PATCH /api/config/me/notifications`.
- Settings UI split: "Tenant defaults" (admins only — see deferred D-7) and "Your preferences" (every user). Interim: all users see tenant form, only "Your preferences" is per-user.

### Compatibility

Tenant `notifications.pushover.userKey` keeps working as default. Personal key overrides. One-release transition, then deprecate.

---

## PR D-6.5 — Per-user Slack/Discord/Telegram DM routing — DEFERRED

Documented for traceability. Requires:
- Identity mapping `users.email` → Slack `user_id` / Discord snowflake / Telegram `chat_id`.
- Inbound channel observer (`messagingSessionMappings`, `channelMessages`) must attribute "message from Mike" to `users.id=mike`.
- Slack bot needs `users:read.email` scope; Telegram requires `/start` once per user.

Defer until product confirms it's the right next step.

---

## Explicitly deferred (do NOT include in D-6)

1. **Memory split** — `memories` table needs `scope: 'tenant' | 'private'` + `owner_user_id`, mirroring `tasks.visibility`. UX (mention in memory tool calls, search filter, etc.) needs product input. Brief design doc first; do not start coding.
2. **Channel per-user routing** — see PR D-6.5.
3. **Cloudflare token per-user** — out of scope. CF infra is shared.
4. **Admin/role surfacing in the frontend** — D-5 shipped resource ACLs but no concept of a "tenant admin" who can edit tenant-wide settings. Ship D-6.4 with all users able to edit tenant defaults; file follow-up "D-7: tenant admin role" before D-6.5 lands.
5. **Auditing / who-changed-what** — tempting but unrequested.
6. **Multi-PAT-per-user UI in D-6.2** — schema supports it (`UNIQUE(owner_user_id, label)` allows >1 row); UI ships with a single "Add another" button but primary use case is one PAT per user.

---

## Critical files for implementation

- `server/services/github.ts`
- `server/routes/github.ts`
- `server/db/schema.ts`
- `server/middleware/current-user.ts`
- `frontend/routes/settings/index.tsx`
- `frontend/components/google/google-account-manager.tsx` (reference pattern)
