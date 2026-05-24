/**
 * Google Drive service (D-17 PR 6).
 *
 * Thin wrapper around the Drive v3 API used by the Divinci sync collector
 * to enumerate recently-modified files and export Google Docs / Sheets /
 * Slides content as plain text. Binary files (PDFs, images, etc.) are
 * surfaced as metadata-only chunks for v1 — text extraction is a future
 * follow-up.
 *
 * Uses the per-account OAuth2 client set up in google-oauth.ts; auto-
 * refreshes access tokens. Never throws on Drive API errors — returns
 * empty arrays or null so the sync tick stays fail-soft alongside the
 * other sources.
 */
import { google, type drive_v3 } from 'googleapis'
import { type OAuth2Client } from 'google-auth-library'
import { eq } from 'drizzle-orm'
import { db, googleAccounts } from '../../db'
import { getAuthenticatedClient } from '../google-oauth'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Google:Drive')

/** Drive file shape returned by listRecentDriveFiles. */
export interface DriveFileRecord {
  /** Drive file ID. */
  id: string
  /** Filename including extension. */
  name: string
  /** Drive MIME type, e.g. `application/vnd.google-apps.document`. */
  mimeType: string
  /** Last modified time (ISO 8601). */
  modifiedTime: string | null
  /** Drive web view URL (canonical user-facing URL for the file). */
  webViewLink: string | null
  /** Owner display name (first owner if multiple). */
  ownerName: string | null
  /** Owner email (first owner if multiple). */
  ownerEmail: string | null
  /** Plain-text content if exportable; null for binary types. */
  content: string | null
  /** Account this came from (used by the sync collector for source attribution). */
  googleAccountId: string
}

/** Max files fetched per Drive sync per account. Keeps tick latency bounded. */
const DEFAULT_MAX_FILES = 200

/** Days back from "now" to include in the modified-time window. */
const DEFAULT_DAYS_BACK = 90

/** Max characters of file content we'll embed per chunk (~4000 tokens). */
const MAX_EXPORT_CHARS = 16_000

/** Google-native MIME types that we can export as text/plain. */
const TEXT_EXPORTABLE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document', // Google Docs
  'application/vnd.google-apps.presentation', // Google Slides
])

/** Sheets gets a different export path (CSV). */
const SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet'

/**
 * List recently-modified Drive files for one Google account. Returns an
 * empty array on auth failure or API error (logged as warn). Caller does
 * NOT need to wrap in try/catch.
 */
export async function listRecentDriveFiles(
  googleAccountId: string,
  options: { maxFiles?: number; daysBack?: number } = {},
): Promise<DriveFileRecord[]> {
  const account = await db.select().from(googleAccounts).where(eq(googleAccounts.id, googleAccountId)).get()
  if (!account) {
    logger.warn('listRecentDriveFiles: account not found', { googleAccountId })
    return []
  }
  if (!account.driveEnabled) return []
  if (!Array.isArray(account.scopes) || !account.scopes.includes('https://www.googleapis.com/auth/drive.readonly')) {
    logger.warn('listRecentDriveFiles: missing drive.readonly scope; reauth required', { googleAccountId })
    return []
  }

  let client: OAuth2Client
  try {
    client = await getAuthenticatedClient(googleAccountId)
  } catch (err) {
    logger.warn('listRecentDriveFiles: auth client failed', {
      googleAccountId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const drive = google.drive({ version: 'v3', auth: client })
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const daysBack = options.daysBack ?? DEFAULT_DAYS_BACK
  const cutoffIso = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

  let files: drive_v3.Schema$File[]
  try {
    const response = await drive.files.list({
      // `modifiedTime >` is the cheapest filter; trashed excludes deleted-but-not-purged.
      // We use 'allDrives' so shared drives are included; corpora='user' would scope
      // to the user's own drive only.
      q: `modifiedTime > '${cutoffIso}' and trashed = false`,
      pageSize: Math.min(maxFiles, 1000),
      fields:
        'files(id, name, mimeType, modifiedTime, webViewLink, owners(displayName, emailAddress))',
      orderBy: 'modifiedTime desc',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    })
    files = response.data.files ?? []
  } catch (err) {
    logger.warn('listRecentDriveFiles: drive.files.list failed', {
      googleAccountId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const out: DriveFileRecord[] = []
  for (const f of files) {
    if (!f.id || !f.name || !f.mimeType) continue
    const content = await exportDriveFileText(drive, f.id, f.mimeType).catch(() => null)
    const owner = f.owners?.[0]
    out.push({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime ?? null,
      webViewLink: f.webViewLink ?? null,
      ownerName: owner?.displayName ?? null,
      ownerEmail: owner?.emailAddress ?? null,
      content,
      googleAccountId,
    })
  }

  // Mark the account's lastDriveSyncAt — useful for UI status surfaces.
  await db
    .update(googleAccounts)
    .set({ lastDriveSyncAt: new Date().toISOString() })
    .where(eq(googleAccounts.id, googleAccountId))

  logger.info('listRecentDriveFiles done', {
    googleAccountId,
    fetched: out.length,
    daysBack,
  })
  return out
}

/**
 * Export a Drive file as plain text when its MIME type supports it.
 * Returns null for binary / unsupported types — the caller indexes
 * those by metadata only.
 *
 * Exported for unit testing.
 */
export async function exportDriveFileText(
  drive: drive_v3.Drive,
  fileId: string,
  mimeType: string,
): Promise<string | null> {
  let exportMimeType: string | null = null
  if (TEXT_EXPORTABLE_MIME_TYPES.has(mimeType)) {
    exportMimeType = 'text/plain'
  } else if (mimeType === SHEET_MIME_TYPE) {
    exportMimeType = 'text/csv'
  } else if (mimeType === 'text/plain' || mimeType.startsWith('text/')) {
    // Already plain text — fetch via files.get with alt=media instead of export.
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' })
    const raw = typeof response.data === 'string' ? response.data : ''
    return raw.slice(0, MAX_EXPORT_CHARS)
  } else {
    return null
  }

  const response = await drive.files.export(
    { fileId, mimeType: exportMimeType },
    { responseType: 'text' },
  )
  const raw = typeof response.data === 'string' ? response.data : ''
  return raw.slice(0, MAX_EXPORT_CHARS)
}
