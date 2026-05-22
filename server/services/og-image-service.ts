// satori + @resvg/resvg-js are native-backed (resvg ships a .node file). They
// are loaded lazily so the desktop bundle (`bun build --compile`) doesn't crash
// at startup on platforms where the .node binary isn't present. /og/* endpoints
// fail with a clean error if the load fails; the rest of the server keeps
// running. SaaS Docker ships the full node_modules so the lazy load succeeds.
import type SatoriType from 'satori'
import type { Resvg as ResvgType } from '@resvg/resvg-js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../lib/logger'

// Crash-proof logger wrapper. The catch handler in renderCached must never
// throw — if logger access misfires the way `log.error` did during D-15 deploy,
// we fall back to console.error so the underlying error still surfaces.
// Exported for unit testing — internal API otherwise.
export function safeLog(msg: string, ctx: Record<string, unknown>): void {
  try {
    log.og.error(msg, ctx)
  } catch {
    try {
      console.error(JSON.stringify({ src: 'OG', msg, ctx }))
    } catch {
      // Last resort — nothing else to do.
    }
  }
}

let satoriMod: typeof SatoriType | null = null
let ResvgCtor: typeof ResvgType | null = null

async function loadRenderer(): Promise<{ satori: typeof SatoriType; Resvg: typeof ResvgType }> {
  if (!satoriMod) {
    const m = await import('satori')
    satoriMod = (m.default ?? m) as typeof SatoriType
  }
  if (!ResvgCtor) {
    const m = await import('@resvg/resvg-js')
    ResvgCtor = m.Resvg
  }
  return { satori: satoriMod, Resvg: ResvgCtor }
}

const OG_WIDTH = 1200
const OG_HEIGHT = 630

const COLORS = {
  bg: '#0a0a0a',
  bgAccent: '#141414',
  border: '#262626',
  text: '#fafafa',
  textDim: '#a3a3a3',
  textFaint: '#525252',
  brand: '#f97316',
} as const

const STATUS_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  TO_DO: { bg: '#1f2937', fg: '#9ca3af', label: 'Todo' },
  IN_PROGRESS: { bg: '#1e3a8a', fg: '#93c5fd', label: 'Doing' },
  IN_REVIEW: { bg: '#78350f', fg: '#fcd34d', label: 'Review' },
  DONE: { bg: '#14532d', fg: '#86efac', label: 'Done' },
  CANCELED: { bg: '#450a0a', fg: '#fca5a5', label: 'Canceled' },
}

const PRIORITY_COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#eab308',
  low: '#737373',
}

type FontWeight = 400 | 700

let cachedFonts: { name: string; data: ArrayBuffer; weight: FontWeight; style: 'normal' }[] | null = null

// Exported for unit testing — internal API otherwise.
export function getFontDir(): string {
  // Production (SaaS Docker container, CLI bundle, desktop bundle): vite
  // already copied public/og-fonts/* to dist/og-fonts/. The Dockerfile only
  // ships dist/, not public/, so we MUST read from dist in any production
  // mode — matches the logic in server/app.ts getDistPath().
  if (process.env.NODE_ENV === 'production' || process.env.FULCRUM_PACKAGE_ROOT) {
    const distBase = process.env.FULCRUM_PACKAGE_ROOT
      ? join(process.env.FULCRUM_PACKAGE_ROOT, 'dist')
      : join(process.cwd(), 'dist')
    return join(distBase, 'og-fonts')
  }
  // Dev / tests: vite hasn't run, read directly from the source tree.
  return join(process.cwd(), 'public', 'og-fonts')
}

async function loadFonts() {
  if (cachedFonts) return cachedFonts
  const dir = getFontDir()
  const [regular, bold] = await Promise.all([
    readFile(join(dir, 'IBMPlexMono-Regular.woff')),
    readFile(join(dir, 'IBMPlexMono-Bold.woff')),
  ])
  // Bun's Buffer.buffer can include extra trailing bytes from the underlying
  // pool; slice to the exact byte range so satori parses a clean WOFF.
  const toArrayBuffer = (b: Buffer): ArrayBuffer =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  cachedFonts = [
    { name: 'IBM Plex Mono', data: toArrayBuffer(regular), weight: 400, style: 'normal' },
    { name: 'IBM Plex Mono', data: toArrayBuffer(bold), weight: 700, style: 'normal' },
  ]
  return cachedFonts
}

type OgElement = {
  type: string
  props: { style?: Record<string, unknown>; children?: OgElement | OgElement[] | string | number | null | undefined | (OgElement | string | number | null | undefined)[] }
}

function el(type: string, style: Record<string, unknown>, children?: OgElement['props']['children']): OgElement {
  return { type, props: { style, children } }
}

function statusBadge(status: string | null): OgElement {
  const cfg = STATUS_COLORS[status ?? 'TO_DO'] ?? STATUS_COLORS.TO_DO
  return el(
    'div',
    {
      display: 'flex',
      flexShrink: 0,
      backgroundColor: cfg.bg,
      color: cfg.fg,
      padding: '6px 16px',
      borderRadius: 999,
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    },
    cfg.label
  )
}

function metaPill(label: string, color: string): OgElement {
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      color: COLORS.textDim,
      fontSize: 24,
    },
    [
      el('div', { width: 10, height: 10, borderRadius: 999, backgroundColor: color, display: 'flex' }),
      el('div', { display: 'flex' }, label),
    ]
  )
}

function header(): OgElement {
  return el(
    'div',
    { display: 'flex', alignItems: 'center', gap: 16 },
    [
      el('div', {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: COLORS.brand,
        display: 'flex',
      }),
      el(
        'div',
        { color: COLORS.text, fontSize: 28, fontWeight: 700, letterSpacing: 2 },
        'FULCRUM'
      ),
    ]
  )
}

function footer(rightText: string): OgElement {
  return el(
    'div',
    {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
      width: '100%',
      color: COLORS.textFaint,
      fontSize: 22,
    },
    [
      el('div', { display: 'flex' }, 'Vibe Engineer’s Cockpit'),
      el('div', { display: 'flex' }, rightText),
    ]
  )
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max - 1) + '…'
}

export type TaskOgInput = {
  title: string
  status: string | null
  priority: string | null
  dueDate: string | null
  description: string | null
  projectName: string | null
  assigneeName: string | null
  host: string
}

function taskCard(input: TaskOgInput): OgElement {
  const metaItems: OgElement[] = []
  if (input.projectName) {
    metaItems.push(metaPill(input.projectName, COLORS.brand))
  }
  if (input.priority) {
    const color = PRIORITY_COLORS[input.priority] ?? COLORS.textFaint
    metaItems.push(metaPill(`${input.priority} priority`, color))
  }
  if (input.dueDate) {
    metaItems.push(metaPill(`Due ${input.dueDate}`, COLORS.textDim))
  }

  return el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: OG_WIDTH,
      height: OG_HEIGHT,
      boxSizing: 'border-box',
      backgroundColor: COLORS.bg,
      padding: 64,
      fontFamily: 'IBM Plex Mono',
      color: COLORS.text,
    },
    [
      el(
        'div',
        { display: 'flex', flexDirection: 'column', gap: 28, width: '100%' },
        [
          el(
            'div',
            { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
            [header(), statusBadge(input.status)]
          ),
          el(
            'div',
            {
              display: 'flex',
              fontSize: 52,
              fontWeight: 700,
              lineHeight: 1.15,
              color: COLORS.text,
              maxWidth: '100%',
            },
            truncate(input.title, 90)
          ),
          metaItems.length > 0
            ? el('div', { display: 'flex', gap: 32, flexWrap: 'wrap' }, metaItems)
            : el('div', { display: 'flex' }),
          input.description
            ? el(
                'div',
                { display: 'flex', color: COLORS.textDim, fontSize: 22, lineHeight: 1.4, maxWidth: '100%' },
                truncate(input.description, 140)
              )
            : el('div', { display: 'flex' }),
        ]
      ),
      footer(
        input.assigneeName ? `${input.assigneeName} · ${input.host}` : input.host
      ),
    ]
  )
}

export type ProjectOgInput = {
  name: string
  description: string | null
  taskCount: number | null
  host: string
}

function projectCard(input: ProjectOgInput): OgElement {
  return el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: OG_WIDTH,
      height: OG_HEIGHT,
      boxSizing: 'border-box',
      backgroundColor: COLORS.bg,
      padding: 64,
      fontFamily: 'IBM Plex Mono',
      color: COLORS.text,
    },
    [
      el(
        'div',
        { display: 'flex', flexDirection: 'column', gap: 28, width: '100%' },
        [
          el(
            'div',
            { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
            [
              header(),
              el(
                'div',
                {
                  display: 'flex',
                  backgroundColor: COLORS.bgAccent,
                  color: COLORS.textDim,
                  padding: '8px 18px',
                  borderRadius: 999,
                  border: `1px solid ${COLORS.border}`,
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                },
                'Project'
              ),
            ]
          ),
          el(
            'div',
            { display: 'flex', fontSize: 64, fontWeight: 700, lineHeight: 1.15, color: COLORS.text },
            truncate(input.name, 80)
          ),
          input.description
            ? el(
                'div',
                { display: 'flex', color: COLORS.textDim, fontSize: 26, lineHeight: 1.4, maxWidth: '100%' },
                truncate(input.description, 200)
              )
            : el('div', { display: 'flex' }),
          input.taskCount !== null
            ? el(
                'div',
                { display: 'flex', color: COLORS.brand, fontSize: 28, fontWeight: 700 },
                `${input.taskCount} task${input.taskCount === 1 ? '' : 's'}`
              )
            : el('div', { display: 'flex' }),
        ]
      ),
      footer(input.host),
    ]
  )
}

export type RepoOgInput = {
  name: string
  branch: string | null
  agent: string | null
  host: string
}

function repoCard(input: RepoOgInput): OgElement {
  return el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: OG_WIDTH,
      height: OG_HEIGHT,
      boxSizing: 'border-box',
      backgroundColor: COLORS.bg,
      padding: 64,
      fontFamily: 'IBM Plex Mono',
      color: COLORS.text,
    },
    [
      el(
        'div',
        { display: 'flex', flexDirection: 'column', gap: 28, width: '100%' },
        [
          el(
            'div',
            { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
            [
              header(),
              el(
                'div',
                {
                  display: 'flex',
                  backgroundColor: COLORS.bgAccent,
                  color: COLORS.textDim,
                  padding: '8px 18px',
                  borderRadius: 999,
                  border: `1px solid ${COLORS.border}`,
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                },
                'Repository'
              ),
            ]
          ),
          el(
            'div',
            { display: 'flex', fontSize: 60, fontWeight: 700, lineHeight: 1.15, color: COLORS.text },
            truncate(input.name, 80)
          ),
          el(
            'div',
            { display: 'flex', gap: 32, flexWrap: 'wrap' },
            [
              input.branch ? metaPill(input.branch, COLORS.brand) : null,
              input.agent ? metaPill(input.agent, COLORS.textDim) : null,
            ].filter((x): x is OgElement => x !== null)
          ),
        ]
      ),
      footer(input.host),
    ]
  )
}

export type GenericOgInput = {
  title: string
  subtitle: string
  badge: string
  host: string
}

function genericCard(input: GenericOgInput): OgElement {
  return el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: OG_WIDTH,
      height: OG_HEIGHT,
      boxSizing: 'border-box',
      backgroundColor: COLORS.bg,
      padding: 64,
      fontFamily: 'IBM Plex Mono',
      color: COLORS.text,
    },
    [
      el(
        'div',
        { display: 'flex', flexDirection: 'column', gap: 28, width: '100%' },
        [
          el(
            'div',
            { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
            [
              header(),
              el(
                'div',
                {
                  display: 'flex',
                  backgroundColor: COLORS.bgAccent,
                  color: COLORS.textDim,
                  padding: '8px 18px',
                  borderRadius: 999,
                  border: `1px solid ${COLORS.border}`,
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                },
                input.badge
              ),
            ]
          ),
          el(
            'div',
            { display: 'flex', fontSize: 64, fontWeight: 700, lineHeight: 1.15, color: COLORS.text },
            truncate(input.title, 80)
          ),
          el(
            'div',
            { display: 'flex', color: COLORS.textDim, fontSize: 26, lineHeight: 1.4 },
            truncate(input.subtitle, 200)
          ),
        ]
      ),
      footer(input.host),
    ]
  )
}

async function renderToPng(node: OgElement): Promise<Uint8Array> {
  const [{ satori, Resvg }, fonts] = await Promise.all([loadRenderer(), loadFonts()])
  // satori's type expects React elements; pass our plain-object equivalent.
  const svg = await satori(node as unknown as Parameters<typeof satori>[0], {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts,
  })
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: OG_WIDTH },
  })
  return resvg.render().asPng()
}

export async function renderTaskOg(input: TaskOgInput): Promise<Uint8Array> {
  return renderToPng(taskCard(input))
}

export async function renderProjectOg(input: ProjectOgInput): Promise<Uint8Array> {
  return renderToPng(projectCard(input))
}

export async function renderRepoOg(input: RepoOgInput): Promise<Uint8Array> {
  return renderToPng(repoCard(input))
}

export async function renderGenericOg(input: GenericOgInput): Promise<Uint8Array> {
  return renderToPng(genericCard(input))
}

const renderCache = new Map<string, { png: Uint8Array; expires: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

export async function renderCached(key: string, fn: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const now = Date.now()
  const hit = renderCache.get(key)
  if (hit && hit.expires > now) return hit.png
  try {
    const png = await fn()
    renderCache.set(key, { png, expires: now + CACHE_TTL_MS })
    return png
  } catch (err) {
    safeLog('OG render failed', {
      key,
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    throw err
  }
}

export function invalidateOgCache(key?: string) {
  if (key) renderCache.delete(key)
  else renderCache.clear()
}
