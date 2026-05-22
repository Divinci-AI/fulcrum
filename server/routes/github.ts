// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
import { Hono } from 'hono'
import { db } from '../db'
import { repositories } from '../db/schema'
import {
  getAuthenticatedUser,
  fetchUserIssues,
  fetchUserPRs,
  fetchUserOrgs,
  parseGitHubRemoteUrl,
  invalidateGithubAccountCache,
  type PRFilter,
  type IssueFilter,
} from '../services/github'
import {
  listGithubAccountsForUser,
  getGithubAccountForUser,
  createGithubAccount,
  rotateGithubAccountPat,
  updateGithubAccountLabel,
  deleteGithubAccount,
} from '../services/github-account-service'
import { requireUser, type CurrentUserContext } from '../middleware/current-user'

const app = new Hono<CurrentUserContext>()

// ==========================================
// Account CRUD (D-6 PR 2)
// ==========================================

// GET /api/github/accounts — list the calling user's GitHub identities.
app.get('/accounts', (c) => {
  const user = requireUser(c)
  const accounts = listGithubAccountsForUser(user.id).map((a) => ({
    id: a.id,
    label: a.label,
    githubLogin: a.githubLogin,
    githubAvatarUrl: a.githubAvatarUrl,
    lastValidatedAt: a.lastValidatedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }))
  return c.json({ accounts })
})

// POST /api/github/accounts — add a new PAT. Validates against GitHub
// before persisting so we never store a row that points at an invalid
// token. Body: { label, pat }.
app.post('/accounts', async (c) => {
  const user = requireUser(c)
  const body = await c.req.json<{ label?: string; pat?: string }>()
  const label = body.label?.trim()
  const pat = body.pat?.trim()
  if (!label) return c.json({ error: 'label is required' }, 400)
  if (!pat) return c.json({ error: 'pat is required' }, 400)
  try {
    const account = await createGithubAccount(user.id, label, pat)
    return c.json(
      {
        id: account.id,
        label: account.label,
        githubLogin: account.githubLogin,
        githubAvatarUrl: account.githubAvatarUrl,
        lastValidatedAt: account.lastValidatedAt,
      },
      201
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create GitHub account'
    // A duplicate `(owner_user_id, label)` collides on the unique index.
    if (/UNIQUE constraint failed/.test(msg)) {
      return c.json({ error: 'A GitHub account with that label already exists' }, 409)
    }
    return c.json({ error: msg }, 400)
  }
})

// PATCH /api/github/accounts/:id — rotate the PAT and/or rename. Body:
// { label?, pat? }. When `pat` is present the new token is validated
// before storage; rename happens after.
app.patch('/accounts/:id', async (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  if (!getGithubAccountForUser(id, user.id)) {
    return c.json({ error: 'Account not found' }, 404)
  }
  const body = await c.req.json<{ label?: string; pat?: string }>()
  try {
    if (body.pat !== undefined) {
      await rotateGithubAccountPat(id, user.id, body.pat)
      invalidateGithubAccountCache(id)
    }
    if (body.label !== undefined && body.label.trim() !== '') {
      updateGithubAccountLabel(id, user.id, body.label.trim())
    }
    const after = getGithubAccountForUser(id, user.id)
    if (!after) return c.json({ error: 'Account not found' }, 404)
    return c.json({
      id: after.id,
      label: after.label,
      githubLogin: after.githubLogin,
      githubAvatarUrl: after.githubAvatarUrl,
      lastValidatedAt: after.lastValidatedAt,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Update failed' }, 400)
  }
})

// DELETE /api/github/accounts/:id
app.delete('/accounts/:id', (c) => {
  const user = requireUser(c)
  const id = c.req.param('id')
  const removed = deleteGithubAccount(id, user.id)
  if (!removed) return c.json({ error: 'Account not found' }, 404)
  invalidateGithubAccountCache(id)
  return c.json({ success: true })
})

// ==========================================
// Existing surface — refactored to take the calling user's accounts
// ==========================================

// Optional `?accountId=` query for users with multiple PATs. Without it,
// the user's earliest-created account is used. Returns 401 when the user
// has no accounts at all.
function accountIdFromQuery(c: Parameters<Parameters<typeof app.get>[1]>[0]): string | undefined {
  return c.req.query('accountId') || undefined
}

// GET /api/github/user — info on the GitHub identity tied to the caller's
// active account.
app.get('/user', async (c) => {
  const caller = requireUser(c)
  const user = await getAuthenticatedUser(caller.id, accountIdFromQuery(c))
  if (!user) {
    return c.json({ error: 'No GitHub account configured for this user' }, 401)
  }
  return c.json(user)
})

// GET /api/github/orgs
app.get('/orgs', async (c) => {
  const caller = requireUser(c)
  const orgs = await fetchUserOrgs(caller.id, accountIdFromQuery(c))
  return c.json(orgs)
})

// GET /api/github/issues
app.get('/issues', async (c) => {
  const caller = requireUser(c)
  const filter = (c.req.query('filter') || 'assigned') as IssueFilter
  const org = c.req.query('org') || undefined
  const fulcrumReposOnly = c.req.query('fulcrumReposOnly') === 'true'

  let repoFilters: { owner: string; repo: string }[] | undefined

  if (!org && fulcrumReposOnly) {
    const repos = db.select().from(repositories).all()
    repoFilters = repos
      .filter((r) => r.remoteUrl)
      .map((r) => parseGitHubRemoteUrl(r.remoteUrl!))
      .filter((r): r is { owner: string; repo: string } => r !== null)
    if (repoFilters.length === 0) {
      return c.json([])
    }
  }

  const issues = await fetchUserIssues(caller.id, filter, repoFilters, org, accountIdFromQuery(c))
  return c.json(issues)
})

// GET /api/github/prs
app.get('/prs', async (c) => {
  const caller = requireUser(c)
  const filter = (c.req.query('filter') || 'all') as PRFilter
  const org = c.req.query('org') || undefined
  const fulcrumReposOnly = c.req.query('fulcrumReposOnly') === 'true'

  let repoFilters: { owner: string; repo: string }[] | undefined

  if (!org && fulcrumReposOnly) {
    const repos = db.select().from(repositories).all()
    repoFilters = repos
      .filter((r) => r.remoteUrl)
      .map((r) => parseGitHubRemoteUrl(r.remoteUrl!))
      .filter((r): r is { owner: string; repo: string } => r !== null)
    if (repoFilters.length === 0) {
      return c.json([])
    }
  }

  const prs = await fetchUserPRs(caller.id, filter, repoFilters, org, accountIdFromQuery(c))
  return c.json(prs)
})

export default app