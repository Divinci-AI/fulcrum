import { expect, test } from '@playwright/test'
import { del, getJson, patchJson, postJson, uniq, uniqAlnum } from '../_lib/api'

// Real shape of a memory row: {id, content, tags, source, createdAt, updatedAt}.
// No `title` or `name` — content is the entire payload.
interface Memory {
  id: string
  content: string
  tags?: string[] | null
  source?: string | null
}

test.describe('memory API', () => {
  let createdId: string | undefined

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await del(request, `/api/memory/${createdId}`)
      createdId = undefined
    }
  })

  test('GET /api/memory returns the memories envelope', async ({ request }) => {
    const resp = await getJson<{ memories: Memory[]; total: number }>(request, '/api/memory')
    expect(resp).toHaveProperty('memories')
    expect(Array.isArray(resp.memories)).toBe(true)
    expect(typeof resp.total).toBe('number')
  })

  test('POST then PATCH round-trips a memory', async ({ request }) => {
    const content = uniq('e2e-memory-content')
    const created = await postJson<Memory>(request, '/api/memory', { content })
    createdId = created.id
    expect(created.content).toBe(content)

    const updated = await patchJson<Memory>(request, `/api/memory/${created.id}`, {
      content: 'updated content',
    })
    expect(updated.content).toBe('updated content')
  })

  test('GET /api/memory/search?q=... returns FTS5 hits for created content', async ({
    request,
  }) => {
    // uniqAlnum (underscore-only) to dodge the FTS5 dash bug (see search.spec).
    const uniqueWord = uniqAlnum('orchidchainsaw')
    const created = await postJson<Memory>(request, '/api/memory', {
      content: `the ${uniqueWord} was here`,
    })
    createdId = created.id
    // Poll briefly for FTS5 indexing.
    let found = false
    for (let i = 0; i < 5; i++) {
      const res = await getJson<{ memories?: Memory[] } | Memory[]>(
        request,
        `/api/memory/search?q=${uniqueWord}`
      )
      const arr = Array.isArray(res) ? res : res.memories ?? []
      if (arr.some((m) => m.id === created.id)) {
        found = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(found).toBe(true)
  })
})
