/**
 * GitHub account service (D-6 PR 2).
 *
 * Each row of `github_accounts` is a per-user GitHub identity. The PAT
 * itself never lives in the database — it's age-encrypted by fnox under
 * the key recorded in `patFnoxKey`. This module owns the read/write of
 * those secrets so callers (routes, the Octokit factory) never need to
 * touch fnox directly.
 */
import { and, asc, eq } from 'drizzle-orm'
import { Octokit } from '@octokit/rest'
import { db, githubAccounts } from '../db'
import type { GithubAccount } from '../db'
import {
  fnoxGet as defaultFnoxGet,
  fnoxRemove as defaultFnoxRemove,
  fnoxSet as defaultFnoxSet,
} from '../lib/settings/fnox'
import { createLogger } from '../lib/logger'

const logger = createLogger('Github:AccountService')

const PAT_KEY_PREFIX = 'FULCRUM_GH_ACCOUNT_'

function fnoxKeyForId(id: string): string {
  return `${PAT_KEY_PREFIX}${id.replace(/-/g, '_').toUpperCase()}`
}

// Small swappable secret-store interface. Production wires the fnox-age
// implementation; tests inject an in-memory fake so the unit suite doesn't
// depend on the fnox binary being installed or bootstrapped. The seam is
// here (not at the module-mock layer) because Bun's `mock.module` can't
// retroactively replace a module that another test file already loaded.
export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const realSecretStore: SecretStore = {
  get: (key) => defaultFnoxGet(key),
  set: (key, value) => defaultFnoxSet(key, value, 'age'),
  remove: (key) => defaultFnoxRemove(key),
}

let secretStore: SecretStore = realSecretStore

export function setSecretStore(store: SecretStore): void {
  secretStore = store
}
export function resetSecretStore(): void {
  secretStore = realSecretStore
}

export interface ValidatedPat {
  login: string
  avatarUrl: string | null
}

// Validate a PAT against the GitHub API. Returns the resolved identity on
// success; throws on auth failure or network error. Callers should treat
// this as the "is this a real, working token?" gate.
export async function validatePat(pat: string): Promise<ValidatedPat> {
  const octokit = new Octokit({ auth: pat })
  const { data } = await octokit.users.getAuthenticated()
  return {
    login: data.login,
    avatarUrl: data.avatar_url ?? null,
  }
}

export function listGithubAccountsForUser(userId: string): GithubAccount[] {
  return db
    .select()
    .from(githubAccounts)
    .where(eq(githubAccounts.ownerUserId, userId))
    .orderBy(asc(githubAccounts.createdAt))
    .all()
}

export function getGithubAccountForUser(id: string, userId: string): GithubAccount | undefined {
  return db
    .select()
    .from(githubAccounts)
    .where(and(eq(githubAccounts.id, id), eq(githubAccounts.ownerUserId, userId)))
    .get()
}

// Read the raw PAT for a stored account. Internal — only the Octokit
// factory and validation flows need this. Never expose to the route layer.
export function readPatForAccount(account: GithubAccount): string | null {
  return secretStore.get(account.patFnoxKey)
}

export async function createGithubAccount(
  userId: string,
  label: string,
  pat: string
): Promise<GithubAccount> {
  // Validate first; we don't want a row that points at an invalid token.
  const identity = await validatePat(pat)

  const id = crypto.randomUUID()
  const key = fnoxKeyForId(id)
  secretStore.set(key, pat)

  const now = new Date().toISOString()
  db.insert(githubAccounts)
    .values({
      id,
      ownerUserId: userId,
      label,
      patFnoxKey: key,
      githubLogin: identity.login,
      githubAvatarUrl: identity.avatarUrl,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const created = db.select().from(githubAccounts).where(eq(githubAccounts.id, id)).get()
  if (!created) {
    // Roll back the fnox write if the insert somehow disappeared.
    secretStore.remove(key)
    throw new Error('Failed to read back created GitHub account')
  }
  return created
}

export async function rotateGithubAccountPat(
  id: string,
  userId: string,
  pat: string
): Promise<GithubAccount | undefined> {
  const account = getGithubAccountForUser(id, userId)
  if (!account) return undefined
  const identity = await validatePat(pat)
  secretStore.set(account.patFnoxKey, pat)
  const now = new Date().toISOString()
  db.update(githubAccounts)
    .set({
      githubLogin: identity.login,
      githubAvatarUrl: identity.avatarUrl,
      lastValidatedAt: now,
      updatedAt: now,
    })
    .where(eq(githubAccounts.id, id))
    .run()
  return getGithubAccountForUser(id, userId)
}

export function updateGithubAccountLabel(
  id: string,
  userId: string,
  label: string
): GithubAccount | undefined {
  const account = getGithubAccountForUser(id, userId)
  if (!account) return undefined
  const now = new Date().toISOString()
  db.update(githubAccounts)
    .set({ label, updatedAt: now })
    .where(eq(githubAccounts.id, id))
    .run()
  return getGithubAccountForUser(id, userId)
}

export function deleteGithubAccount(id: string, userId: string): boolean {
  const account = getGithubAccountForUser(id, userId)
  if (!account) return false
  secretStore.remove(account.patFnoxKey)
  db.delete(githubAccounts).where(eq(githubAccounts.id, id)).run()
  return true
}

// D-6 PR 3: one-shot cleanup of the legacy `FULCRUM_GITHUB_PAT` fnox key.
// PR 2 moved its value into a `github_accounts` row on first boot;
// removing the setting from FNOX_CONFIG_MAP in PR 3 means the value is
// now unreachable through the type system, but the encrypted blob is
// still sitting in `fnox.toml` until something explicitly removes it.
// Runs every boot — idempotent (no-op once the key is gone).
export function pruneLegacyGithubPatFnoxKey(): void {
  const existing = secretStore.get('FULCRUM_GITHUB_PAT')
  if (existing === null) return
  secretStore.remove('FULCRUM_GITHUB_PAT')
  logger.info(
    'Removed obsolete FULCRUM_GITHUB_PAT fnox key — PATs are now stored per-row under FULCRUM_GH_ACCOUNT_<uuid>'
  )
}
