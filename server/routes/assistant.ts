import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { db } from '../db'
import { sweepRuns } from '../db/schema'
import { eq, desc } from 'drizzle-orm'
import * as assistantService from '../services/assistant-service'
import { streamOpencodeMessage } from '../services/opencode-chat-service'
import type { PageContext, ImageData, AttachmentData } from '../../shared/types'

const assistantRoutes = new Hono()

/**
 * POST /api/assistant/sessions
 * Create a new chat session
 */
assistantRoutes.post('/sessions', async (c) => {
  const body = await c.req.json<{
    title?: string
    provider?: 'claude' | 'opencode'
    model?: string
    projectId?: string
    context?: PageContext
  }>().catch(() => ({}))

  try {
    const session = await assistantService.createSession(body)
    return c.json(session)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * GET /api/assistant/sessions
 * List sessions with pagination
 */
assistantRoutes.get('/sessions', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const projectId = c.req.query('projectId') || undefined
  const search = c.req.query('search') || undefined
  const favorites = c.req.query('favorites') === 'true'

  const result = assistantService.listSessions({ limit, offset, projectId, search, favorites })
  return c.json(result)
})

/**
 * GET /api/assistant/sessions/:id
 * Get a session with messages
 */
assistantRoutes.get('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const session = assistantService.getSession(id)

  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const messages = assistantService.getMessages(id)
  return c.json({ ...session, messages })
})

/**
 * PATCH /api/assistant/sessions/:id
 * Update a session
 */
assistantRoutes.patch('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const updates = await c.req.json<{
    title?: string
    isFavorite?: boolean
    editorContent?: string
    saveDocument?: boolean
  }>()

  // If saveDocument is true and there's editorContent, also save to file
  if (updates.saveDocument && updates.editorContent) {
    await assistantService.saveSessionDocument(id, updates.editorContent)
  }

  const session = assistantService.updateSession(id, {
    title: updates.title,
    isFavorite: updates.isFavorite,
    editorContent: updates.editorContent,
  })
  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  return c.json(session)
})

/**
 * DELETE /api/assistant/sessions/:id
 * Delete a session
 */
assistantRoutes.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const success = await assistantService.deleteSession(id)

  if (!success) {
    return c.json({ error: 'Session not found' }, 404)
  }

  return c.json({ success: true })
})

/**
 * POST /api/assistant/sessions/:id/messages
 * Send a message and stream the response via SSE
 */
assistantRoutes.post('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id')
  const { message, model, editorContent, images, attachments, context, uiMode } = await c.req.json<{
    message: string
    model?: string
    editorContent?: string
    images?: ImageData[]
    attachments?: AttachmentData[]
    context?: PageContext
    uiMode?: 'full' | 'compact'
  }>()

  // Merge legacy `images` field into `attachments` for backwards compatibility
  const mergedAttachments: AttachmentData[] = [
    ...(attachments || []),
    ...(images || []).map((img) => ({
      mediaType: img.mediaType,
      data: img.data,
      filename: 'image',
      type: 'image' as const,
    })),
  ]

  // Allow empty message if attachments are present
  if ((!message || typeof message !== 'string') && mergedAttachments.length === 0) {
    return c.json({ error: 'Message or attachments required' }, 400)
  }

  const session = assistantService.getSession(sessionId)
  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  if (session.provider === 'opencode') {
    // Save user message to DB
    assistantService.addMessage(sessionId, { role: 'user', content: message || '', sessionId })

    return streamSSE(c, async (stream) => {
      let fullResponse = ''
      for await (const event of streamOpencodeMessage(sessionId, message || '', model, context, mergedAttachments.length > 0 ? mergedAttachments : undefined)) {
        if (event.type === 'content:delta' && (event.data as { text?: string })?.text) {
          fullResponse += (event.data as { text: string }).text
        }
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event.data),
        })
      }
      // Save assistant response to DB
      if (fullResponse) {
        assistantService.addMessage(sessionId, { role: 'assistant', content: fullResponse, sessionId })
      }
    })
  }

  // Claude path (existing behavior)
  return streamSSE(c, async (stream) => {
    for await (const event of assistantService.streamMessage(sessionId, message || '', {
      modelId: model as 'opus' | 'sonnet' | 'haiku' | undefined,
      editorContent,
      attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
      context,
      uiMode,
    })) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event.data),
      })
    }
  })
})

/**
 * GET /api/assistant/artifacts
 * List artifacts
 */
assistantRoutes.get('/artifacts', async (c) => {
  const sessionId = c.req.query('sessionId') || undefined
  const type = c.req.query('type') || undefined
  const favorites = c.req.query('favorites') === 'true'
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')

  const result = assistantService.listArtifacts({ sessionId, type, favorites, limit, offset })
  return c.json(result)
})

/**
 * GET /api/assistant/artifacts/:id
 * Get an artifact with content
 */
assistantRoutes.get('/artifacts/:id', async (c) => {
  const id = c.req.param('id')
  const artifact = assistantService.getArtifact(id)

  if (!artifact) {
    return c.json({ error: 'Artifact not found' }, 404)
  }

  return c.json(artifact)
})

/**
 * POST /api/assistant/artifacts
 * Create an artifact manually
 */
assistantRoutes.post('/artifacts', async (c) => {
  const body = await c.req.json<{
    sessionId: string
    type: 'vega-lite' | 'mermaid' | 'markdown' | 'code'
    title: string
    content: string
    description?: string
  }>()

  const session = assistantService.getSession(body.sessionId)
  if (!session) {
    return c.json({ error: 'Session not found' }, 404)
  }

  try {
    // Route accepts 'vega-lite' (user-facing name); the service uses
    // 'chart' internally for the same spec. Translate at the boundary.
    const artifact = await assistantService.createArtifact({
      sessionId: body.sessionId,
      type: body.type === 'vega-lite' ? 'chart' : body.type,
      title: body.title,
      content: body.content,
      description: body.description,
    })
    return c.json(artifact)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * PATCH /api/assistant/artifacts/:id
 * Update an artifact
 */
assistantRoutes.patch('/artifacts/:id', async (c) => {
  const id = c.req.param('id')
  const updates = await c.req.json<{
    title?: string
    description?: string
    isFavorite?: boolean
    tags?: string
  }>()

  const artifact = assistantService.updateArtifact(id, updates)
  if (!artifact) {
    return c.json({ error: 'Artifact not found' }, 404)
  }

  return c.json(artifact)
})

/**
 * DELETE /api/assistant/artifacts/:id
 * Delete an artifact
 */
assistantRoutes.delete('/artifacts/:id', async (c) => {
  const id = c.req.param('id')
  const success = assistantService.deleteArtifact(id)

  if (!success) {
    return c.json({ error: 'Artifact not found' }, 404)
  }

  return c.json({ success: true })
})

/**
 * POST /api/assistant/artifacts/:id/fork
 * Fork an artifact to a new version
 */
assistantRoutes.post('/artifacts/:id/fork', async (c) => {
  const id = c.req.param('id')
  const { content } = await c.req.json<{ content: string }>()

  if (!content) {
    return c.json({ error: 'Content is required' }, 400)
  }

  const artifact = await assistantService.forkArtifact(id, content)
  if (!artifact) {
    return c.json({ error: 'Artifact not found' }, 404)
  }

  return c.json(artifact)
})

// ==================== Document Routes ====================

/**
 * GET /api/assistant/documents
 * List all documents (sessions with saved documents)
 */
assistantRoutes.get('/documents', async (c) => {
  try {
    const documents = await assistantService.listDocuments()
    return c.json({ documents })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /api/assistant/documents/:sessionId
 * Save document content for a session
 */
assistantRoutes.post('/documents/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const { content } = await c.req.json<{ content: string }>()

  if (content === undefined) {
    return c.json({ error: 'Content is required' }, 400)
  }

  try {
    const documentPath = await assistantService.saveSessionDocument(sessionId, content)
    if (!documentPath) {
      return c.json({ error: 'Session not found' }, 404)
    }
    return c.json({ success: true, documentPath })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * PATCH /api/assistant/documents/:sessionId
 * Update document metadata (rename or toggle starred)
 */
assistantRoutes.patch('/documents/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const { filename, starred } = await c.req.json<{
    filename?: string
    starred?: boolean
  }>()

  const session = assistantService.getSession(sessionId)
  if (!session?.documentPath) {
    return c.json({ error: 'No document for this session' }, 404)
  }

  try {
    // Rename if filename provided and different
    if (filename && filename !== session.documentPath) {
      await assistantService.renameSessionDocument(sessionId, filename)
    }

    // Toggle starred if provided
    if (typeof starred === 'boolean') {
      assistantService.updateSession(sessionId, { documentStarred: starred })
    }

    return c.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * DELETE /api/assistant/documents/:sessionId
 * Delete document from session (keeps session, removes document)
 */
assistantRoutes.delete('/documents/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')

  try {
    const success = await assistantService.removeSessionDocument(sessionId)
    if (!success) {
      return c.json({ error: 'No document for this session' }, 404)
    }
    return c.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ==================== Sweeps Routes ====================

/**
 * GET /api/assistant/sweeps
 * List sweep runs with optional filtering
 */
assistantRoutes.get('/sweeps', async (c) => {
  const type = c.req.query('type')
  const limit = parseInt(c.req.query('limit') || '20')

  try {
    const whereClause = type ? eq(sweepRuns.type, type) : undefined

    const runs = db
      .select()
      .from(sweepRuns)
      .where(whereClause)
      .orderBy(desc(sweepRuns.startedAt))
      .limit(limit)
      .all()

    return c.json({ runs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * GET /api/assistant/sweeps/last/:type
 * Get the most recent sweep run of a specific type
 */
assistantRoutes.get('/sweeps/last/:type', async (c) => {
  const type = c.req.param('type')

  try {
    const sweep = db
      .select()
      .from(sweepRuns)
      .where(eq(sweepRuns.type, type))
      .orderBy(desc(sweepRuns.completedAt))
      .limit(1)
      .get()

    return c.json(sweep || null)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * GET /api/assistant/sweeps/:id
 * Get single sweep run details
 */
assistantRoutes.get('/sweeps/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const sweep = db.select().from(sweepRuns).where(eq(sweepRuns.id, id)).get()

    if (!sweep) {
      return c.json({ error: 'Sweep not found' }, 404)
    }

    return c.json(sweep)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default assistantRoutes