/**
 * Bridge between Fulcrum's MCP tool registry and Hermes's OpenAI function-calling
 * surface (D-16 B2d).
 *
 * The Fulcrum MCP server in `cli/src/mcp/tools/*` registers ~127 tools using
 * `server.tool(name, description, zodSchema, handler)`. Rather than re-declaring
 * each tool by hand for Hermes (B2c stopped at 7 curated ones), this module
 * intercepts the registrations once, snapshots their metadata, and exposes:
 *
 *   - `getMcpToolsAsOpenAI()`  — every registered tool as an OpenAITool with a
 *     JSON-Schema input shape suitable for OpenAI function-calling.
 *   - `executeMcpTool(name, args)` — invokes the corresponding handler in-process
 *     and flattens the MCP `{content:[{type:'text', text:...}]}` reply into a
 *     plain string for the Hermes tool-result message.
 *
 * Interception strategy: wrap McpServer in a Proxy that records each
 * `server.tool(...)` call as it happens. No private SDK fields touched.
 *
 * Initialization is lazy and cached — the first caller pays the cost of
 * registering all tools; subsequent callers hit the cache. The registration is
 * deterministic and side-effect-free (no DB writes), so this is safe.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
// The SDK ships a compat shim that handles both Zod v3 and v4 — we depend on
// it instead of zod-to-json-schema directly so the converter works against
// Fulcrum's Zod v4 schemas (v3-only conversion silently returned `{}`).
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { z } from 'zod'
import { registerTools } from '../../cli/src/mcp/tools'
import { FulcrumClient } from '../../cli/src/client'
import { getSettings } from '../lib/settings'
import { log } from '../lib/logger'
import type { OpenAITool } from './hermes-tools'

interface RecordedTool {
  name: string
  description: string
  /** Zod raw shape map (the third arg to `server.tool(name, desc, schema, cb)`). */
  schema: Record<string, z.ZodTypeAny>
  /** The tool handler. Signature varies by tool — we treat it as opaque. */
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

interface InitializedBridge {
  tools: RecordedTool[]
  byName: Map<string, RecordedTool>
  openAITools: OpenAITool[]
}

let cached: InitializedBridge | null = null

/**
 * Build (or return the cached) bridge. Lazy because we'd rather not pay the
 * registration cost at server boot for tenants that haven't enabled Hermes.
 */
function getBridge(): InitializedBridge {
  if (cached) return cached

  const recorded: RecordedTool[] = []

  // Real McpServer instance — we don't actually serve traffic from it. We use
  // it as a passthrough for the tool registrations so the SDK keeps doing its
  // own bookkeeping (helpful if we ever want to flip on streaming MCP later).
  const realServer = new McpServer({ name: 'fulcrum-hermes-bridge', version: '0.0.1' })

  // Proxy intercepts every `.tool(...)` call. Fulcrum's tool registrations use
  // the (name, description, schema, handler) overload — that's all we record.
  // Other overloads pass through untouched.
  const recordingServer = new Proxy(realServer, {
    get(target, prop, receiver) {
      if (prop !== 'tool') return Reflect.get(target, prop, receiver)
      return (...args: unknown[]) => {
        if (
          args.length === 4 &&
          typeof args[0] === 'string' &&
          typeof args[1] === 'string' &&
          typeof args[2] === 'object' &&
          typeof args[3] === 'function'
        ) {
          recorded.push({
            name: args[0],
            description: args[1],
            schema: args[2] as Record<string, z.ZodTypeAny>,
            handler: args[3] as RecordedTool['handler'],
          })
        }
        return (target.tool as (...rest: unknown[]) => unknown).apply(target, args)
      }
    },
  })

  // Build a FulcrumClient pointing at our own HTTP API. Tool handlers use it for
  // the side-effecting work (POST /api/tasks, etc.) — same pattern as routes/mcp.ts.
  const port = getSettings().server?.port ?? 7777
  const client = new FulcrumClient(`http://localhost:${port}`)
  registerTools(recordingServer, client)

  // Convert each tool's Zod schema to OpenAI's expected JSON Schema shape.
  const openAITools: OpenAITool[] = recorded.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodShapeToJsonSchema(tool.schema),
    },
  }))

  const byName = new Map(recorded.map((t) => [t.name, t]))

  log.chat.info('Hermes MCP bridge initialized', { toolCount: recorded.length })

  cached = { tools: recorded, byName, openAITools }
  return cached
}

/**
 * Convert a Zod raw shape (`{ status: z.string(), ... }`) to a JSON Schema
 * object suitable for OpenAI function parameters. Wraps the shape in
 * `z.object(...)` so refinements/optionals roundtrip cleanly through
 * zod-to-json-schema, then strips JSON-Schema-only fields OpenAI doesn't accept.
 */
function zodShapeToJsonSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  if (!shape || Object.keys(shape).length === 0) {
    return { type: 'object', properties: {} }
  }
  const wrapped = z.object(shape)
  const json = toJsonSchemaCompat(wrapped as unknown as Parameters<typeof toJsonSchemaCompat>[0], {
    target: 'jsonSchema7',
  }) as Record<string, unknown>
  // The converter sometimes inserts a top-level $schema URL — OpenAI rejects it.
  delete (json as { $schema?: unknown }).$schema
  return json
}

/**
 * Returns all MCP-derived OpenAI function defs. Safe to call repeatedly —
 * cached after the first invocation.
 */
export function getMcpToolsAsOpenAI(): OpenAITool[] {
  return getBridge().openAITools
}

/**
 * Returns true when the given tool name is known to the MCP registry. Hermes
 * checks this before falling back to the curated hand-rolled handlers so MCP
 * versions (richer schemas, more complete coverage) always win on collision.
 */
export function isMcpToolKnown(name: string): boolean {
  return getBridge().byName.has(name)
}

/**
 * Execute an MCP-registered tool by name. Returns a plain string — the JSON
 * stringification of the handler's return value (or an unwrapped text content
 * block for MCP-format `{content:[...]}` responses).
 *
 * Never throws — failures are returned as JSON-encoded error envelopes the
 * model can react to.
 */
export async function executeMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = getBridge().byName.get(name)
  if (!tool) return JSON.stringify({ error: `Unknown MCP tool: ${name}` })

  try {
    const raw = await tool.handler(args)
    // MCP tools typically return { content: [{ type: 'text', text: '…' }] }
    if (
      raw &&
      typeof raw === 'object' &&
      'content' in raw &&
      Array.isArray((raw as { content?: unknown[] }).content)
    ) {
      const blocks = (raw as { content: Array<{ type?: string; text?: string }> }).content
      const texts = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
      if (texts.length > 0) return texts.join('\n')
    }
    return JSON.stringify(raw)
  } catch (err) {
    log.chat.error('MCP tool execution failed', { tool: name, error: String(err) })
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Test/maintenance hook: clear the cached bridge so the next call rebuilds it.
 * Useful in tests that change settings between cases.
 */
export function _resetMcpBridgeForTesting(): void {
  cached = null
}
