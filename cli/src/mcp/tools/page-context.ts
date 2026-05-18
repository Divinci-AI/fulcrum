/**
 * Page-context MCP tool (D-9 Phase C).
 *
 * Exposes the frontend page-context snapshot to agents so they can
 * answer "what is the user looking at right now?" without polling.
 *
 * The snapshot is published by the browser over WebSocket as the
 * user clicks around; the server caches the latest per Fulcrum user
 * in-memory. Returns null when the user has no active browser
 * session in this server process lifetime.
 */
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

export const registerPageContextTools: ToolRegistrar = (server, client) => {
  server.tool(
    'get_page_context',
    "Get the current page context of the user's Fulcrum browser session: route, selected entity, visible entities, and any page-specific metadata. Useful for grounding agent responses in what the user is actually looking at. Returns null when the user hasn't opened the browser this session.",
    {},
    async () => {
      try {
        const result = await client.getPageContext()
        if (!result.context) {
          return formatSuccess({
            context: null,
            hint: 'No page context yet — the user may not have opened the Fulcrum UI this session, or the server was restarted since their last navigation.',
          })
        }
        return formatSuccess({
          context: result.context,
          hint: `User is on ${result.context.route}`,
        })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}
