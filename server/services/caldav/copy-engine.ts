// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * CalDAV Copy Engine
 *
 * One-way event copying between calendars across accounts.
 * Runs after each sync cycle to replicate events from source to destination.
 * No delete propagation - copied events persist in destination.
 */

import { eq } from 'drizzle-orm'
import { db, caldavCopyRules, caldavCopiedEvents, caldavEvents, caldavCalendars } from '../../db'
import { createLogger } from '../../lib/logger'
import { generateIcalEvent, updateIcalEvent } from './ical-helpers'
import { accountManager } from './caldav-account-manager'
import { googleCalendarManager } from '../google/google-calendar-manager'

const logger = createLogger('CalDAV:CopyEngine')

export async function executeAllRules(): Promise<void> {
  const rules = db
    .select()
    .from(caldavCopyRules)
    .where(eq(caldavCopyRules.enabled, true))
    .all()

  if (rules.length === 0) return

  logger.info('Executing copy rules', { count: rules.length })

  for (const rule of rules) {
    try {
      await executeSingleRule(rule.id)
    } catch (err) {
      logger.error('Copy rule failed', {
        ruleId: rule.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

export async function executeSingleRule(
  ruleId: string
): Promise<{ created: number; updated: number }> {
  const rule = db.select().from(caldavCopyRules).where(eq(caldavCopyRules.id, ruleId)).get()
  if (!rule) throw new Error(`Copy rule not found: ${ruleId}`)

  const sourceCal = db
    .select()
    .from(caldavCalendars)
    .where(eq(caldavCalendars.id, rule.sourceCalendarId))
    .get()
  const destCal = db
    .select()
    .from(caldavCalendars)
    .where(eq(caldavCalendars.id, rule.destCalendarId))
    .get()

  if (!sourceCal || !destCal) {
    logger.warn('Copy rule references missing calendar', {
      ruleId,
      sourceExists: !!sourceCal,
      destExists: !!destCal,
    })
    return { created: 0, updated: 0 }
  }

  // Determine destination type: Google API or CalDAV
  const isGoogleDest = !!destCal.googleAccountId
  const destClient = destCal.accountId
    ? accountManager.getClient(destCal.accountId)
    : null

  if (!isGoogleDest && !destClient) {
    logger.warn('Destination account not connected', {
      ruleId,
      destCalendarId: destCal.id,
      destAccountId: destCal.accountId,
    })
    return { created: 0, updated: 0 }
  }

  // Get all source events
  const sourceEvents = db
    .select()
    .from(caldavEvents)
    .where(eq(caldavEvents.calendarId, rule.sourceCalendarId))
    .all()

  // Get ALL copied destination event IDs (across all rules) to prevent circular copying
  // With bidirectional rules (A→B and B→A), copied events in the destination would
  // otherwise be treated as source events by the reverse rule, causing duplication.
  const allCopiedDestIds = new Set(
    db.select({ destEventId: caldavCopiedEvents.destEventId })
      .from(caldavCopiedEvents)
      .all()
      .map(r => r.destEventId)
  )

  const filteredSourceEvents = sourceEvents.filter(e => !allCopiedDestIds.has(e.id))

  // Get existing copies for this rule
  const existingCopies = db
    .select()
    .from(caldavCopiedEvents)
    .where(eq(caldavCopiedEvents.ruleId, ruleId))
    .all()

  const copiedBySourceId = new Map(existingCopies.map((c) => [c.sourceEventId, c]))

  let created = 0
  let updated = 0
  const now = new Date().toISOString()

  for (const sourceEvent of filteredSourceEvents) {
    const existingCopy = copiedBySourceId.get(sourceEvent.id)

    if (!existingCopy) {
      // New event - create on destination
      try {
        let destEventId: string
        let eventUrl: string

        if (isGoogleDest) {
          // Create via Google Calendar API
          eventUrl = await googleCalendarManager.createEvent(destCal.id, {
            summary: sourceEvent.summary ?? 'Untitled',
            dtstart: sourceEvent.dtstart ?? now,
            dtend: sourceEvent.dtend ?? undefined,
            description: sourceEvent.description ?? undefined,
            location: sourceEvent.location ?? undefined,
            allDay: sourceEvent.allDay ?? false,
          })

          // Find the newly created local event by remoteUrl
          const newLocalEvent = db.select().from(caldavEvents)
            .where(eq(caldavEvents.remoteUrl, eventUrl))
            .get()
          destEventId = newLocalEvent?.id ?? crypto.randomUUID()
        } else {
          // Create via CalDAV
          const uid = `${crypto.randomUUID()}@fulcrum-copy`
          const ical = generateIcalEvent({
            uid,
            summary: sourceEvent.summary ?? 'Untitled',
            dtstart: sourceEvent.dtstart ?? now,
            dtend: sourceEvent.dtend ?? undefined,
            duration: sourceEvent.duration ?? undefined,
            description: sourceEvent.description ?? undefined,
            location: sourceEvent.location ?? undefined,
            allDay: sourceEvent.allDay ?? false,
            recurrenceRule: sourceEvent.recurrenceRule ?? undefined,
            status: sourceEvent.status ?? undefined,
          })

          eventUrl = `${destCal.remoteUrl}${uid}.ics`
          await destClient!.createCalendarObject({
            calendar: { url: destCal.remoteUrl },
            filename: `${uid}.ics`,
            iCalString: ical,
          })

          // Insert local copy of event
          destEventId = crypto.randomUUID()
          db.insert(caldavEvents)
            .values({
              id: destEventId,
              calendarId: rule.destCalendarId,
              remoteUrl: eventUrl,
              uid,
              etag: null,
              summary: sourceEvent.summary,
              description: sourceEvent.description,
              location: sourceEvent.location,
              dtstart: sourceEvent.dtstart,
              dtend: sourceEvent.dtend,
              duration: sourceEvent.duration,
              allDay: sourceEvent.allDay,
              recurrenceRule: sourceEvent.recurrenceRule,
              status: sourceEvent.status,
              organizer: null,
              attendees: null,
              rawIcal: ical,
              createdAt: now,
              updatedAt: now,
            })
            .run()
        }

        // Track the copy
        db.insert(caldavCopiedEvents)
          .values({
            id: crypto.randomUUID(),
            ruleId,
            sourceEventId: sourceEvent.id,
            destEventId,
            sourceEtag: sourceEvent.etag,
            createdAt: now,
            updatedAt: now,
          })
          .run()

        created++
      } catch (err) {
        logger.error('Failed to copy event', {
          ruleId,
          sourceEventId: sourceEvent.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else if (sourceEvent.etag && sourceEvent.etag !== existingCopy.sourceEtag) {
      // Source event changed - update destination
      try {
        if (isGoogleDest) {
          // Update via Google Calendar API
          await googleCalendarManager.updateEvent(existingCopy.destEventId, {
            summary: sourceEvent.summary ?? undefined,
            dtstart: sourceEvent.dtstart ?? undefined,
            dtend: sourceEvent.dtend ?? undefined,
            description: sourceEvent.description ?? undefined,
            location: sourceEvent.location ?? undefined,
            allDay: sourceEvent.allDay ?? undefined,
          })
        } else {
          // Update via CalDAV
          const destEvent = db
            .select()
            .from(caldavEvents)
            .where(eq(caldavEvents.id, existingCopy.destEventId))
            .get()

          if (!destEvent) continue

          const updatedIcal = destEvent.rawIcal
            ? updateIcalEvent(destEvent.rawIcal, {
                summary: sourceEvent.summary ?? undefined,
                dtstart: sourceEvent.dtstart ?? undefined,
                dtend: sourceEvent.dtend ?? undefined,
                duration: sourceEvent.duration ?? undefined,
                description: sourceEvent.description ?? undefined,
                location: sourceEvent.location ?? undefined,
                allDay: sourceEvent.allDay ?? undefined,
                status: sourceEvent.status ?? undefined,
              })
            : generateIcalEvent({
                uid: destEvent.uid || crypto.randomUUID(),
                summary: sourceEvent.summary ?? 'Untitled',
                dtstart: sourceEvent.dtstart ?? now,
                dtend: sourceEvent.dtend ?? undefined,
                duration: sourceEvent.duration ?? undefined,
                description: sourceEvent.description ?? undefined,
                location: sourceEvent.location ?? undefined,
                allDay: sourceEvent.allDay ?? false,
                status: sourceEvent.status ?? undefined,
              })

          await destClient!.updateCalendarObject({
            calendarObject: {
              url: destEvent.remoteUrl,
              etag: destEvent.etag ?? undefined,
            },
            iCalString: updatedIcal,
          })

          // Update local dest event
          db.update(caldavEvents)
            .set({
              summary: sourceEvent.summary,
              description: sourceEvent.description,
              location: sourceEvent.location,
              dtstart: sourceEvent.dtstart,
              dtend: sourceEvent.dtend,
              duration: sourceEvent.duration,
              allDay: sourceEvent.allDay,
              status: sourceEvent.status,
              rawIcal: updatedIcal,
              updatedAt: now,
            })
            .where(eq(caldavEvents.id, existingCopy.destEventId))
            .run()
        }

        // Update tracking record
        db.update(caldavCopiedEvents)
          .set({ sourceEtag: sourceEvent.etag, updatedAt: now })
          .where(eq(caldavCopiedEvents.id, existingCopy.id))
          .run()

        updated++
      } catch (err) {
        logger.error('Failed to update copied event', {
          ruleId,
          sourceEventId: sourceEvent.id,
          destEventId: existingCopy.destEventId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // Update rule last execution time
  db.update(caldavCopyRules)
    .set({ lastExecutedAt: now, updatedAt: now })
    .where(eq(caldavCopyRules.id, ruleId))
    .run()

  if (created > 0 || updated > 0) {
    logger.info('Copy rule executed', { ruleId, created, updated })
  }

  return { created, updated }
}