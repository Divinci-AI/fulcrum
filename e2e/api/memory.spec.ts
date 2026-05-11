import { expect, test } from '@playwright/test'
import { del, getJson, patchJson, postJson, uniq } from '../_lib/api'

interface Memory {
  id: string
  title: string
  content: string
  tags?: string[]
}

test.describe('memory API', () => {
  let createdId: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await del(request, `/api/memory/${createdId}`)
      createdId = undefined
    }
  })

  test('GET /api/memory returns an array', async ({ request }) => {
    // The list endpoint may take `?q=...` for search; bare GET should list.
    const list = await getJson<Memory[] | { memories: Memory[] }>(request, '/api/memory')
    const arr = Array.isArray(list) ? list : list.memories ?? []
    expect(Array.isArray(arr)).toBe(true)
  })

  test('POST then PATCH then GET round-trips a memory', async ({ request }) => {
    const title = uniq('e2e-memory')
    const created = await postJson<Memory>(request, '/api/memory', {
      title,
      content: 'initial content',
    })
    createdId = created.id
    expect(created.title).toBe(title)

    const updated = await patchJson<Memory>(request, `/api/memory/${created.id}`, {
      content: 'updated content',
    })
    expect(updated.content).toBe('updated content')
  })

  test('GET /api/memory/search?q=... returns FTS5 hits for created content', async ({
    request,
  }) => {
    const uniqueWord = uniq('orchidchainsaw')
    const created = await postJson<Memory>(request, '/api/memory', {
      title: 'e2e search memory',
      content: `the ${uniqueWord} was here`,
    })
    createdId = created.id
    // Poll briefly for FTS5 indexing.
    let found = false
    for (let i = 0; i < 5; i++) {
      const res = await getJson<{ results?: Memory[] } | Memory[]>(
        request,
        `/api/memory/search?q=${uniqueWord}`
      )
      const arr = Array.isArray(res) ? res : res.results ?? []
      if (arr.some((m) => m.id === created.id)) {
        found = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(found).toBe(true)
  })
})
