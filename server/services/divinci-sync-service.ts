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
import { db, tasks, projects, divinciSyncMappings, channelMessages, caldavEvents, caldavCalendars } from '../db'
import type { DivinciSyncMapping } from '../db/schema'
import { getSettings } from '../lib/settings'
import { log } from '../lib/logger'

/** Sync tick cadence — 5 minutes balances staleness vs. Divinci API load. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000

/** Initial delay on server boot before the first sync, to let the DB settle. */
const BOOT_DELAY_MS = 15 * 1000

/** Inter-upload delay to rate-limit ourselves (2 req/sec). */
const UPLOAD_THROTTLE_MS = 500

/** Shared HTTP-client config: same Divinci URL + API key for all sources. */
interface DivinciClientCfg {
  baseUrl: string
  apiKey: string
  publicDomain: string | null
}

/** Per-source sync target — the Divinci collection that holds one source's docs. */
interface SyncConfig extends DivinciClientCfg {
  collectionId: string
}

/**
 * One uploadable Fulcrum-side entity.
 * - `entityType` strings are namespaced per source ('task', 'project',
 *   'slack-day', 'gmail', 'calendar-event', 'drive-file', …) so mappings
 *   don't collide between sources sharing the same numeric id.
 */
export interface SyncableEntity {
  entityType: string
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

/**
 * A registered source contributing entities to the sync. Each source owns
 * its own Divinci collection (rolled up under the Group at retrieval time)
 * and its own enumeration logic.
 */
interface SyncSource {
  /** Source name for logs (e.g. 'fulcrum', 'slack'). */
  name: string
  /** Divinci collectionId (RagVectorModel _id) configured for this source, or null when unconfigured. */
  collectionId: string | null
  collect: (cfg: DivinciClientCfg) => Promise<SyncableEntity[]>
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
 * One sync pass across every configured source (Fulcrum, Slack, …). Each
 * source runs against its own Divinci collection, and stats are aggregated
 * for the tick log. Idempotent + safe to trigger out-of-band (e.g. from a
 * future "sync now" admin button).
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
    const baseCfg = readClientConfig()
    if (!baseCfg) return { uploaded: 0, skipped: 0, deleted: 0, errors: 0 }

    const tickStart = Date.now()
    const total = { uploaded: 0, skipped: 0, deleted: 0, errors: 0 }
    for (const source of registeredSources()) {
      if (!source.collectionId) continue
      const sourceStats = await syncCollection(baseCfg, source)
      total.uploaded += sourceStats.uploaded
      total.skipped += sourceStats.skipped
      total.deleted += sourceStats.deleted
      total.errors += sourceStats.errors
    }
    log.chat.info('Divinci sync tick done', {
      ...total,
      durationMs: Date.now() - tickStart,
    })
    return total
  } finally {
    running = false
  }
}

/**
 * Sync one source's entities to its Divinci collection. Pulled out of
 * `runDivinciSync` so PRs 3-6 can plug in new sources without forking the
 * upload/delete/diff logic.
 */
async function syncCollection(
  baseCfg: DivinciClientCfg,
  source: SyncSource,
): Promise<{ uploaded: number; skipped: number; deleted: number; errors: number }> {
  const stats = { uploaded: 0, skipped: 0, deleted: 0, errors: 0 }
  if (!source.collectionId) return stats
  const cfg: SyncConfig = { ...baseCfg, collectionId: source.collectionId }

  const startMs = Date.now()
  const entities = await source.collect(baseCfg)
  const existingMappings = await db
    .select()
    .from(divinciSyncMappings)
    .where(eq(divinciSyncMappings.collectionId, cfg.collectionId))
  const mappingByEntityKey = new Map(existingMappings.map((m) => [entityKey(m.entityType, m.entityId), m]))

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
            source: source.name,
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
      if (UPLOAD_THROTTLE_MS > 0) await sleep(UPLOAD_THROTTLE_MS)
    } catch (err) {
      log.chat.warn('Divinci sync: entity upload failed', {
        source: source.name,
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
      await db.delete(divinciSyncMappings).where(eq(divinciSyncMappings.id, orphan.id))
      stats.deleted++
    } catch (err) {
      log.chat.warn('Divinci sync: orphan delete failed', {
        source: source.name,
        mappingId: orphan.id,
        divinciFileId: orphan.divinciFileId,
        error: String(err),
      })
      stats.errors++
    }
  }

  log.chat.info('Divinci sync source done', {
    source: source.name,
    collectionId: cfg.collectionId,
    ...stats,
    durationMs: Date.now() - startMs,
  })
  return stats
}

/**
 * Read the shared Divinci-client config. Returns null when Divinci is
 * disabled or credentials are incomplete — no source should run in that
 * case.
 */
function readClientConfig(): DivinciClientCfg | null {
  const s = getSettings()
  const d = s.assistant.divinci
  if (!d.enabled) return null
  if (!d.baseUrl || !d.apiKey) return null
  return {
    baseUrl: d.baseUrl,
    apiKey: d.apiKey,
    publicDomain: s.server.publicDomain,
  }
}

/**
 * Registered sources contributing to sync. PR2 registers Fulcrum tasks +
 * projects; PRs 3-6 will add slack/gmail/calendar/drive here.
 */
function registeredSources(): SyncSource[] {
  const s = getSettings()
  const c = s.assistant.divinci.collections
  return [
    {
      name: 'fulcrum',
      collectionId: c.fulcrum,
      collect: collectSyncableEntities,
    },
    {
      name: 'slack',
      collectionId: c.slack,
      collect: collectSlackEntities,
    },
    {
      name: 'gmail',
      collectionId: c.gmail,
      collect: collectGmailEntities,
    },
    {
      name: 'calendar',
      collectionId: c.calendar,
      collect: collectCalendarEntities,
    },
  ]
}

/**
 * Pull every task + project from Fulcrum's DB, render each as a markdown-ish
 * text body, and stamp a sourceUrl back to its Fulcrum web view. Exported
 * for unit testing.
 */
export async function collectSyncableEntities(cfg: DivinciClientCfg): Promise<SyncableEntity[]> {
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
 * Slack sync — pulls Slack messages from `channelMessages` and rolls them up
 * into per-day documents (one Divinci file per `${connectionId}:${YYYY-MM-DD}`).
 *
 * Why day-rolled instead of one-file-per-message:
 *  - Volume: a chatty workspace produces 1,000+ messages/week. One file
 *    per row would blow Divinci's file count and our rate limit.
 *  - Conversational unit: a day's chatter is the natural retrieval unit
 *    for "what was discussed in #engineering yesterday?".
 *  - Stability: once a day rolls over, that day's file content stops
 *    changing — content-hash diff means only "today" re-uploads each tick.
 *
 * Window: last DEFAULT_SLACK_DAYS_BACK days (configurable later). Older
 * messages stay in Divinci once uploaded, but only days inside the window
 * get refreshed.
 */
export async function collectSlackEntities(cfg: DivinciClientCfg): Promise<SyncableEntity[]> {
  const daysBack = DEFAULT_SLACK_DAYS_BACK
  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000
  // Pull all Slack messages within the window. The schema doesn't index by
  // (channelType, messageTimestamp) — at typical Fulcrum scales (~5k messages
  // tops) a single scan + in-memory filter is fine. Switch to a partial
  // index if a tenant ever stores 100k+ Slack messages.
  const all = await db.select().from(channelMessages).where(eq(channelMessages.channelType, 'slack'))
  const recent = all.filter((m) => {
    const ts = Date.parse(m.messageTimestamp)
    return Number.isFinite(ts) && ts >= cutoffMs
  })

  // Group by (connectionId, day-in-UTC). UTC keeps the entityId stable across
  // server-timezone changes; the rendered body shows local times via toISOString.
  const buckets = new Map<string, typeof recent>()
  for (const m of recent) {
    const day = m.messageTimestamp.slice(0, 10) // YYYY-MM-DD from ISO ts
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const key = `${m.connectionId}:${day}`
    const arr = buckets.get(key) ?? []
    arr.push(m)
    buckets.set(key, arr)
  }

  const out: SyncableEntity[] = []
  for (const [key, messages] of buckets) {
    // Sort within the day so the rendered file reads as a transcript.
    messages.sort((a, b) => a.messageTimestamp.localeCompare(b.messageTimestamp))
    const [connectionId, day] = key.split(':')
    out.push(renderSlackDayEntity(cfg, connectionId, day, messages))
  }
  return out
}

/** Days of Slack history to keep refreshing each sync tick. */
const DEFAULT_SLACK_DAYS_BACK = 30

/** Format a single day's Slack messages as a markdown transcript. Exported for unit testing. */
export function renderSlackDayEntity(
  cfg: DivinciClientCfg,
  connectionId: string,
  day: string,
  messages: Array<{
    senderName: string | null
    senderId: string
    content: string
    messageTimestamp: string
    direction: string
  }>,
): SyncableEntity {
  const lines: string[] = []
  lines.push(`# Slack — ${day}`)
  lines.push('')
  lines.push(`Connection: ${connectionId}`)
  lines.push(`Messages: ${messages.length}`)
  lines.push('')
  for (const m of messages) {
    const time = m.messageTimestamp.slice(11, 16) // HH:MM from ISO
    const who = m.senderName || m.senderId
    const dir = m.direction === 'outgoing' ? ' (bot)' : ''
    const body = m.content.trim()
    if (!body) continue
    lines.push(`**${time}** ${who}${dir}:`)
    lines.push(body)
    lines.push('')
  }
  const body = lines.join('\n').trimEnd()
  return {
    entityType: 'slack-day',
    entityId: `${connectionId}:${day}`,
    body,
    title: `Slack ${day}`,
    description: `Slack messages on ${day}: ${messages.length} entries`,
    // Slack message permalinks need the team_id which the channelMessages
    // table doesn't store today. Leaving null — chunks will still self-cite
    // via the [Slack <day>] source attribution.
    sourceUrl: null,
  }
}

/**
 * Gmail sync — pulls email messages from `channelMessages` (channelType =
 * 'email', populated by the Gmail-API + IMAP ingest paths) and groups them
 * by Gmail threadId, one Divinci file per thread.
 *
 * Threads are the natural unit for email retrieval ("what was that thread
 * with Bob about Q2?"). Unlike Slack day-buckets, threads don't have a
 * natural rollover boundary — but the content-hash diff still keeps re-
 * uploads cheap: once a thread quiesces, its hash stops changing.
 *
 * Orphan messages without a threadId fall back to a single-message thread
 * keyed by the metadata.messageId. They still get indexed, just as their
 * own "thread of one".
 *
 * No time window for v1: Gmail threads stay relevant much longer than
 * Slack messages ("the contract negotiation from 6 months ago"). Backfill
 * is one-time-expensive; steady-state ticks are cheap.
 */
export async function collectGmailEntities(_cfg: DivinciClientCfg): Promise<SyncableEntity[]> {
  const all = await db.select().from(channelMessages).where(eq(channelMessages.channelType, 'email'))

  // Group by threadId, falling back to message-level key when absent.
  const threads = new Map<string, typeof all>()
  for (const m of all) {
    const meta = (m.metadata ?? {}) as { threadId?: string; messageId?: string; subject?: string }
    const key = meta.threadId ? `t:${meta.threadId}` : `m:${meta.messageId ?? m.id}`
    const arr = threads.get(key) ?? []
    arr.push(m)
    threads.set(key, arr)
  }

  const out: SyncableEntity[] = []
  for (const [key, messages] of threads) {
    messages.sort((a, b) => a.messageTimestamp.localeCompare(b.messageTimestamp))
    out.push(renderGmailThreadEntity(key, messages))
  }
  return out
}

/**
 * Render a single Gmail thread as a markdown transcript. Subject comes
 * from the first message's metadata; per-message blocks include from /
 * timestamp / body so the LLM can answer "who said what when" without
 * re-querying.
 *
 * Exported for unit testing.
 */
export function renderGmailThreadEntity(
  key: string, // 't:<threadId>' or 'm:<messageId>'
  messages: Array<{
    senderName: string | null
    senderId: string
    content: string
    messageTimestamp: string
    direction: string
    metadata: unknown
  }>,
): SyncableEntity {
  const first = messages[0]
  const meta = (first.metadata ?? {}) as { threadId?: string; subject?: string; messageId?: string }
  const subject = meta.subject?.trim() || '(no subject)'
  const threadId = key.startsWith('t:') ? key.slice(2) : null

  const lines: string[] = []
  lines.push(`# ${subject}`)
  lines.push('')
  if (threadId) lines.push(`Thread: ${threadId}`)
  lines.push(`Messages: ${messages.length}`)
  lines.push('')
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const who = m.senderName ? `${m.senderName} <${m.senderId}>` : m.senderId
    const dir = m.direction === 'outgoing' ? ' (sent)' : ''
    lines.push(`---`)
    lines.push(`**From:** ${who}${dir}`)
    lines.push(`**Date:** ${m.messageTimestamp}`)
    lines.push('')
    const body = m.content.trim()
    if (body) lines.push(body)
    lines.push('')
  }
  const body = lines.join('\n').trimEnd()
  return {
    entityType: 'gmail-thread',
    entityId: key,
    body,
    title: `Gmail: ${subject}`,
    description: `Gmail thread with ${messages.length} message${messages.length === 1 ? '' : 's'}: ${subject.slice(0, 200)}`,
    sourceUrl: threadId ? gmailThreadUrl(threadId) : null,
  }
}

/**
 * Build a Gmail web URL for a thread. The `u/0` path means "primary signed-in
 * account" — works for any operator viewing in the same browser session
 * they signed in with. Cross-account it'd be wrong but Mike has one Gmail
 * connected anyway. `#all/<threadId>` works across labels.
 */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`
}

/**
 * Calendar sync — pulls events from `caldavEvents`, which unifies both
 * generic CalDAV sources and Google Calendar (Google's events land here via
 * the googleAccountId-bound calendars). One Divinci file per event.
 *
 * Why per-event (vs. per-day or per-calendar bundles): each event is a
 * discrete retrieval unit. "When's my next 1:1 with Bob?" maps to one
 * row, not a day. Calendar volumes are bounded (humans schedule O(10)/day
 * tops), so per-event grain doesn't blow file count.
 *
 * Window: events whose dtstart falls within ±90 days. Calendar is mostly
 * forward-looking; we keep a quarter of recent history for queries like
 * "what did we discuss in last week's all-hands?" and a quarter forward
 * for upcoming.
 *
 * Recurring events: the underlying caldavEvents row stores the master
 * event with an RRULE — we don't expand recurrences. For now the first
 * dtstart determines window inclusion; the LLM can ask follow-ups about
 * future instances via the calendar MCP tool if needed.
 */
export async function collectCalendarEntities(_cfg: DivinciClientCfg): Promise<SyncableEntity[]> {
  const events = await db.select().from(caldavEvents)
  const calendars = await db.select().from(caldavCalendars)
  const calendarNameById = new Map(calendars.map((c) => [c.id, c.displayName ?? null]))

  const windowMs = DEFAULT_CALENDAR_DAYS_WINDOW * 24 * 60 * 60 * 1000
  const nowMs = Date.now()
  const inWindow = events.filter((e) => {
    if (!e.dtstart) return false
    // dtstart may be ISO datetime or YYYY-MM-DD for all-day; Date.parse
    // handles both (the latter as UTC midnight).
    const tMs = Date.parse(e.dtstart)
    if (!Number.isFinite(tMs)) return false
    return Math.abs(tMs - nowMs) <= windowMs
  })

  const out: SyncableEntity[] = []
  for (const e of inWindow) {
    const calendarName = calendarNameById.get(e.calendarId) ?? null
    out.push(renderCalendarEventEntity(e, calendarName))
  }
  return out
}

/** Days on either side of "now" we keep refreshed in the Divinci calendar collection. */
const DEFAULT_CALENDAR_DAYS_WINDOW = 90

/**
 * Render one calendar event as a markdown card. Includes the calendar name
 * for context so the LLM can disambiguate "personal" vs "work" overlap.
 * Exported for unit testing.
 */
export function renderCalendarEventEntity(
  event: {
    id: string
    calendarId: string
    summary: string | null
    description: string | null
    location: string | null
    dtstart: string | null
    dtend: string | null
    allDay: boolean | null
    organizer: string | null
    attendees: string[] | null
    status: string | null
    recurrenceRule: string | null
  },
  calendarName: string | null,
): SyncableEntity {
  const title = event.summary?.trim() || '(no title)'
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  if (calendarName) lines.push(`Calendar: ${calendarName}`)
  if (event.dtstart) {
    const when = event.dtend ? `${event.dtstart} → ${event.dtend}` : event.dtstart
    const tag = event.allDay ? ' (all-day)' : ''
    lines.push(`When: ${when}${tag}`)
  }
  if (event.location?.trim()) lines.push(`Where: ${event.location.trim()}`)
  if (event.organizer?.trim()) lines.push(`Organizer: ${event.organizer.trim()}`)
  if (event.attendees && event.attendees.length > 0) {
    const preview = event.attendees.slice(0, 8).join(', ')
    const more = event.attendees.length > 8 ? ` (+${event.attendees.length - 8} more)` : ''
    lines.push(`Attendees: ${preview}${more}`)
  }
  if (event.status?.trim()) lines.push(`Status: ${event.status.trim()}`)
  if (event.recurrenceRule?.trim()) lines.push(`Recurrence: ${event.recurrenceRule.trim()}`)
  if (event.description?.trim()) {
    lines.push('')
    lines.push('## Description')
    lines.push('')
    lines.push(event.description.trim())
  }
  const body = lines.join('\n').trimEnd()

  const dateLabel = event.dtstart ? event.dtstart.slice(0, 16) : 'undated'
  return {
    entityType: 'calendar-event',
    entityId: event.id,
    body,
    title: `Calendar: ${title}`,
    description: `${dateLabel} — ${calendarName ?? 'calendar'}: ${title}`.slice(0, 500),
    // Google calendar event URLs need a base64(eventId + ' ' + calendarId)
    // encoding that varies between Google's regular + service-account
    // calendars; CalDAV has no canonical web URL. Leave null; chunks
    // self-cite via the [Calendar: <name>] source line.
    sourceUrl: null,
  }
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
