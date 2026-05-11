import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq } from '../_lib/api'

interface Task {
  id: string
  title: string
}

interface SearchResult {
  type: string
  id: string
  title?: string
  snippet?: string
  score?: number
}

interface SearchResponse {
  results: SearchResult[]
}

test.describe('search API', () => {
  let createdTaskId: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdTaskId) {
      await del(request, `/api/tasks/${createdTaskId}`)
      createdTaskId = undefined
    }
  })

  test('GET /api/search?q=<unique> returns a results envelope', async ({ request }) => {
    const res = await getJson<SearchResponse>(request, `/api/search?q=${uniq('zzz')}`)
    expect(res).toHaveProperty('results')
    expect(Array.isArray(res.results)).toBe(true)
  })

  test('newly created task is searchable by its unique title', async ({ request }) => {
    const title = uniq('searchable-title')
    const task = await postJson<Task>(request, '/api/tasks', { title, type: 'manual' })
    createdTaskId = task.id

    // FTS5 needs a beat to index the row. Poll briefly.
    let foundTask: SearchResult | undefined
    for (let i = 0; i < 5; i++) {
      const res = await getJson<SearchResponse>(request, `/api/search?q=${encodeURIComponent(title)}`)
      foundTask = res.results.find((r) => r.type === 'task' && r.id === task.id)
      if (foundTask) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(foundTask, 'created task should appear in search by title').toBeTruthy()
  })
})
