import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'
import {
  createGithubAccount,
  listGithubAccountsForUser,
  getGithubAccountForUser,
  rotateGithubAccountPat,
  updateGithubAccountLabel,
  deleteGithubAccount,
  pruneLegacyGithubPatFnoxKey,
  readPatForAccount,
  setSecretStore,
  resetSecretStore,
  type SecretStore,
} from './github-account-service'

// Mock Octokit so validatePat doesn't hit the network. Controlled via
// the module-level `octokitNextResponse` slot.
let octokitNextResponse: { login: string; avatar_url: string } | Error = {
  login: 'mike',
  avatar_url: 'https://example.com/mike.png',
}
mock.module('@octokit/rest', () => ({
  Octokit: class {
    users = {
      getAuthenticated: async () => {
        if (octokitNextResponse instanceof Error) throw octokitNextResponse
        return { data: octokitNextResponse }
      },
    }
  },
}))

function makeInMemorySecretStore(): SecretStore & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
    remove: (key) => {
      store.delete(key)
    },
  }
}

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users).values({ id, email, createdAt: now, updatedAt: now }).run()
  return id
}

describe('github-account-service: CRUD', () => {
  let env: TestEnv
  let secrets: ReturnType<typeof makeInMemorySecretStore>
  beforeEach(() => {
    env = setupTestEnv()
    secrets = makeInMemorySecretStore()
    setSecretStore(secrets)
    octokitNextResponse = { login: 'mike', avatar_url: 'https://example.com/mike.png' }
  })
  afterEach(() => {
    resetSecretStore()
    env.cleanup()
  })

  test('createGithubAccount validates the PAT, stores it in the secret store, persists the row', async () => {
    const userId = insertUser('mike@divinci.ai')
    const account = await createGithubAccount(userId, 'personal', 'ghp_test123')

    expect(account.ownerUserId).toBe(userId)
    expect(account.label).toBe('personal')
    expect(account.githubLogin).toBe('mike')
    expect(account.patFnoxKey).toMatch(/^FULCRUM_GH_ACCOUNT_/)
    expect(secrets.store.get(account.patFnoxKey)).toBe('ghp_test123')
    expect(account.lastValidatedAt).not.toBeNull()
  })

  test('createGithubAccount surfaces validation errors and does NOT persist on failure', async () => {
    const userId = insertUser('mike@divinci.ai')
    octokitNextResponse = new Error('Bad credentials')
    await expect(createGithubAccount(userId, 'bad', 'ghp_bogus')).rejects.toThrow('Bad credentials')
    expect(listGithubAccountsForUser(userId)).toEqual([])
    expect([...secrets.store.keys()]).toEqual([])
  })

  test('listGithubAccountsForUser returns only the calling user\'s accounts', async () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    await createGithubAccount(alice, 'alice-personal', 'ghp_alice1')
    await createGithubAccount(bob, 'bob-personal', 'ghp_bob1')

    expect(listGithubAccountsForUser(alice).map((a) => a.label)).toEqual(['alice-personal'])
    expect(listGithubAccountsForUser(bob).map((a) => a.label)).toEqual(['bob-personal'])
  })

  test('getGithubAccountForUser refuses cross-user access', async () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    const aliceAcct = await createGithubAccount(alice, 'alice-personal', 'ghp_alice1')
    expect(getGithubAccountForUser(aliceAcct.id, alice)?.id).toBe(aliceAcct.id)
    expect(getGithubAccountForUser(aliceAcct.id, bob)).toBeUndefined()
  })

  test('rotateGithubAccountPat re-validates, overwrites the secret, refreshes identity', async () => {
    const userId = insertUser('mike@divinci.ai')
    const account = await createGithubAccount(userId, 'personal', 'ghp_v1')
    octokitNextResponse = { login: 'mike-renamed', avatar_url: 'https://example.com/mike2.png' }

    const rotated = await rotateGithubAccountPat(account.id, userId, 'ghp_v2')
    expect(rotated?.githubLogin).toBe('mike-renamed')
    expect(secrets.store.get(account.patFnoxKey)).toBe('ghp_v2')
  })

  test('updateGithubAccountLabel renames in place', async () => {
    const userId = insertUser('mike@divinci.ai')
    const account = await createGithubAccount(userId, 'personal', 'ghp_v1')
    const renamed = updateGithubAccountLabel(account.id, userId, 'work')
    expect(renamed?.label).toBe('work')
  })

  test('deleteGithubAccount removes the row and the secret', async () => {
    const userId = insertUser('mike@divinci.ai')
    const account = await createGithubAccount(userId, 'personal', 'ghp_v1')
    expect(deleteGithubAccount(account.id, userId)).toBe(true)
    expect(getGithubAccountForUser(account.id, userId)).toBeUndefined()
    expect(secrets.store.get(account.patFnoxKey)).toBeUndefined()
  })

  test('deleteGithubAccount returns false when the account isn\'t owned by the caller', async () => {
    const alice = insertUser('alice@example.com')
    const bob = insertUser('bob@example.com')
    const aliceAcct = await createGithubAccount(alice, 'personal', 'ghp_alice1')
    expect(deleteGithubAccount(aliceAcct.id, bob)).toBe(false)
    // Row still exists.
    expect(getGithubAccountForUser(aliceAcct.id, alice)?.id).toBe(aliceAcct.id)
    expect(secrets.store.get(aliceAcct.patFnoxKey)).toBe('ghp_alice1')
  })

  test('readPatForAccount returns the PAT from the secret store', async () => {
    const userId = insertUser('mike@divinci.ai')
    const account = await createGithubAccount(userId, 'personal', 'ghp_secret')
    expect(readPatForAccount(account)).toBe('ghp_secret')
  })
})

describe('pruneLegacyGithubPatFnoxKey', () => {
  let env: TestEnv
  let secrets: ReturnType<typeof makeInMemorySecretStore>
  beforeEach(() => {
    env = setupTestEnv()
    secrets = makeInMemorySecretStore()
    setSecretStore(secrets)
  })
  afterEach(() => {
    resetSecretStore()
    env.cleanup()
  })

  test('removes the legacy FULCRUM_GITHUB_PAT secret when present', () => {
    secrets.store.set('FULCRUM_GITHUB_PAT', 'ghp_leftover_from_pr2_or_earlier')
    pruneLegacyGithubPatFnoxKey()
    expect(secrets.store.has('FULCRUM_GITHUB_PAT')).toBe(false)
  })

  test('is a no-op when the legacy key is already gone (idempotent)', () => {
    secrets.store.set('FULCRUM_GH_ACCOUNT_KEEP_ME', 'ghp_active_per_user_pat')
    pruneLegacyGithubPatFnoxKey()
    // Other secrets in the store stay untouched.
    expect(secrets.store.get('FULCRUM_GH_ACCOUNT_KEEP_ME')).toBe('ghp_active_per_user_pat')
  })
})
