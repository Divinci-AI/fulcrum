import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { join } from 'node:path'
import { getFontDir, safeLog } from './og-image-service'
import { log } from '../lib/logger'

describe('getFontDir env matrix', () => {
  let prevNodeEnv: string | undefined
  let prevPackageRoot: string | undefined

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV
    prevPackageRoot = process.env.FULCRUM_PACKAGE_ROOT
  })
  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    if (prevPackageRoot === undefined) delete process.env.FULCRUM_PACKAGE_ROOT
    else process.env.FULCRUM_PACKAGE_ROOT = prevPackageRoot
  })

  test('dev mode (no NODE_ENV, no FULCRUM_PACKAGE_ROOT) reads from public/og-fonts', () => {
    delete process.env.NODE_ENV
    delete process.env.FULCRUM_PACKAGE_ROOT
    expect(getFontDir()).toBe(join(process.cwd(), 'public', 'og-fonts'))
  })

  test('NODE_ENV=development reads from public/og-fonts', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.FULCRUM_PACKAGE_ROOT
    expect(getFontDir()).toBe(join(process.cwd(), 'public', 'og-fonts'))
  })

  test('NODE_ENV=test reads from public/og-fonts', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.FULCRUM_PACKAGE_ROOT
    expect(getFontDir()).toBe(join(process.cwd(), 'public', 'og-fonts'))
  })

  // This is the case that broke the SaaS Docker deploy: Dockerfile sets
  // NODE_ENV=production but NOT FULCRUM_PACKAGE_ROOT, and only copies
  // dist/ (not public/) into the runtime container. Pre-fix the code
  // returned cwd/public/og-fonts which doesn't exist → ENOENT on every
  // /og/* request.
  test('NODE_ENV=production (Docker container, no FULCRUM_PACKAGE_ROOT) reads from dist/og-fonts', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.FULCRUM_PACKAGE_ROOT
    expect(getFontDir()).toBe(join(process.cwd(), 'dist', 'og-fonts'))
  })

  // CLI / desktop bundle path: bundled executable sets FULCRUM_PACKAGE_ROOT
  // to the install location, dist/og-fonts/ is shipped inside it.
  test('FULCRUM_PACKAGE_ROOT set (bundled CLI) reads from <root>/dist/og-fonts', () => {
    delete process.env.NODE_ENV
    process.env.FULCRUM_PACKAGE_ROOT = '/opt/fulcrum'
    expect(getFontDir()).toBe(join('/opt/fulcrum', 'dist', 'og-fonts'))
  })

  test('NODE_ENV=production AND FULCRUM_PACKAGE_ROOT — FULCRUM_PACKAGE_ROOT wins', () => {
    process.env.NODE_ENV = 'production'
    process.env.FULCRUM_PACKAGE_ROOT = '/opt/fulcrum'
    expect(getFontDir()).toBe(join('/opt/fulcrum', 'dist', 'og-fonts'))
  })
})

describe('safeLog crash-proof fallback', () => {
  let consoleErrorSpy: ReturnType<typeof mock>
  let origConsoleError: typeof console.error

  beforeEach(() => {
    origConsoleError = console.error
    consoleErrorSpy = mock(() => undefined)
    console.error = consoleErrorSpy as unknown as typeof console.error
  })
  afterEach(() => {
    console.error = origConsoleError
  })

  test('uses log.og.error in the happy path', () => {
    const origOgError = log.og.error
    const ogErrorSpy = mock((..._args: unknown[]) => undefined)
    log.og.error = ogErrorSpy as unknown as typeof log.og.error
    try {
      safeLog('test message', { foo: 'bar' })
      expect(ogErrorSpy).toHaveBeenCalledTimes(1)
      expect(consoleErrorSpy).not.toHaveBeenCalled()
    } finally {
      log.og.error = origOgError
    }
  })

  test('falls back to console.error if log.og.error throws', () => {
    const origOgError = log.og.error
    log.og.error = (() => {
      throw new Error('logger blew up')
    }) as unknown as typeof log.og.error
    try {
      // Must not throw — the whole point of safeLog
      expect(() => safeLog('test message', { foo: 'bar' })).not.toThrow()
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
      const callArg = consoleErrorSpy.mock.calls[0]?.[0]
      expect(typeof callArg).toBe('string')
      expect(callArg).toContain('"OG"')
      expect(callArg).toContain('test message')
      expect(callArg).toContain('"bar"')
    } finally {
      log.og.error = origOgError
    }
  })

  test('does not throw even if console.error also throws (silent last resort)', () => {
    const origOgError = log.og.error
    log.og.error = (() => {
      throw new Error('logger blew up')
    }) as unknown as typeof log.og.error
    console.error = (() => {
      throw new Error('console blew up too')
    }) as unknown as typeof console.error
    try {
      expect(() => safeLog('test message', { foo: 'bar' })).not.toThrow()
    } finally {
      log.og.error = origOgError
    }
  })

  test('JSON-stringifies the context payload', () => {
    const origOgError = log.og.error
    log.og.error = (() => {
      throw new Error('force fallback')
    }) as unknown as typeof log.og.error
    try {
      safeLog('render failed', { id: 'abc-123', stack: 'Error: at line 5' })
      const callArg = consoleErrorSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(callArg)
      expect(parsed.src).toBe('OG')
      expect(parsed.msg).toBe('render failed')
      expect(parsed.ctx.id).toBe('abc-123')
      expect(parsed.ctx.stack).toContain('Error: at line 5')
    } finally {
      log.og.error = origOgError
    }
  })
})
