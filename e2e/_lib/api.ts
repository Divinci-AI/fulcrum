/**
 * Tiny helpers around Playwright's `request` fixture so specs stay terse.
 * All helpers fail loudly on non-2xx — Playwright shows the request URL
 * in the failure output, so debugging stays trivial.
 */
import type { APIRequestContext } from '@playwright/test'

export async function getJson<T = unknown>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path)
  if (!res.ok()) throw new Error(`GET ${path} → ${res.status()}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function postJson<T = unknown>(
  request: APIRequestContext,
  path: string,
  body: unknown
): Promise<T> {
  const res = await request.post(path, { data: body })
  if (!res.ok()) throw new Error(`POST ${path} → ${res.status()}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function patchJson<T = unknown>(
  request: APIRequestContext,
  path: string,
  body: unknown
): Promise<T> {
  const res = await request.patch(path, { data: body })
  if (!res.ok()) throw new Error(`PATCH ${path} → ${res.status()}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function del(request: APIRequestContext, path: string): Promise<void> {
  const res = await request.delete(path)
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`DELETE ${path} → ${res.status()}: ${await res.text()}`)
  }
}

/** Generate a unique-enough suffix per test so concurrent runs don't collide. */
export function uniq(prefix = 't'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Search-safe variant: alphanumeric + underscore only. Use for values that get
 * passed to FTS5 search endpoints. The default uniq() includes dashes, which
 * SQLite FTS5 parses as a column operator and rejects with "no such column".
 * (Tracked as a server-side bug — when fixed, the regular uniq() works.)
 */
export function uniqAlnum(prefix = 't'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
