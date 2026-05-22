/**
 * Observer Tracking Service - Records observer invocations for UI visibility.
 *
 * Tracks each observe-only message processing attempt: what was processed,
 * which provider handled it, what actions were taken, and whether it succeeded.
 */

import { nanoid } from 'nanoid'
import { db, observerInvocations, type ObserverActionRecord } from '../db'
import { eq, desc, and, sql, type SQL } from 'drizzle-orm'
import type { Changes } from 'bun:sqlite'

export function createInvocation(params: {
  channelMessageId?: string
  channelType: string
  connectionId: string
  senderId: string
  senderName?: string
  messageContent: string
  provider: 'claude' | 'opencode'
}): string {
  const id = nanoid()
  const now = new Date().toISOString()
  db.insert(observerInvocations)
    .values({
      id,
      channelMessageId: params.channelMessageId ?? null,
      channelType: params.channelType,
      connectionId: params.connectionId,
      senderId: params.senderId,
      senderName: params.senderName ?? null,
      messagePreview: params.messageContent.slice(0, 200),
      provider: params.provider,
      status: 'processing',
      startedAt: now,
      createdAt: now,
    })
    .run() as unknown as Changes
  return id
}

export function completeInvocation(id: string, actions: ObserverActionRecord[]): void {
  db.update(observerInvocations)
    .set({
      status: 'completed',
      actions,
      completedAt: new Date().toISOString(),
    })
    .where(eq(observerInvocations.id, id))
    .run() as unknown as Changes
}

export function failInvocation(id: string, error: string): void {
  db.update(observerInvocations)
    .set({
      status: 'failed',
      error,
      completedAt: new Date().toISOString(),
    })
    .where(eq(observerInvocations.id, id))
    .run() as unknown as Changes
}

export function timeoutInvocation(id: string): void {
  db.update(observerInvocations)
    .set({
      status: 'timeout',
      completedAt: new Date().toISOString(),
    })
    .where(eq(observerInvocations.id, id))
    .run() as unknown as Changes
}

export function skipInvocation(params: {
  channelMessageId?: string
  channelType: string
  connectionId: string
  senderId: string
  senderName?: string
  messageContent: string
  provider: 'claude' | 'opencode'
}): void {
  const id = nanoid()
  const now = new Date().toISOString()
  db.insert(observerInvocations)
    .values({
      id,
      channelMessageId: params.channelMessageId ?? null,
      channelType: params.channelType,
      connectionId: params.connectionId,
      senderId: params.senderId,
      senderName: params.senderName ?? null,
      messagePreview: params.messageContent.slice(0, 200),
      provider: params.provider,
      status: 'circuit_open',
      startedAt: now,
      completedAt: now,
      createdAt: now,
    })
    .run() as unknown as Changes
}

export function getInvocations(options?: {
  channelType?: string
  status?: string
  provider?: string
  limit?: number
  offset?: number
}) {
  const limit = options?.limit ?? 50
  const offset = options?.offset ?? 0
  const conditions: SQL[] = []

  if (options?.channelType) {
    conditions.push(eq(observerInvocations.channelType, options.channelType))
  }
  if (options?.status) {
    conditions.push(eq(observerInvocations.status, options.status))
  }
  if (options?.provider) {
    conditions.push(eq(observerInvocations.provider, options.provider))
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined

  return db
    .select()
    .from(observerInvocations)
    .where(where)
    .orderBy(desc(observerInvocations.startedAt))
    .limit(limit)
    .offset(offset)
    .all()
}

export function getInvocationStats() {
  const now = Date.now()
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  // All-time counts
  const allTime = db
    .select({
      total: sql<number>`count(*)`,
      completed: sql<number>`sum(case when ${observerInvocations.status} = 'completed' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${observerInvocations.status} = 'failed' then 1 else 0 end)`,
      timeout: sql<number>`sum(case when ${observerInvocations.status} = 'timeout' then 1 else 0 end)`,
      circuitOpen: sql<number>`sum(case when ${observerInvocations.status} = 'circuit_open' then 1 else 0 end)`,
      processing: sql<number>`sum(case when ${observerInvocations.status} = 'processing' then 1 else 0 end)`,
      avgDurationMs: sql<number>`avg(case when ${observerInvocations.completedAt} is not null then (julianday(${observerInvocations.completedAt}) - julianday(${observerInvocations.startedAt})) * 86400000 end)`,
    })
    .from(observerInvocations)
    .get()!

  // Last 24h count
  const last24h = db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(observerInvocations)
    .where(sql`${observerInvocations.startedAt} >= ${oneDayAgo}`)
    .get()!

  // Action type breakdown (from completed invocations with actions)
  const actionsRaw = db
    .select({ actions: observerInvocations.actions })
    .from(observerInvocations)
    .where(eq(observerInvocations.status, 'completed'))
    .all()

  let tasksCreated = 0
  let memoriesStored = 0
  for (const row of actionsRaw) {
    const actions = row.actions as ObserverActionRecord[] | null
    if (!actions) continue
    for (const action of actions) {
      if (action.type === 'create_task') tasksCreated++
      else if (action.type === 'store_memory') memoriesStored++
    }
  }

  return {
    total: allTime.total ?? 0,
    completed: allTime.completed ?? 0,
    failed: allTime.failed ?? 0,
    timeout: allTime.timeout ?? 0,
    circuitOpen: allTime.circuitOpen ?? 0,
    processing: allTime.processing ?? 0,
    avgDurationMs: Math.round(allTime.avgDurationMs ?? 0),
    tasksCreated,
    memoriesStored,
    last24h: last24h.count ?? 0,
  }
}

export function pruneOldInvocations(maxAgeDays = 7): number {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString()
  const result = db
    .delete(observerInvocations)
    .where(sql`${observerInvocations.createdAt} < ${cutoff}`)
    .run() as unknown as Changes
  return result.changes
}