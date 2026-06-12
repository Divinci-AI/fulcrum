/**
 * Restricted MCP endpoints for untrusted contexts.
 *
 * /mcp/observer — observer-safe memory tools (store, search, list — no delete),
 * read-only memory file access (no write), and observer-safe task tools
 * (list, create, update, add link/tag/due date — no delete, no filesystem).
 * Used for observe-only channel messages where the input is untrusted
 * third-party content (non-self WhatsApp chats, unauthorized emails).
 */
import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerMemoryObserverTools } from '../../cli/src/mcp/tools/memory'
import { registerMemoryFileReadTool } from '../../cli/src/mcp/tools/memory-file'
import { registerTaskObserverTools } from '../../cli/src/mcp/tools/tasks'
import { registerNotificationTools } from '../../cli/src/mcp/tools/notifications'
import { FulcrumClient } from '../../cli/src/client'
import { getSettings } from '../lib/settings'
import { log } from '../lib/logger'

const mcpObserverRoutes = new Hono()

/**
 * Hard whitelist of tools allowed on the observer transport. The register*
 * functions above define what gets registered, but that's convention — if a
 * future edit adds a tool to one of those registrars, this list is what stops
 * it from silently becoming reachable by untrusted content. Anything
 * registered but not listed here is stripped before the transport connects.
 */
const OBSERVER_TOOL_WHITELIST = new Set([
  'memory_store',
  'memory_search',
  'memory_list',
  'memory_file_read',
  'list_tasks',
  'create_task',
  'update_task',
  'move_task',
  'add_task_link',
  'add_task_tag',
  'set_task_due_date',
  'send_notification',
])

function enforceObserverWhitelist(server: McpServer): void {
  // _registeredTools is the SDK's internal registry; there's no public
  // enumeration API. Pinning to it is deliberate — if the SDK renames it,
  // the cast below fails closed (empty object → nothing to strip) and the
  // registrars above are still the primary restriction.
  const registered = (server as unknown as { _registeredTools?: Record<string, { remove(): void }> })
    ._registeredTools ?? {}
  for (const [name, tool] of Object.entries(registered)) {
    if (!OBSERVER_TOOL_WHITELIST.has(name)) {
      tool.remove()
      log.server.error('Stripped non-whitelisted tool from observer MCP transport', { tool: name })
    }
  }
}

mcpObserverRoutes.all('/', async (c) => {
  const settings = getSettings()
  const port = settings.server?.port ?? 7777

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })

  const server = new McpServer({
    name: 'fulcrum-observer',
    version: '2.12.0',
  })

  const client = new FulcrumClient(`http://localhost:${port}`)
  registerMemoryObserverTools(server, client)
  registerMemoryFileReadTool(server, client)
  registerTaskObserverTools(server, client)
  registerNotificationTools(server, client)
  enforceObserverWhitelist(server)

  await server.connect(transport)

  return transport.handleRequest(c.req.raw)
})

export default mcpObserverRoutes
