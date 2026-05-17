import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, users } from '../db'

// D-7 PR 5 cleanup: cover the OctokitByAccount cache invalidation seam.
//
// The route layer calls `invalidateGithubAccountCache(accountId)` after a
// PATCH that rotates the PAT. Without the invalidate, the cached Octokit
// keeps authenticating with the old token until the process restarts.
// This regression-proofs that path.
//
// Octokit is mocked to capture the auth value each constructor receives
// so we can assert the second `getOctokitForUser` call constructs with
// the new PAT, not the cached old one.

let octokitConstructorCalls: Array<{ auth: string }> = []
mock.module('@octokit/rest', () => ({
  Octokit: class {
    constructor(opts: { auth?: string }) {
      octokitConstructorCalls.push({ auth: opts.auth ?? '' })
    }
    users = {
      getAuthenticated: async () => ({
        data: { login: 'test-user', avatar_url: '' },
      }),
    }
  },
}))

const {
  setSecretStore,
  resetSecretStore,
  createGithubAccount,
} = await import('./github-account-service')
const { getOctokitForUser, invalidateGithubAccountCache, clearAllGithubCaches } = await import(
  './github.ts'
)

function makeInMemorySecretStore() {
  const store = new Map<string, string>()
  return {
    store,
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => store.set(k, v),
    remove: (k: string) => {
      store.delete(k)
    },
  }
}

function insertUser(email: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(users)
    .values({ id, email, isAdmin: false, createdAt: now, updatedAt: now })
    .run()
  return id
}

describe('getOctokitForUser cache invalidation', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupTestEnv()
    octokitConstructorCalls = []
    clearAllGithubCaches()
    setSecretStore(makeInMemorySecretStore())
  })
  afterEach(() => {
    resetSecretStore()
    clearAllGithubCaches()
    env.cleanup()
  })

  test('first call constructs an Octokit; second call reuses the cache', async () => {
    const userId = insertUser('mike@example.com')
    const account = await createGithubAccount(userId, 'personal', 'ghp_v1')
    // createGithubAccount calls validatePat which constructs an Octokit.
    octokitConstructorCalls = []

    const a = getOctokitForUser(userId)
    const b = getOctokitForUser(userId)
    expect(a).not.toBeNull()
    expect(b).toBe(a) // same instance — cached
    expect(octokitConstructorCalls.length).toBe(1) // only one new construction
    expect(octokitConstructorCalls[0].auth).toBe('ghp_v1')
    expect(account.id).toBeDefined()
  })

  test('after invalidateGithubAccountCache, next call constructs with the *current* PAT', async () => {
    const userId = insertUser('mike@example.com')
    const account = await createGithubAccount(userId, 'personal', 'ghp_v1')

    // Prime the cache.
    getOctokitForUser(userId)

    // Simulate a PAT rotation: write a new value directly into the
    // SecretStore (the github-account-service rotation path does this
    // plus updates DB metadata; we only need the secret swap to prove
    // the cache invalidation).
    const newStore = makeInMemorySecretStore()
    newStore.set(account.patFnoxKey, 'ghp_v2')
    setSecretStore(newStore)

    // Without invalidating, the cached Octokit keeps the old PAT.
    octokitConstructorCalls = []
    const beforeInvalidate = getOctokitForUser(userId)
    expect(octokitConstructorCalls.length).toBe(0)
    expect(beforeInvalidate).not.toBeNull()

    // Invalidate, then call again — should construct fresh with the new PAT.
    invalidateGithubAccountCache(account.id)
    octokitConstructorCalls = []
    const afterInvalidate = getOctokitForUser(userId)
    expect(afterInvalidate).not.toBeNull()
    expect(octokitConstructorCalls.length).toBe(1)
    expect(octokitConstructorCalls[0].auth).toBe('ghp_v2')
  })

  test('invalidating an unknown account id is a no-op (no throw, no construction)', () => {
    octokitConstructorCalls = []
    invalidateGithubAccountCache('00000000-0000-0000-0000-000000000000')
    expect(octokitConstructorCalls.length).toBe(0)
  })

  test('clearAllGithubCaches drops every entry — next getOctokitForUser reconstructs', async () => {
    const aliceId = insertUser('alice@example.com')
    const bobId = insertUser('bob@example.com')
    await createGithubAccount(aliceId, 'personal', 'ghp_alice')
    await createGithubAccount(bobId, 'personal', 'ghp_bob')

    getOctokitForUser(aliceId)
    getOctokitForUser(bobId)
    octokitConstructorCalls = []

    clearAllGithubCaches()

    getOctokitForUser(aliceId)
    getOctokitForUser(bobId)
    expect(octokitConstructorCalls.length).toBe(2)
    expect(octokitConstructorCalls.map((c) => c.auth).sort()).toEqual(['ghp_alice', 'ghp_bob'])
  })
})
