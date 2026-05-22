// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Memory File MCP tools - Read and update the master MEMORY.md file
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

/**
 * Register only the read tool (for observer/untrusted contexts)
 */
export const registerMemoryFileReadTool: ToolRegistrar = (server, client) => {
  server.tool(
    'memory_file_read',
    'Read the master memory file (MEMORY.md). This file contains persistent knowledge, user preferences, and instructions that are included in every conversation.',
    {},
    async () => {
      try {
        const result = await client.readMemoryFile()
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

/**
 * Register all memory file tools (read + write — for trusted contexts)
 */
export const registerMemoryFileTools: ToolRegistrar = (server, client) => {
  // Register read tool
  registerMemoryFileReadTool(server, client)

  // memory_file_update - Update the memory file (whole or by section)
  server.tool(
    'memory_file_update',
    'Update the master memory file. Provide full content to replace the entire file, or specify a section heading to update just that section. The memory file is included in every conversation, so keep it organized and concise. Never write sweep summaries, transient status, or time-sensitive information (specific dates, attendee counts, invoices) to this file — use memory_store instead.',
    {
      content: z.string().describe('The content to write. If section is specified, this replaces only that section body.'),
      section: z.optional(z.string()).describe('Optional markdown heading (e.g., "## Preferences") to update a specific section. If omitted, replaces the entire file.'),
    },
    async ({ content, section }) => {
      try {
        if (section) {
          await client.updateMemoryFileSection(section, content)
        } else {
          await client.writeMemoryFile(content)
        }
        return formatSuccess({ success: true })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}