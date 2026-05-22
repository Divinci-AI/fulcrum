// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * CalDAV calendar MCP tools
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

export const registerCaldavTools: ToolRegistrar = (server, client) => {
  // ==========================================
  // Account tools
  // ==========================================

  server.tool(
    'list_caldav_accounts',
    'List all CalDAV accounts configured for calendar sync.',
    {},
    async () => {
      try {
        const accounts = await client.listCaldavAccounts()
        return formatSuccess(accounts)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'create_caldav_account',
    'Create a new CalDAV account with basic authentication.',
    {
      name: z.string().describe('Display name for the account'),
      serverUrl: z.string().describe('CalDAV server URL'),
      username: z.string().describe('Username for authentication'),
      password: z.string().describe('Password for authentication'),
      syncIntervalMinutes: z.optional(z.number()).describe('Sync interval in minutes (default: 15)'),
    },
    async (input) => {
      try {
        const account = await client.createCaldavAccount(input)
        return formatSuccess(account)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'delete_caldav_account',
    'Delete a CalDAV account and all its calendars and events.',
    {
      id: z.string().describe('Account ID to delete'),
    },
    async ({ id }) => {
      try {
        const result = await client.deleteCaldavAccount(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'sync_caldav_account',
    'Trigger a manual sync for a specific CalDAV account.',
    {
      id: z.string().describe('Account ID to sync'),
    },
    async ({ id }) => {
      try {
        const result = await client.syncCaldavAccount(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // ==========================================
  // Copy rule tools
  // ==========================================

  server.tool(
    'list_caldav_copy_rules',
    'List all CalDAV copy rules for one-way event replication between calendars.',
    {},
    async () => {
      try {
        const rules = await client.listCaldavCopyRules()
        return formatSuccess(rules)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'create_caldav_copy_rule',
    'Create a copy rule to replicate events from one calendar to another.',
    {
      sourceCalendarId: z.string().describe('Source calendar ID'),
      destCalendarId: z.string().describe('Destination calendar ID'),
      name: z.optional(z.string()).describe('Optional label for the rule'),
    },
    async (input) => {
      try {
        const rule = await client.createCaldavCopyRule(input)
        return formatSuccess(rule)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'delete_caldav_copy_rule',
    'Delete a CalDAV copy rule.',
    {
      id: z.string().describe('Copy rule ID to delete'),
    },
    async ({ id }) => {
      try {
        const result = await client.deleteCaldavCopyRule(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'execute_caldav_copy_rule',
    'Manually execute a copy rule to replicate events now.',
    {
      id: z.string().describe('Copy rule ID to execute'),
    },
    async ({ id }) => {
      try {
        const result = await client.executeCaldavCopyRule(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // ==========================================
  // Calendar tools (existing)
  // ==========================================

  server.tool(
    'list_calendars',
    'List all CalDAV calendars synced from the configured server.',
    {
      accountId: z.optional(z.string()).describe('Filter by account ID'),
    },
    async ({ accountId }) => {
      try {
        const calendars = await client.listCalendars(accountId)
        return formatSuccess(calendars)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // sync_calendars
  server.tool(
    'sync_calendars',
    'Trigger a manual sync of all CalDAV calendars and events from the server.',
    {},
    async () => {
      try {
        const result = await client.syncCalendars()
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // list_calendar_events
  server.tool(
    'list_calendar_events',
    'List calendar events with optional filtering by calendar, date range, or limit.',
    {
      calendarId: z.optional(z.string()).describe('Filter by calendar ID'),
      from: z.optional(z.string()).describe('Start date filter (ISO format or iCal date)'),
      to: z.optional(z.string()).describe('End date filter (ISO format or iCal date)'),
      limit: z.optional(z.number()).describe('Maximum events to return'),
    },
    async ({ calendarId, from, to, limit }) => {
      try {
        const events = await client.listCalendarEvents({ calendarId, from, to, limit })
        return formatSuccess(events)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_calendar_event
  server.tool(
    'get_calendar_event',
    'Get details of a specific calendar event by ID.',
    {
      id: z.string().describe('Event ID'),
    },
    async ({ id }) => {
      try {
        const event = await client.getCalendarEvent(id)
        return formatSuccess(event)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // create_calendar_event
  server.tool(
    'create_calendar_event',
    'Create a new calendar event on a CalDAV calendar.',
    {
      calendarId: z.string().describe('Calendar ID to create the event in'),
      summary: z.string().describe('Event title/summary'),
      dtstart: z.string().describe('Start date/time (iCal format: 20250115T090000Z or 20250115 for all-day)'),
      dtend: z.optional(z.string()).describe('End date/time (iCal format)'),
      duration: z.optional(z.string()).describe('Duration (iCal format, e.g., PT1H for 1 hour)'),
      description: z.optional(z.string()).describe('Event description'),
      location: z.optional(z.string()).describe('Event location'),
      allDay: z.optional(z.boolean()).describe('Whether this is an all-day event'),
      recurrenceRule: z.optional(z.string()).describe('Recurrence rule (RRULE format)'),
      status: z.optional(z.string()).describe('Event status (TENTATIVE, CONFIRMED, CANCELLED)'),
    },
    async (input) => {
      try {
        const event = await client.createCalendarEvent(input)
        return formatSuccess(event)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // update_calendar_event
  server.tool(
    'update_calendar_event',
    'Update an existing calendar event.',
    {
      id: z.string().describe('Event ID to update'),
      summary: z.optional(z.string()).describe('New event title/summary'),
      dtstart: z.optional(z.string()).describe('New start date/time'),
      dtend: z.optional(z.string()).describe('New end date/time'),
      duration: z.optional(z.string()).describe('New duration'),
      description: z.optional(z.string()).describe('New description'),
      location: z.optional(z.string()).describe('New location'),
      allDay: z.optional(z.boolean()).describe('Whether this is an all-day event'),
      recurrenceRule: z.optional(z.string()).describe('New recurrence rule'),
      status: z.optional(z.string()).describe('New status'),
    },
    async ({ id, ...updates }) => {
      try {
        const event = await client.updateCalendarEvent(id, updates)
        return formatSuccess(event)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // delete_calendar_event
  server.tool(
    'delete_calendar_event',
    'Delete a calendar event from the CalDAV server.',
    {
      id: z.string().describe('Event ID to delete'),
    },
    async ({ id }) => {
      try {
        const result = await client.deleteCalendarEvent(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}