import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq, uniqAlnum } from '../_lib/api'

interface Task {
  id: string
  title: string
}

interface SearchResult {
  entityType: string
  id: string
  title?: string
  snippet?: string
  score?: number
}

// Search returns a bare array of results (not {results: [...]}).
type SearchResponse = SearchResult[]

test.describe('search API', () => {
  let createdTaskId: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdTaskId) {
      await del(request, `/api/tasks/${createdTaskId}`)
      createdTaskId = undefined
    }
  })

  test('GET /api/search?q=<unique> returns a bare results array', async ({ request }) => {
    // uniqAlnum (underscore-only) instead of uniq (dash) — see SECURITY: bug
    // test below + e2e/_lib/api.ts comment.
    const results = await getJson<SearchResponse>(request, `/api/search?q=${uniqAlnum('zzz')}`)
    expect(Array.isArray(results)).toBe(true)
  })

  test('newly created task is searchable by its unique title', async ({ request }) => {
    const title = uniqAlnum('searchable_title')
    const task = await postJson<Task>(request, '/api/tasks', { title, type: 'manual' })
    createdTaskId = task.id

    // FTS5 needs a beat to index the row. Poll briefly.
    let foundTask: SearchResult | undefined
    for (let i = 0; i < 5; i++) {
      const results = await getJson<SearchResponse>(request, `/api/search?q=${encodeURIComponent(title)}`)
      foundTask = results.find((r) => r.entityType === 'task' && r.id === task.id)
      if (foundTask) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(foundTask, 'created task should appear in search by title').toBeTruthy()
  })

  test('SECURITY: /api/search returns 500 on queries with FTS5 special chars (known bug)', async ({
    request,
  }) => {
    // The search route passes the raw query to SQLite FTS5 without escaping.
    // FTS5 interprets `-` as a column operator → 500 "no such column: ...".
    // Same risk class exists for ", *, (, ), :, etc. Real bug, not a test
    // bug; tracking via test.fail until server-side escaping lands.
    test.fail(true, 'known: server passes unescaped queries to FTS5 — should sanitize')
    const res = await request.get('/api/search?q=word-with-dash')
    expect(res.status()).toBe(200)
  })
})
