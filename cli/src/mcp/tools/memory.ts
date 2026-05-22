// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Memory MCP tools - Store, search, list, and delete persistent knowledge
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'
import { MEMORY_SOURCES } from '@shared/types'

/**
 * Register memory_store tool (used by both full and observer contexts)
 */
function registerMemoryStoreTool(server: Parameters<ToolRegistrar>[0], client: Parameters<ToolRegistrar>[1]) {
  server.tool(
    'memory_store',
    'Store a piece of knowledge in persistent memory. Use this to remember facts, preferences, decisions, patterns, or any information that should persist across conversations.',
    {
      content: z.string().describe('The memory content to store. Be specific and self-contained.'),
      tags: z.optional(z.array(z.string())).describe('Optional tags for categorization (e.g., ["preference", "architecture", "decision"])'),
      source: z.optional(z.enum(MEMORY_SOURCES)).describe('Where this memory originated (e.g., "channel:whatsapp", "conversation:assistant")'),
    },
    async ({ content, tags, source }) => {
      try {
        const result = await client.storeMemory({ content, tags, source })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

/**
 * Register memory_search tool
 */
function registerMemorySearchTool(server: Parameters<ToolRegistrar>[0], client: Parameters<ToolRegistrar>[1]) {
  server.tool(
    'memory_search',
    'Search persistent memories using full-text search (FTS5). Supports boolean operators (AND, OR, NOT), phrase matching ("quoted"), and prefix matching (term*).',
    {
      query: z.string().describe('Search query. Supports FTS5 syntax: AND, OR, NOT, "phrases", prefix*'),
      tags: z.optional(z.array(z.string())).describe('Filter by tags (e.g., ["actionable", "preference"])'),
      limit: z.optional(z.number()).describe('Max results to return (default: 20)'),
    },
    async ({ query, tags, limit }) => {
      try {
        const result = await client.searchMemories({ query, tags, limit })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

/**
 * Register memory_list tool
 */
function registerMemoryListTool(server: Parameters<ToolRegistrar>[0], client: Parameters<ToolRegistrar>[1]) {
  server.tool(
    'memory_list',
    'List all persistent memories, optionally filtered by tags. Returns memories sorted by creation date (newest first).',
    {
      tags: z.optional(z.array(z.string())).describe('Filter by tags (e.g., ["actionable"])'),
      limit: z.optional(z.number()).describe('Max results to return (default: 50)'),
      offset: z.optional(z.number()).describe('Offset for pagination'),
    },
    async ({ tags, limit, offset }) => {
      try {
        const result = await client.listMemories({ tags, limit, offset })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

/**
 * Register memory_delete tool
 */
function registerMemoryDeleteTool(server: Parameters<ToolRegistrar>[0], client: Parameters<ToolRegistrar>[1]) {
  server.tool(
    'memory_delete',
    'Delete a persistent memory by ID. Use this to clean up resolved or outdated memories.',
    {
      id: z.string().describe('The ID of the memory to delete'),
    },
    async ({ id }) => {
      try {
        const result = await client.deleteMemory(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}

/**
 * Register all memory tools (full access — for trusted contexts)
 */
export const registerMemoryTools: ToolRegistrar = (server, client) => {
  registerMemoryStoreTool(server, client)
  registerMemorySearchTool(server, client)
  registerMemoryListTool(server, client)
  registerMemoryDeleteTool(server, client)
}

/**
 * Register observer-safe memory tools (no delete — for untrusted contexts)
 */
export const registerMemoryObserverTools: ToolRegistrar = (server, client) => {
  registerMemoryStoreTool(server, client)
  registerMemorySearchTool(server, client)
  registerMemoryListTool(server, client)
}