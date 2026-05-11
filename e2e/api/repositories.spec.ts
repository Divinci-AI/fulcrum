import { expect, test } from '@playwright/test'
import { del, getJson, postJson, uniq } from '../_lib/api'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'

interface Repository {
  id: string
  displayName: string
  path: string
}

// Static, no-user-input git commands. execFileSync avoids the shell entirely.
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.describe('repositories API', () => {
  let createdId: string | undefined
  let tempRepoPath: string | undefined

  test.beforeEach(async () => {
    // Skip when the Fulcrum target isn't on the same filesystem as the test
    // runner — registering a repo by path requires the Fulcrum process to be
    // able to stat that path. Set FULCRUM_E2E_LOCAL_FS=1 to opt in (when
    // Fulcrum is running locally or in a container with shared volume).
    if (!process.env.FULCRUM_E2E_LOCAL_FS) {
      test.skip(true, 'requires writable filesystem shared with Fulcrum process — set FULCRUM_E2E_LOCAL_FS=1')
    }
    tempRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fulcrum-e2e-repo-'))
    git(tempRepoPath, ['init', '-q'])
    fs.writeFileSync(path.join(tempRepoPath, 'README.md'), '# test\n')
    git(tempRepoPath, ['add', '.'])
    git(tempRepoPath, [
      '-c', 'user.email=e2e@test',
      '-c', 'user.name=e2e',
      'commit', '-q', '-m', 'init',
    ])
  })

  test.afterEach(async ({ request }) => {
    if (createdId) {
      await del(request, `/api/repositories/${createdId}`)
      createdId = undefined
    }
    if (tempRepoPath && fs.existsSync(tempRepoPath)) {
      fs.rmSync(tempRepoPath, { recursive: true, force: true })
      tempRepoPath = undefined
    }
  })

  test('GET /api/repositories returns an array', async ({ request }) => {
    const list = await getJson<Repository[]>(request, '/api/repositories')
    expect(Array.isArray(list)).toBe(true)
  })

  test('POST /api/repositories registers a local path', async ({ request }) => {
    const name = uniq('e2e-repo')
    const created = await postJson<Repository>(request, '/api/repositories', {
      path: tempRepoPath,
      displayName: name,
    })
    createdId = created.id
    expect(created.displayName).toBe(name)
    expect(created.path).toBe(tempRepoPath)
  })
})
