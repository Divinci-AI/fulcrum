/**
 * z.ai model auto-refresh.
 *
 * z.ai version-pins every model ID (no `*-latest` alias) so when they ship a new
 * GLM-X.Y the existing mapping silently stays on the previous version until an
 * operator updates Settings → z.ai. This service polls z.ai's models endpoint
 * once a day, picks the newest flagship + turbo variant, and writes the new
 * mappings via updateZAiSettings when something changed.
 *
 * Selection rules:
 *  - **Haiku** = first `*-turbo` ID by version desc, else first `*-flash`/`*-flashx`,
 *    else first `*-air`/`*-airx`. Speed-cost tier.
 *  - **Sonnet & Opus** = newest flagship — a non-suffixed `glm-X[.Y]` ID, sorted
 *    by version desc. We intentionally don't downrate Sonnet to a cheaper tier;
 *    when an operator wants cost separation they can edit Settings manually
 *    and the refresher leaves their choice alone as long as the strings still
 *    appear in the model list.
 *
 * The refresher never touches `enabled` or `apiKey` — those are pure operator
 * concerns. It only swaps the three model strings.
 */
import { getZAiSettings, updateZAiSettings } from '../lib/settings/zai'
import { log } from '../lib/logger'

const MODELS_URL = 'https://api.z.ai/api/paas/v4/models'
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const INITIAL_DELAY_MS = 30 * 1000 // 30 seconds after boot

let pollTimer: ReturnType<typeof setInterval> | null = null
let bootTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Compare two GLM version strings (e.g. "glm-5.1" vs "glm-4.7"). Returns
 * positive when `a` is newer, negative when older, 0 when equal. Non-glm
 * strings sort last.
 */
function compareVersion(a: string, b: string): number {
  const parse = (id: string) => {
    const m = id.match(/^glm-(\d+)(?:\.(\d+))?/i)
    if (!m) return [-1, -1] as const
    return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] as const
  }
  const [aMaj, aMin] = parse(a)
  const [bMaj, bMin] = parse(b)
  if (aMaj !== bMaj) return aMaj - bMaj
  return aMin - bMin
}

/** True when the id is a non-variant flagship like `glm-5.1`, `glm-4.7`. */
function isFlagship(id: string): boolean {
  return /^glm-\d+(?:\.\d+)?$/i.test(id)
}

/** True when the id is a `*-turbo` variant. */
function isTurbo(id: string): boolean {
  return /^glm-\d+(?:\.\d+)?-turbo$/i.test(id)
}

/** True when the id is a `*-flash` / `*-flashx` variant. */
function isFlash(id: string): boolean {
  return /^glm-\d+(?:\.\d+)?-flash(?:x)?$/i.test(id)
}

/** True when the id is an `*-air` / `*-airx` variant. */
function isAir(id: string): boolean {
  return /^glm-\d+(?:\.\d+)?-air(?:x)?$/i.test(id)
}

export interface SelectedModels {
  haikuModel: string
  sonnetModel: string
  opusModel: string
}

/**
 * Apply the selection rules against a list of z.ai model IDs. Returns null
 * when no flagship can be found (the list is unrecognizable / empty).
 */
export function selectModels(ids: string[]): SelectedModels | null {
  const sorted = [...ids].sort((a, b) => compareVersion(b, a))
  const flagship = sorted.find(isFlagship)
  if (!flagship) return null

  const turbo = sorted.find(isTurbo)
  const flash = sorted.find(isFlash)
  const air = sorted.find(isAir)
  const haiku = turbo ?? flash ?? air ?? flagship

  return {
    haikuModel: haiku,
    sonnetModel: flagship,
    opusModel: flagship,
  }
}

/**
 * Run one refresh pass. Returns the new SelectedModels if anything changed,
 * null when no change or when refresh is skipped (disabled / no key / fetch
 * failed). Always non-throwing — every failure path logs and returns null.
 */
export async function refreshOnce(): Promise<SelectedModels | null> {
  const settings = getZAiSettings()
  if (!settings.enabled || !settings.apiKey) {
    log.server.debug('z.ai refresh skipped (disabled or no key)')
    return null
  }

  let ids: string[]
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${settings.apiKey}` },
    })
    if (!res.ok) {
      log.server.warn('z.ai refresh: models endpoint returned non-ok', {
        status: res.status,
        statusText: res.statusText,
      })
      return null
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> }
    ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
  } catch (err) {
    log.server.warn('z.ai refresh: fetch failed', { error: String(err) })
    return null
  }

  if (ids.length === 0) {
    log.server.warn('z.ai refresh: models endpoint returned empty list')
    return null
  }

  const selected = selectModels(ids)
  if (!selected) {
    log.server.warn('z.ai refresh: no flagship recognized in list', { sample: ids.slice(0, 5) })
    return null
  }

  const noChange =
    selected.haikuModel === settings.haikuModel &&
    selected.sonnetModel === settings.sonnetModel &&
    selected.opusModel === settings.opusModel
  if (noChange) {
    log.server.debug('z.ai refresh: no change', selected)
    return null
  }

  updateZAiSettings(selected)
  log.server.info('z.ai refresh: model mappings updated', {
    previous: {
      haikuModel: settings.haikuModel,
      sonnetModel: settings.sonnetModel,
      opusModel: settings.opusModel,
    },
    next: selected,
    candidateCount: ids.length,
  })
  return selected
}

/**
 * Start the daily auto-refresh loop. Idempotent — calling twice replaces the
 * existing timers. Fires an initial run 30s after boot to let other services
 * stabilize, then every 24h thereafter.
 */
export function startZAiRefresh(): void {
  stopZAiRefresh()
  bootTimer = setTimeout(() => {
    void refreshOnce()
  }, INITIAL_DELAY_MS)
  pollTimer = setInterval(() => {
    void refreshOnce()
  }, POLL_INTERVAL_MS)
}

export function stopZAiRefresh(): void {
  if (bootTimer) {
    clearTimeout(bootTimer)
    bootTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
