/**
 * D-8 PR 3b — CLI config persistence (token + url).
 *
 * Exercises the small TOML reader/writer + env-var precedence path
 * used by every authenticated CLI call.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCliConfig, saveCliConfig, getCliConfigPath } from '../../utils/cli-config'

describe('cli-config', () => {
  let tmp: string
  let savedDir: string | undefined
  let savedUrl: string | undefined
  let savedToken: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fulcrum-cli-cfg-'))
    savedDir = process.env.FULCRUM_DIR
    savedUrl = process.env.FULCRUM_URL
    savedToken = process.env.FULCRUM_TOKEN
    process.env.FULCRUM_DIR = tmp
    delete process.env.FULCRUM_URL
    delete process.env.FULCRUM_TOKEN
  })

  afterEach(() => {
    if (savedDir !== undefined) process.env.FULCRUM_DIR = savedDir
    else delete process.env.FULCRUM_DIR
    if (savedUrl !== undefined) process.env.FULCRUM_URL = savedUrl
    else delete process.env.FULCRUM_URL
    if (savedToken !== undefined) process.env.FULCRUM_TOKEN = savedToken
    else delete process.env.FULCRUM_TOKEN
    rmSync(tmp, { recursive: true, force: true })
  })

  test('save then load round-trips url + token', () => {
    saveCliConfig({ url: 'https://fulcrum-acme.divinci.ai', token: 'fulc_abc123' })
    const cfg = loadCliConfig()
    expect(cfg.url).toBe('https://fulcrum-acme.divinci.ai')
    expect(cfg.token).toBe('fulc_abc123')
  })

  test('saves with 0600 perms (best-effort on platforms that support chmod)', () => {
    const path = saveCliConfig({ url: 'http://x', token: 'fulc_y' })
    if (process.platform === 'win32') {
      // Windows fs.chmod is a no-op; nothing to assert.
      return
    }
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('env vars override file values (FULCRUM_URL, FULCRUM_TOKEN)', () => {
    saveCliConfig({ url: 'http://from-file', token: 'fulc_from_file' })
    process.env.FULCRUM_URL = 'http://from-env'
    process.env.FULCRUM_TOKEN = 'fulc_from_env'
    const cfg = loadCliConfig()
    expect(cfg.url).toBe('http://from-env')
    expect(cfg.token).toBe('fulc_from_env')
  })

  test('missing file returns null fields, not an error', () => {
    const cfg = loadCliConfig()
    expect(cfg.url).toBeNull()
    expect(cfg.token).toBeNull()
  })

  test('corrupt file returns empty config rather than throwing', () => {
    const path = getCliConfigPath()
    // Write something that won't parse cleanly.
    saveCliConfig({ url: 'http://x' }) // ensure dir
    writeFileSync(path, 'this is not valid TOML\n[[[')
    const cfg = loadCliConfig()
    expect(cfg.url).toBeNull()
    expect(cfg.token).toBeNull()
  })

  test('round-trips escape sequences in URL and token', () => {
    const tricky = 'fulc_with\\backslash"quote'
    saveCliConfig({ url: 'http://has"quote', token: tricky })
    const text = readFileSync(getCliConfigPath(), 'utf8')
    // Quotes escaped on write
    expect(text).toContain('"http://has\\"quote"')
    expect(text).toContain('"fulc_with\\\\backslash\\"quote"')
    const cfg = loadCliConfig()
    expect(cfg.url).toBe('http://has"quote')
    expect(cfg.token).toBe(tricky)
  })

  test('getCliConfigPath honours FULCRUM_DIR', () => {
    expect(getCliConfigPath()).toBe(join(tmp, 'cli.toml'))
  })

  test('save creates the parent dir when missing', () => {
    // Use a nested FULCRUM_DIR that doesn't exist yet.
    process.env.FULCRUM_DIR = join(tmp, 'nested', 'fulcrum')
    saveCliConfig({ token: 'fulc_test' })
    expect(existsSync(join(tmp, 'nested', 'fulcrum', 'cli.toml'))).toBe(true)
  })
})
