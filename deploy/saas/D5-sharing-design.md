# D-5: Sharing & access control

**Status**: design (no code yet)
**Author**: Mike (drafted by Claude, four model decisions confirmed by Mike)
**Sequence**: follows D-4 (real-time fan-out); precedes the first ACL implementation PR

## Decisions taken (confirmed)

| # | Question | Decision |
|---|---|---|
| 1 | Unit of sharing | **Per-task (independent)** + per-project. Tasks aren't strictly tied to project access. |
| 2 | Permission model | **Viewer / Editor / Admin** (three tiers) |
| 3 | Default visibility | **Visible to everyone in the tenant** (org-wide by default) |
| 4 | Teams | **Teams from day one** as first-class principals |

These compose into a clean model: a tenant defaults to "we're all on one
team," resources start org-wide, sharing is mostly about elevating roles
or restricting downward when needed.

## Mental model

Every shareable resource (task, project) has two access dimensions:

1. **Visibility**: `tenant` (the default — everyone in this container can
   see it) or `restricted` (only principals named on the resource's ACL
   can see it).
2. **ACL**: a list of `(principal, role)` grants on the resource. The
   ACL doesn't shrink access below the visibility default; it only
   *elevates* roles for specific principals when visibility is `tenant`,
   and acts as the *whole* access list when visibility is `restricted`.

Principals are users **or** teams. A user's effective role on a resource
is the **max** role across all matching grants (direct user grants and
all team memberships the user has).

Tenant-default role for `tenant`-visible resources: **editor**. (We
discussed this — given the Q3 answer leans "trust the tenant," editor
is the implied baseline. Anyone can still be granted admin to manage
sharing.) Creator of a resource is automatically **admin**.

### Role capabilities

| Capability | Viewer | Editor | Admin |
|---|---|---|---|
| Read | ✓ | ✓ | ✓ |
| Update fields | — | ✓ | ✓ |
| Mention / assign | — | ✓ | ✓ |
| Delete | — | — | ✓ |
| Manage ACL (grant / revoke) | — | — | ✓ |
| Change visibility | — | — | ✓ |

## Schema

```ts
// Teams: first-class principal for ACL grants
teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

teamMembers = sqliteTable('team_members', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  userId: text('user_id').notNull(),
  // Team-level admin can manage team membership; member is just a member.
  // Distinct from resource roles.
  role: text('role').notNull().default('member'),  // 'admin' | 'member'
  joinedAt: text('joined_at').notNull(),
})

// One row per (resource, principal) grant. Role is the effective role
// for that principal on that resource. No row = no explicit grant
// (effective role comes from visibility + tenant default).
acls = sqliteTable('acls', {
  id: text('id').primaryKey(),
  resourceType: text('resource_type').notNull(),  // 'task' | 'project'
  resourceId: text('resource_id').notNull(),
  principalType: text('principal_type').notNull(),  // 'user' | 'team'
  principalId: text('principal_id').notNull(),
  role: text('role').notNull(),  // 'viewer' | 'editor' | 'admin'
  grantedAt: text('granted_at').notNull(),
  grantedBy: text('granted_by').notNull(),  // userId
})
// UNIQUE INDEX on (resource_type, resource_id, principal_type, principal_id)
```

Add a column to `tasks` and `projects`:

```ts
visibility: text('visibility').notNull().default('tenant')  // 'tenant' | 'restricted'
```

## The access-decision function

One place answers everything:

```ts
type Role = 'viewer' | 'editor' | 'admin'
type ResourceType = 'task' | 'project'

function effectiveRole(
  userId: string,
  resourceType: ResourceType,
  resourceId: string
): Role | null {
  // 1. Pull resource visibility
  const visibility = getResourceVisibility(resourceType, resourceId)

  // 2. Pull all grants on this resource that match this user
  //    (direct user grants + team grants for teams this user is in)
  const grants = matchingGrants(userId, resourceType, resourceId)
  const max = grants.length ? maxRole(grants.map(g => g.role)) : null

  // 3. Combine with visibility default
  if (visibility === 'restricted') return max  // null = no access
  // tenant-visible: every tenant member is implicitly editor
  return max ?? 'editor'
}
```

Reads, writes, and WS subscribe checks all go through this. Hot path —
candidate for an in-memory cache keyed by `(userId, resourceType,
resourceId)`, invalidated on ACL change or visibility flip.

## API

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/teams` | list teams in tenant |
| POST | `/api/teams` | create a team |
| PATCH | `/api/teams/:id` | rename a team |
| DELETE | `/api/teams/:id` | delete a team (drops grants + memberships) |
| POST | `/api/teams/:id/members` | add a user to a team |
| DELETE | `/api/teams/:id/members/:userId` | remove a user from a team |
| GET | `/api/{tasks,projects}/:id/acl` | list grants on a resource |
| POST | `/api/{tasks,projects}/:id/acl` | grant (`{principalType, principalId, role}`) |
| PATCH | `/api/{tasks,projects}/:id/acl/:grantId` | change a grant's role |
| DELETE | `/api/{tasks,projects}/:id/acl/:grantId` | revoke a grant |
| PATCH | `/api/{tasks,projects}/:id/visibility` | flip `tenant` ↔ `restricted` |

Existing list endpoints (`GET /api/tasks`, `GET /api/projects`) filter
by `effectiveRole(currentUser, ...) !== null` — invisible rows drop
out at the query layer.

## Tension worth flagging

The Q1 decision was "per-task independent" — meaning a task's ACL is
*not* inherited from its project. Literal interpretation: a project
shared with 20 people requires 20 grants on every newly created task.
That's painful UX.

We have two options here:

- **Strict literal**: per-task ACL is the only source of truth for the
  task. UX requires either (a) accepting the friction or (b) a
  client-side "copy project's ACL" button at task creation.
- **Soft inheritance**: tasks default-inherit project ACL at creation
  time, but the resulting task ACL is editable independently. After
  creation, project ACL changes don't propagate. This is the
  "snapshot at creation" model.

**Recommendation: soft inheritance.** Closer to user expectation,
trivially explainable ("the task copied its project's sharing when
it was made"), still honors the "per-task independent" rule at the
schema level. Worth confirming before code.

## Interaction with prior phases

- **D-2 (assignee)**: assigning a user implicitly grants viewer if
  they don't already have access. Without this, you could assign
  someone who can't see what they were assigned.
- **D-3 / D-3.1 (mentions)**: mentioning a user does *not* grant
  access. If the user can't see the source, the mention notification
  still fires (they get told they were mentioned somewhere) but
  clicking through hits a 403. Matches Github/Slack behavior.
- **D-4 (WS topics)**: `subscribe` to `task:<id>` checks
  `effectiveRole`. `me` topic is always allowed. Broadcast call sites
  filter recipients through `effectiveRole` before send.

## Implementation plan

Five PRs, in dependency order:

1. **D-5 PR 1 — schema + access-decision function**. Add tables,
   migration, `effectiveRole()`, no API endpoints yet, no read-path
   filtering. Just the foundation + unit tests.
2. **D-5 PR 2 — ACL + visibility CRUD API**. Endpoints for managing
   grants and visibility. Tests cover grant/revoke/role-elevation.
3. **D-5 PR 3 — read-path filtering**. `GET /api/tasks`,
   `GET /api/projects`, and detail endpoints filter by
   `effectiveRole`. Mutation endpoints check role before applying.
   This is the "switch flip" PR — invisible-to-others becomes real.
4. **D-5 PR 4 — teams API**. Team CRUD + membership management.
   (Could be sequenced earlier — pulled later because team grants
   work even with an empty team API; this PR just adds the surface.)
5. **D-5 PR 5 — assignee auto-grant**. D-2 interaction: assigning
   a user grants implicit viewer if needed.

D-4 (real-time) and D-5 PR 1+2+3 can land in parallel. D-4 only
becomes meaningful with ACL gating once PR 3 lands.

## Open questions

- **Tenant-default role**: viewer or editor? Doc proposes editor; if
  this turns out to feel too permissive, drop to viewer.
- **Soft inheritance vs strict literal** (see Tension section).
- **Team-level admin scope**: does a team admin manage team
  membership only, or also grant the team to resources? Doc proposes
  membership only; resource grants are made by resource admins.
- **Org admin**: do we need a "tenant owner" who's admin of
  everything? Probably yes, but we can defer — the tenant's
  Cloudflare Access email list already implicitly determines this.
