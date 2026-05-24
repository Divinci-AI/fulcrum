import { describe, test, expect, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  contentHash,
  fulcrumUrlForEntity,
  collectSyncableEntities,
  collectSlackEntities,
  renderSlackDayEntity,
  collectGmailEntities,
  renderGmailThreadEntity,
  gmailThreadUrl,
  collectCalendarEntities,
  renderCalendarEventEntity,
  _resetDivinciSyncForTesting,
} from './divinci-sync-service'
import { db, tasks, projects, divinciSyncMappings, channelMessages, caldavEvents, caldavCalendars } from '../db'

const baseCfg = {
  baseUrl: 'https://api.divinci.ai',
  apiKey: 'k',
  collectionId: 'col-1',
  publicDomain: 'https://fulcrum-acme.divinci.ai',
}

async function clearTables(): Promise<void> {
  // Order matters — clear children/mappings before parents if there were FKs.
  await db.delete(divinciSyncMappings)
  await db.delete(tasks)
  await db.delete(projects)
  await db.delete(channelMessages)
  await db.delete(caldavEvents)
  await db.delete(caldavCalendars)
}

beforeEach(async () => {
  _resetDivinciSyncForTesting()
  await clearTables()
})

describe('divinci-sync-service.contentHash', () => {
  test('is stable for identical input', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'))
  })

  test('changes when input changes', () => {
    expect(contentHash('hello')).not.toBe(contentHash('hello!'))
  })

  test('produces a 64-char hex string (SHA-256)', () => {
    expect(contentHash('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('divinci-sync-service.fulcrumUrlForEntity', () => {
  test('returns null when no public domain configured', () => {
    expect(fulcrumUrlForEntity(null, 'task', 'abc')).toBeNull()
  })

  test('builds https://<host>/tasks/<id> for tasks', () => {
    expect(fulcrumUrlForEntity('fulcrum-acme.divinci.ai', 'task', 'abc')).toBe(
      'https://fulcrum-acme.divinci.ai/tasks/abc',
    )
  })

  test('builds https://<host>/projects/<id> for projects', () => {
    expect(fulcrumUrlForEntity('fulcrum-acme.divinci.ai', 'project', 'p1')).toBe(
      'https://fulcrum-acme.divinci.ai/projects/p1',
    )
  })

  test('respects a baseUrl that already includes scheme', () => {
    expect(fulcrumUrlForEntity('http://localhost:7777', 'task', 'abc')).toBe(
      'http://localhost:7777/tasks/abc',
    )
  })

  test('strips trailing slashes from the public domain', () => {
    expect(fulcrumUrlForEntity('https://example.com///', 'task', 'abc')).toBe(
      'https://example.com/tasks/abc',
    )
  })
})

describe('divinci-sync-service.collectSyncableEntities', () => {
  test('returns empty when no tasks or projects exist', async () => {
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities).toEqual([])
  })

  test('renders a task body with title, status, and description', async () => {
    await db.insert(tasks).values({
      id: 't1',
      title: 'Ship D-17 PR 2',
      description: 'Sync Fulcrum tasks into Divinci collections.',
      status: 'IN_PROGRESS',
      position: 0,
      agent: 'claude',
      priority: 'high',
      dueDate: '2026-05-30',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities.length).toBe(1)
    const t = entities[0]
    expect(t.entityType).toBe('task')
    expect(t.entityId).toBe('t1')
    expect(t.title).toBe('Fulcrum task: Ship D-17 PR 2')
    expect(t.body).toContain('# Ship D-17 PR 2')
    expect(t.body).toContain('Status: IN_PROGRESS')
    expect(t.body).toContain('Priority: high')
    expect(t.body).toContain('Due: 2026-05-30')
    expect(t.body).toContain('Sync Fulcrum tasks into Divinci collections.')
    expect(t.sourceUrl).toBe('https://fulcrum-acme.divinci.ai/tasks/t1')
  })

  test('skips empty description without producing the "## Description" header', async () => {
    await db.insert(tasks).values({
      id: 't-empty',
      title: 'No body',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities[0].body).not.toContain('## Description')
  })

  test('joins task to project name when project exists', async () => {
    await db.insert(projects).values({
      id: 'p1',
      name: 'Boundless',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await db.insert(tasks).values({
      id: 't-with-project',
      title: 'Task in project',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      projectId: 'p1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    const t = entities.find((e) => e.entityId === 't-with-project')
    expect(t?.body).toContain('Project: Boundless')
  })

  test('produces a project entity with description + notes', async () => {
    await db.insert(projects).values({
      id: 'p2',
      name: 'Founder stack',
      description: 'AI coaching for founders',
      notes: 'Phase 4: pitch deck.',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    const p = entities.find((e) => e.entityType === 'project')
    expect(p).toBeDefined()
    expect(p!.title).toBe('Fulcrum project: Founder stack')
    expect(p!.body).toContain('AI coaching for founders')
    expect(p!.body).toContain('Phase 4: pitch deck.')
    expect(p!.sourceUrl).toBe('https://fulcrum-acme.divinci.ai/projects/p2')
  })

  test('omits sourceUrl when no public domain is configured', async () => {
    await db.insert(tasks).values({
      id: 't-no-url',
      title: 'X',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities({ ...baseCfg, publicDomain: null })
    expect(entities[0].sourceUrl).toBeNull()
  })

  test('shortens descriptions over 500 chars in the file-description field', async () => {
    const longDesc = 'x'.repeat(800)
    await db.insert(tasks).values({
      id: 't-long',
      title: 'Long',
      description: longDesc,
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const entities = await collectSyncableEntities(baseCfg)
    expect(entities[0].description.length).toBeLessThanOrEqual(500)
    expect(entities[0].description.endsWith('…')).toBe(true)
  })
})

describe('divinci-sync-service.collectSyncableEntities content-hash diffing', () => {
  // Sanity check: two unchanged tasks produce identical hashes, but editing
  // the title changes the hash. This is the contract runDivinciSync relies on
  // to skip uploads for unchanged entities.
  test('identical task body yields identical hash; edited task body yields different', async () => {
    await db.insert(tasks).values({
      id: 't',
      title: 'A',
      description: 'd',
      status: 'TO_DO',
      position: 0,
      agent: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const e1 = await collectSyncableEntities(baseCfg)
    const h1 = contentHash(e1[0].body)
    const e2 = await collectSyncableEntities(baseCfg)
    expect(contentHash(e2[0].body)).toBe(h1)
    // Mutate the title
    await db.update(tasks).set({ title: 'B' }).where(eq(tasks.id, 't'))
    const e3 = await collectSyncableEntities(baseCfg)
    expect(contentHash(e3[0].body)).not.toBe(h1)
  })
})

describe('divinci-sync-service.renderSlackDayEntity', () => {
  test('renders a markdown transcript with title, count, and per-message lines', () => {
    const entity = renderSlackDayEntity(
      { baseUrl: '', apiKey: '', publicDomain: null },
      'slack-channel',
      '2026-05-23',
      [
        {
          senderName: 'Mike',
          senderId: 'U05',
          content: 'Shipping D-17 PR 3',
          messageTimestamp: '2026-05-23T14:35:00.000Z',
          direction: 'incoming',
        },
        {
          senderName: 'Fulcrum bot',
          senderId: 'B0A',
          content: 'Acknowledged',
          messageTimestamp: '2026-05-23T14:36:12.000Z',
          direction: 'outgoing',
        },
      ],
    )
    expect(entity.entityType).toBe('slack-day')
    expect(entity.entityId).toBe('slack-channel:2026-05-23')
    expect(entity.title).toBe('Slack 2026-05-23')
    expect(entity.body).toContain('# Slack — 2026-05-23')
    expect(entity.body).toContain('Messages: 2')
    expect(entity.body).toContain('**14:35** Mike')
    expect(entity.body).toContain('Shipping D-17 PR 3')
    expect(entity.body).toContain('**14:36** Fulcrum bot (bot)')
    expect(entity.body).toContain('Acknowledged')
    // PR 3 leaves Slack permalink construction for a future PR (needs team_id).
    expect(entity.sourceUrl).toBeNull()
  })

  test('skips empty-content messages (e.g. bot system events)', () => {
    const entity = renderSlackDayEntity(
      { baseUrl: '', apiKey: '', publicDomain: null },
      'c',
      '2026-05-23',
      [
        { senderName: 'A', senderId: 'a', content: '', messageTimestamp: '2026-05-23T10:00:00Z', direction: 'incoming' },
        { senderName: 'B', senderId: 'b', content: 'hi', messageTimestamp: '2026-05-23T10:01:00Z', direction: 'incoming' },
      ],
    )
    expect(entity.body).not.toContain('**10:00**')
    expect(entity.body).toContain('**10:01** B')
  })

  test('falls back to senderId when senderName is missing', () => {
    const entity = renderSlackDayEntity(
      { baseUrl: '', apiKey: '', publicDomain: null },
      'c',
      '2026-05-23',
      [{ senderName: null, senderId: 'U07ABCDEF', content: 'hi', messageTimestamp: '2026-05-23T10:00:00Z', direction: 'incoming' }],
    )
    expect(entity.body).toContain('U07ABCDEF')
  })
})

describe('divinci-sync-service.collectSlackEntities', () => {
  test('returns empty when no Slack rows exist', async () => {
    const entities = await collectSlackEntities(baseCfg)
    expect(entities).toEqual([])
  })

  test('ignores non-slack channel rows', async () => {
    await db.insert(channelMessages).values({
      id: 'm1',
      channelType: 'discord',
      connectionId: 'c1',
      direction: 'incoming',
      senderId: 'u1',
      content: 'hi',
      messageTimestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    })
    const entities = await collectSlackEntities(baseCfg)
    expect(entities).toEqual([])
  })

  test('groups messages into one entity per (connectionId, day)', async () => {
    const todayIso = new Date().toISOString()
    const today = todayIso.slice(0, 10)
    await db.insert(channelMessages).values([
      {
        id: 's1',
        channelType: 'slack',
        connectionId: 'slack-channel',
        direction: 'incoming',
        senderId: 'U1',
        senderName: 'Mike',
        content: 'hello',
        messageTimestamp: todayIso,
        createdAt: todayIso,
      },
      {
        id: 's2',
        channelType: 'slack',
        connectionId: 'slack-channel',
        direction: 'incoming',
        senderId: 'U1',
        senderName: 'Mike',
        content: 'world',
        messageTimestamp: todayIso,
        createdAt: todayIso,
      },
    ])
    const entities = await collectSlackEntities(baseCfg)
    expect(entities.length).toBe(1)
    expect(entities[0].entityId).toBe(`slack-channel:${today}`)
    expect(entities[0].body).toContain('hello')
    expect(entities[0].body).toContain('world')
  })

  test('drops messages older than the configured window', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() // 60d ago
    await db.insert(channelMessages).values({
      id: 'old',
      channelType: 'slack',
      connectionId: 'c',
      direction: 'incoming',
      senderId: 'U',
      content: 'ancient',
      messageTimestamp: old,
      createdAt: old,
    })
    const entities = await collectSlackEntities(baseCfg)
    expect(entities).toEqual([])
  })
})

describe('divinci-sync-service.gmailThreadUrl', () => {
  test('builds the #all/<threadId> permalink shape', () => {
    expect(gmailThreadUrl('18c2a3b4d5e6f7a8')).toBe(
      'https://mail.google.com/mail/u/0/#all/18c2a3b4d5e6f7a8',
    )
  })
})

describe('divinci-sync-service.renderGmailThreadEntity', () => {
  test('renders a thread with subject, per-message blocks, and a Gmail URL', () => {
    const entity = renderGmailThreadEntity('t:THREAD42', [
      {
        senderName: 'Alice',
        senderId: 'alice@example.com',
        content: 'Hey Mike, what about Q2?',
        messageTimestamp: '2026-05-20T14:00:00.000Z',
        direction: 'incoming',
        metadata: { threadId: 'THREAD42', subject: 'Q2 numbers' },
      },
      {
        senderName: 'Mike',
        senderId: 'mike@divinci.ai',
        content: 'Up 38% MoM',
        messageTimestamp: '2026-05-20T15:00:00.000Z',
        direction: 'outgoing',
        metadata: { threadId: 'THREAD42', subject: 'Q2 numbers' },
      },
    ])
    expect(entity.entityType).toBe('gmail-thread')
    expect(entity.entityId).toBe('t:THREAD42')
    expect(entity.title).toBe('Gmail: Q2 numbers')
    expect(entity.body).toContain('# Q2 numbers')
    expect(entity.body).toContain('Thread: THREAD42')
    expect(entity.body).toContain('Messages: 2')
    expect(entity.body).toContain('Alice <alice@example.com>')
    expect(entity.body).toContain('Mike <mike@divinci.ai> (sent)')
    expect(entity.body).toContain('Hey Mike, what about Q2?')
    expect(entity.body).toContain('Up 38% MoM')
    expect(entity.sourceUrl).toBe('https://mail.google.com/mail/u/0/#all/THREAD42')
  })

  test('falls back to (no subject) and omits sourceUrl when threadId absent', () => {
    const entity = renderGmailThreadEntity('m:MSG9', [
      {
        senderName: null,
        senderId: 'someone@x.com',
        content: 'standalone',
        messageTimestamp: '2026-05-20T10:00:00.000Z',
        direction: 'incoming',
        metadata: { messageId: 'MSG9' },
      },
    ])
    expect(entity.title).toBe('Gmail: (no subject)')
    expect(entity.body).toContain('(no subject)')
    expect(entity.body).not.toContain('Thread:')
    expect(entity.sourceUrl).toBeNull()
  })
})

describe('divinci-sync-service.collectGmailEntities', () => {
  test('returns empty when no email rows exist', async () => {
    const entities = await collectGmailEntities(baseCfg)
    expect(entities).toEqual([])
  })

  test('groups messages by threadId into one thread file each', async () => {
    const now = new Date().toISOString()
    await db.insert(channelMessages).values([
      {
        id: 'e1',
        channelType: 'email',
        connectionId: 'email-channel',
        direction: 'incoming',
        senderId: 'a@x.com',
        senderName: 'A',
        content: 'first message in thread T',
        metadata: { threadId: 'T', subject: 'topic A' },
        messageTimestamp: now,
        createdAt: now,
      },
      {
        id: 'e2',
        channelType: 'email',
        connectionId: 'email-channel',
        direction: 'outgoing',
        senderId: 'me@x.com',
        senderName: 'Me',
        content: 'reply in thread T',
        metadata: { threadId: 'T', subject: 'Re: topic A' },
        messageTimestamp: new Date(Date.now() + 1000).toISOString(),
        createdAt: now,
      },
      {
        id: 'e3',
        channelType: 'email',
        connectionId: 'email-channel',
        direction: 'incoming',
        senderId: 'b@x.com',
        senderName: 'B',
        content: 'different thread',
        metadata: { threadId: 'U', subject: 'topic B' },
        messageTimestamp: now,
        createdAt: now,
      },
    ])
    const entities = await collectGmailEntities(baseCfg)
    expect(entities.length).toBe(2)
    const t = entities.find((e) => e.entityId === 't:T')
    const u = entities.find((e) => e.entityId === 't:U')
    expect(t?.body).toContain('first message in thread T')
    expect(t?.body).toContain('reply in thread T')
    expect(u?.body).toContain('different thread')
  })

  test('orphan message without threadId gets its own m:<messageId> entity', async () => {
    const now = new Date().toISOString()
    await db.insert(channelMessages).values({
      id: 'orphan1',
      channelType: 'email',
      connectionId: 'email-channel',
      direction: 'incoming',
      senderId: 'a@x.com',
      content: 'no thread',
      metadata: { messageId: 'BARE-MSG', subject: 'orphan' },
      messageTimestamp: now,
      createdAt: now,
    })
    const entities = await collectGmailEntities(baseCfg)
    expect(entities.length).toBe(1)
    expect(entities[0].entityId).toBe('m:BARE-MSG')
    expect(entities[0].sourceUrl).toBeNull()
  })

  test('ignores non-email channelType rows', async () => {
    const now = new Date().toISOString()
    await db.insert(channelMessages).values({
      id: 's-not-email',
      channelType: 'slack',
      connectionId: 'c',
      direction: 'incoming',
      senderId: 'u',
      content: 'hi',
      messageTimestamp: now,
      createdAt: now,
    })
    const entities = await collectGmailEntities(baseCfg)
    expect(entities).toEqual([])
  })
})

describe('divinci-sync-service.renderCalendarEventEntity', () => {
  test('renders an event with calendar name, time, location, attendees, description', () => {
    const entity = renderCalendarEventEntity(
      {
        id: 'evt-1',
        calendarId: 'cal-personal',
        summary: '1:1 with Mike',
        description: 'D-17 PR 5 walkthrough',
        location: 'Zoom',
        dtstart: '2026-05-25T14:00:00Z',
        dtend: '2026-05-25T14:30:00Z',
        allDay: false,
        organizer: 'mike@divinci.ai',
        attendees: ['alice@x.com', 'bob@x.com'],
        status: 'confirmed',
        recurrenceRule: null,
      },
      'Mike Personal',
    )
    expect(entity.entityType).toBe('calendar-event')
    expect(entity.entityId).toBe('evt-1')
    expect(entity.title).toBe('Calendar: 1:1 with Mike')
    expect(entity.body).toContain('# 1:1 with Mike')
    expect(entity.body).toContain('Calendar: Mike Personal')
    expect(entity.body).toContain('When: 2026-05-25T14:00:00Z → 2026-05-25T14:30:00Z')
    expect(entity.body).toContain('Where: Zoom')
    expect(entity.body).toContain('Organizer: mike@divinci.ai')
    expect(entity.body).toContain('Attendees: alice@x.com, bob@x.com')
    expect(entity.body).toContain('Status: confirmed')
    expect(entity.body).toContain('D-17 PR 5 walkthrough')
    expect(entity.sourceUrl).toBeNull()
  })

  test('all-day events get the (all-day) tag', () => {
    const entity = renderCalendarEventEntity(
      {
        id: 'h1',
        calendarId: 'cal',
        summary: 'Holiday',
        description: null,
        location: null,
        dtstart: '2026-12-25',
        dtend: null,
        allDay: true,
        organizer: null,
        attendees: null,
        status: null,
        recurrenceRule: null,
      },
      null,
    )
    expect(entity.body).toContain('(all-day)')
    expect(entity.body).not.toContain('Calendar:')
  })

  test('attendee preview truncates to 8 with overflow count', () => {
    const attendees = Array.from({ length: 12 }, (_, i) => `u${i}@x.com`)
    const entity = renderCalendarEventEntity(
      {
        id: 'big',
        calendarId: 'cal',
        summary: 'All-hands',
        description: null,
        location: null,
        dtstart: '2026-06-01T10:00:00Z',
        dtend: '2026-06-01T11:00:00Z',
        allDay: false,
        organizer: null,
        attendees,
        status: null,
        recurrenceRule: null,
      },
      null,
    )
    expect(entity.body).toContain('(+4 more)')
  })

  test('falls back to (no title) when summary is null', () => {
    const entity = renderCalendarEventEntity(
      {
        id: 'untitled',
        calendarId: 'cal',
        summary: null,
        description: null,
        location: null,
        dtstart: '2026-06-01T10:00:00Z',
        dtend: null,
        allDay: false,
        organizer: null,
        attendees: null,
        status: null,
        recurrenceRule: null,
      },
      null,
    )
    expect(entity.title).toBe('Calendar: (no title)')
    expect(entity.body).toContain('# (no title)')
  })
})

describe('divinci-sync-service.collectCalendarEntities', () => {
  async function seedCalendar(id: string, displayName: string | null): Promise<void> {
    const now = new Date().toISOString()
    await db.insert(caldavCalendars).values({
      id,
      remoteUrl: `https://cal.example/${id}`,
      displayName,
      createdAt: now,
      updatedAt: now,
    })
  }

  async function seedEvent(overrides: Partial<typeof caldavEvents.$inferInsert>): Promise<void> {
    const now = new Date().toISOString()
    await db.insert(caldavEvents).values({
      id: 'e1',
      calendarId: 'cal-1',
      remoteUrl: `https://cal.example/event/${overrides.id ?? 'e1'}`,
      summary: 'X',
      dtstart: new Date().toISOString(),
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
  }

  test('returns empty when no events exist', async () => {
    const entities = await collectCalendarEntities(baseCfg)
    expect(entities).toEqual([])
  })

  test('includes events within the ±90-day window', async () => {
    await seedCalendar('cal-1', 'My Cal')
    await seedEvent({ id: 'e-now', remoteUrl: 'r1', dtstart: new Date().toISOString() })
    const entities = await collectCalendarEntities(baseCfg)
    expect(entities.length).toBe(1)
    expect(entities[0].entityId).toBe('e-now')
    expect(entities[0].body).toContain('My Cal')
  })

  test('excludes events outside ±90 days', async () => {
    await seedCalendar('cal-1', null)
    const future = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString()
    const past = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
    await seedEvent({ id: 'far-future', remoteUrl: 'rf', dtstart: future })
    await seedEvent({ id: 'far-past', remoteUrl: 'rp', dtstart: past })
    const entities = await collectCalendarEntities(baseCfg)
    expect(entities).toEqual([])
  })

  test('skips events with no dtstart or unparseable dtstart', async () => {
    await seedCalendar('cal-1', null)
    await seedEvent({ id: 'no-start', remoteUrl: 'rns', dtstart: null })
    await seedEvent({ id: 'bad-start', remoteUrl: 'rbs', dtstart: 'not-a-date' })
    const entities = await collectCalendarEntities(baseCfg)
    expect(entities).toEqual([])
  })
})
