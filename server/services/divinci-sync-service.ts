/**
 * Divinci RAG sync service (D-17 PR 2).
 *
 * Pushes Fulcrum tasks + projects into a Divinci collection (RagVectorModel
 * inside the configured Group) so the pre-flight retrieval landed in PR 1 has
 * actual content to surface. One Divinci file per Fulcrum entity, with the
 * Fulcrum entity URL baked into `sourceUrl` at upload time — so retrieved
 * chunks carry their Fulcrum URL inline, and Slack unfurls them naturally.
 *
 * Sync strategy:
 *  - Initial backfill on first run: every task + project gets uploaded.
 *  - Incremental on each tick: only entities whose content_hash has changed
 *    since the last successful sync get re-uploaded. Re-upload deletes the
 *    old Divinci file before creating a new one (in-place PATCH/migrate would
 *    be cheaper but requires a tighter Divinci API contract).
 *  - Deletes are detected lazily: if a Fulcrum entity row disappears, the
 *    next sync sweep removes its Divinci file and mapping row.
 *  - Rate-limited at ~2 uploads/sec to stay polite to Divinci's queue.
 *
 * Sync runs only when:
 *   - assistant.divinci.enabled = true
 *   - assistant.divinci.baseUrl, apiKey, groupId all set
 *   - assistant.divinci.collections.fulcrum = the target collectionId
 *
 * Started from server boot; gated re-check on every tick so toggling
 * Divinci enabled/disabled in Settings takes effect without a server restart.
 */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, tasks, projects, divinciSyncMappings } from '../db'
import type { DivinciSyncMapping } from '../db/schema'
import { getSettings } from '../lib/settings'
import { log } from '../lib/logger'

/** Sync tick cadence — 5 minutes balances staleness vs. Divinci API load. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000

/** Initial delay on server boot before the first sync, to let the DB settle. */
const BOOT_DELAY_MS = 15 * 1000

/** Inter-upload delay to rate-limit ourselves (2 req/sec). */
const UPLOAD_THROTTLE_MS = 500

interface SyncConfig {
  baseUrl: string
  apiKey: string
  collectionId: string
  publicDomain: string | null
}

interface SyncableEntity {
  entityType: 'task' | 'project'
  entityId: string
  /** Canonical text body uploaded to Divinci (used for content-hash diffing). */
  body: string
  /** Human-readable title for the Divinci file. */
  title: string
  /** Compact description (≤ 500 chars). */
  description: string
  /** sourceUrl param attached to the Divinci upload — appears on every chunk. */
  sourceUrl: string | null
}

let intervalId: ReturnType<typeof setInterval> | null = null
let running = false

export function startDivinciSync(): void {
  if (intervalId) return
  log.chat.info('Divinci sync timer starting', { intervalMs: SYNC_INTERVAL_MS, bootDelayMs: BOOT_DELAY_MS })
  setTimeout(() => {
    runDivinciSync().catch((err) =>
      log.chat.error('Divinci sync (boot) failed', { error: String(err) }),
    )
  }, BOOT_DELAY_MS)
  intervalId = setInterval(() => {
    runDivinciSync().catch((err) =>
      log.chat.error('Divinci sync (tick) failed', { error: String(err) }),
    )
  }, SYNC_INTERVAL_MS)
}

export function stopDivinciSync(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    log.chat.info('Divinci sync timer stopped')
  }
}

/**
 * One sync pass over all syncable Fulcrum entities. Idempotent + safe to
 * trigger out-of-band (e.g. from a future "sync now" admin button).
 */
export async function runDivinciSync(): Promise<{
  uploaded: number
  skipped: number
  deleted: number
  errors: number
}> {
  // Guard against re-entrance: ticks shouldn't overlap if the previous one
  // took longer than the interval (which can happen on a fresh backfill).
  if (running) {
    log.chat.info('Divinci sync: previous tick still running, skipping')
    return { uploaded: 0, skipped: 0, deleted: 0, errors: 0 }
  }
  running = true
  try {
    const cfg = readSyncConfig()
    if (!cfg) return { uploaded: 0, skipped: 0, deleted: 0, errors: 0 }

    const startMs = Date.now()
    const entities = await collectSyncableEntities(cfg)
    const existingMappings = await db
      .select()
      .from(divinciSyncMappings)
      .where(eq(divinciSyncMappings.collectionId, cfg.collectionId))
    const mappingByEntityKey = new Map(existingMappings.map((m) => [entityKey(m.entityType, m.entityId), m]))

    const stats = { uploaded: 0, skipped: 0, deleted: 0, errors: 0 }

    // (1) Upload new/changed entities.
    for (const entity of entities) {
      const hash = contentHash(entity.body)
      const existing = mappingByEntityKey.get(entityKey(entity.entityType, entity.entityId))
      if (existing && existing.contentHash === hash) {
        stats.skipped++
        continue
      }
      try {
        // Re-upload path: delete the old Divinci file first so the collection
        // doesn't accumulate stale copies. (Divinci doesn't expose a simple
        // "update file body" — migrate-target is overkill for one row.)
        if (existing) {
          await deleteDivinciFile(cfg, existing.divinciFileId).catch((err) => {
            log.chat.warn('Divinci sync: stale file delete failed (continuing)', {
              fileId: existing.divinciFileId,
              error: String(err),
            })
          })
        }
        const newFileId = await uploadEntityToDivinci(cfg, entity)
        if (!newFileId) {
          stats.errors++
          continue
        }
        await upsertMapping({
          entityType: entity.entityType,
          entityId: entity.entityId,
          collectionId: cfg.collectionId,
          divinciFileId: newFileId,
          contentHash: hash,
        })
        stats.uploaded++
        // Throttle ourselves so a 200-task backfill doesn't hammer Divinci.
        if (UPLOAD_THROTTLE_MS > 0) await sleep(UPLOAD_THROTTLE_MS)
      } catch (err) {
        log.chat.warn('Divinci sync: entity upload failed', {
          entityType: entity.entityType,
          entityId: entity.entityId,
          error: err instanceof Error ? err.message : String(err),
        })
        stats.errors++
      }
    }

    // (2) Detect deletes: any mapping whose entity no longer exists.
    const liveEntityKeys = new Set(entities.map((e) => entityKey(e.entityType, e.entityId)))
    const orphaned = existingMappings.filter((m) => !liveEntityKeys.has(entityKey(m.entityType, m.entityId)))
    for (const orphan of orphaned) {
      try {
        await deleteDivinciFile(cfg, orphan.divinciFileId)
        await db
          .delete(divinciSyncMappings)
          .where(eq(divinciSyncMappings.id, orphan.id))
        stats.deleted++
      } catch (err) {
        log.chat.warn('Divinci sync: orphan delete failed', {
          mappingId: orphan.id,
          divinciFileId: orphan.divinciFileId,
          error: String(err),
        })
        stats.errors++
      }
    }

    log.chat.info('Divinci sync tick done', {
      collectionId: cfg.collectionId,
      ...stats,
      durationMs: Date.now() - startMs,
    })
    return stats
  } finally {
    running = false
  }
}

/**
 * Resolve runtime config from settings. Returns null when sync should not run
 * (Divinci disabled, missing credentials, no Fulcrum collection ID).
 */
function readSyncConfig(): SyncConfig | null {
  const s = getSettings()
  const d = s.assistant.divinci
  if (!d.enabled) return null
  if (!d.baseUrl || !d.apiKey) return null
  const collectionId = d.collections.fulcrum
  if (!collectionId) return null
  return {
    baseUrl: d.baseUrl,
    apiKey: d.apiKey,
    collectionId,
    publicDomain: s.server.publicDomain,
  }
}

/**
 * Pull every task + project from Fulcrum's DB, render each as a markdown-ish
 * text body, and stamp a sourceUrl back to its Fulcrum web view. Exported
 * for unit testing.
 */
export async function collectSyncableEntities(cfg: SyncConfig): Promise<SyncableEntity[]> {
  const allTasks = await db.select().from(tasks)
  const allProjects = await db.select().from(projects)
  const projectNameById = new Map(allProjects.map((p) => [p.id, p.name]))

  const out: SyncableEntity[] = []

  for (const t of allTasks) {
    const projectName = t.projectId ? projectNameById.get(t.projectId) : null
    const lines: string[] = []
    lines.push(`# ${t.title}`)
    lines.push('')
    lines.push(`Status: ${t.status}`)
    if (t.priority) lines.push(`Priority: ${t.priority}`)
    if (t.dueDate) lines.push(`Due: ${t.dueDate}`)
    if (projectName) lines.push(`Project: ${projectName}`)
    if (t.repoName) lines.push(`Repository: ${t.repoName}`)
    if (t.branch) lines.push(`Branch: ${t.branch}`)
    if (t.prUrl) lines.push(`PR: ${t.prUrl}`)
    if (t.description?.trim()) {
      lines.push('')
      lines.push('## Description')
      lines.push('')
      lines.push(t.description.trim())
    }
    const body = lines.join('\n')
    out.push({
      entityType: 'task',
      entityId: t.id,
      body,
      title: `Fulcrum task: ${t.title}`,
      description: shortenForDescription(t.description) ?? `Status: ${t.status}`,
      sourceUrl: fulcrumUrlForEntity(cfg.publicDomain, 'task', t.id),
    })
  }

  for (const p of allProjects) {
    const lines: string[] = []
    lines.push(`# ${p.name}`)
    lines.push('')
    lines.push(`Status: ${p.status}`)
    if (p.description?.trim()) {
      lines.push('')
      lines.push('## Description')
      lines.push('')
      lines.push(p.description.trim())
    }
    if (p.notes?.trim()) {
      lines.push('')
      lines.push('## Notes')
      lines.push('')
      lines.push(p.notes.trim())
    }
    const body = lines.join('\n')
    out.push({
      entityType: 'project',
      entityId: p.id,
      body,
      title: `Fulcrum project: ${p.name}`,
      description: shortenForDescription(p.description) ?? `Status: ${p.status}`,
      sourceUrl: fulcrumUrlForEntity(cfg.publicDomain, 'project', p.id),
    })
  }

  return out
}

/**
 * Compute a Fulcrum web URL for an entity, given the configured public
 * domain. Returns null when no public domain is configured — sourceUrl is
 * optional on the Divinci side, so we just omit it.
 */
export function fulcrumUrlForEntity(
  publicDomain: string | null,
  entityType: 'task' | 'project',
  entityId: string,
): string | null {
  if (!publicDomain) return null
  const host = publicDomain.startsWith('http') ? publicDomain : `https://${publicDomain}`
  const trimmed = host.replace(/\/+$/, '')
  return entityType === 'task' ? `${trimmed}/tasks/${entityId}` : `${trimmed}/projects/${entityId}`
}

function shortenForDescription(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 497)}…`
}

function entityKey(type: string, id: string): string {
  return `${type}:${id}`
}

export function contentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

async function upsertMapping(row: Omit<DivinciSyncMapping, 'id' | 'createdAt' | 'lastSyncedAt'>): Promise<void> {
  const id = entityKey(row.entityType, row.entityId)
  const now = new Date().toISOString()
  // Delete-then-insert pattern keeps this driver-agnostic and avoids relying
  // on SQLite's ON CONFLICT semantics that Drizzle expresses awkwardly.
  await db.delete(divinciSyncMappings).where(eq(divinciSyncMappings.id, id))
  await db.insert(divinciSyncMappings).values({
    id,
    entityType: row.entityType,
    entityId: row.entityId,
    collectionId: row.collectionId,
    divinciFileId: row.divinciFileId,
    contentHash: row.contentHash,
    lastSyncedAt: now,
    createdAt: now,
  })
}

/**
 * Upload one entity to Divinci as a small text file. Returns the new file's
 * Divinci ID, or null when the upload failed (already logged).
 *
 * Divinci's `POST /api/v1/rag/files` expects multipart/form-data with at
 * least one `file` field. We use a Blob with text/plain MIME — Divinci's
 * langextract chunking tool handles plain text. The `sourceUrl` field
 * carries our Fulcrum URL, which Divinci stamps into chunk metadata so
 * retrieved chunks attribute back to the source.
 */
async function uploadEntityToDivinci(cfg: SyncConfig, entity: SyncableEntity): Promise<string | null> {
  const form = new FormData()
  form.append('title', entity.title)
  form.append('description', entity.description)
  form.append('chunkingTool', 'langextract')
  form.append('ragVectorId', cfg.collectionId)
  if (entity.sourceUrl) form.append('sourceUrl', entity.sourceUrl)
  form.append(
    'file',
    new Blob([entity.body], { type: 'text/plain' }),
    `${entity.entityType}-${entity.entityId}.md`,
  )

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v1/rag/files`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    log.chat.warn('Divinci sync: upload non-ok', {
      status: response.status,
      entityType: entity.entityType,
      entityId: entity.entityId,
      detail: detail.slice(0, 300),
    })
    return null
  }
  const text = await response.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    log.chat.warn('Divinci sync: upload returned non-JSON', { bodyPreview: text.slice(0, 200) })
    return null
  }
  // Divinci returns either { fileId } or { files: [{ _id, ... }] } depending
  // on path — be liberal in what we accept here.
  const direct = json.fileId
  if (typeof direct === 'string' && direct.length > 0) return direct
  const arr = json.files
  if (Array.isArray(arr) && arr.length > 0) {
    const first = arr[0] as { _id?: string; id?: string }
    if (typeof first._id === 'string' && first._id.length > 0) return first._id
    if (typeof first.id === 'string' && first.id.length > 0) return first.id
  }
  log.chat.warn('Divinci sync: upload response missing fileId', { keys: Object.keys(json) })
  return null
}

async function deleteDivinciFile(cfg: SyncConfig, fileId: string): Promise<void> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v1/rag/files/${encodeURIComponent(fileId)}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  })
  // 404 on delete is fine — file already gone, nothing to do.
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Divinci file delete returned ${response.status}: ${detail.slice(0, 200)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Test-only export: reset the in-process re-entrance guard so tests can call
 * runDivinciSync repeatedly without timing dependencies.
 */
export function _resetDivinciSyncForTesting(): void {
  running = false
}
