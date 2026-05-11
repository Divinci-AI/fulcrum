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

  test('FTS5 special chars in user queries do not crash the route', async ({ request }) => {
    // First e2e run caught the server passing raw user queries to SQLite
    // FTS5 — `q=word-with-dash` was returning 500 "no such column: with"
    // because FTS5 treats `-` as a column operator. Server now wraps each
    // user-supplied token in FTS5 phrase quotes via escapeFts5Query() so
    // the input is matched literally. This regression-guards the full
    // class: -, *, ", :, ^, +, parens.
    for (const q of ['word-with-dash', 'a*b', 'foo:bar', 'parens(test)']) {
      const res = await request.get(`/api/search?q=${encodeURIComponent(q)}`)
      expect(res.status(), `query: ${q}`).toBe(200)
    }
  })
})
