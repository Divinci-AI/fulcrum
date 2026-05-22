// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Messaging MCP tools
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

export const registerMessagingTools: ToolRegistrar = (server, client) => {
  // get_message
  server.tool(
    'get_message',
    'Get details of a specific message by ID, including full content and metadata.',
    {
      id: z.string().describe('Message ID'),
    },
    async ({ id }) => {
      try {
        const message = await client.getMessage(id)
        return formatSuccess(message)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}