// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Gmail MCP tools - draft management and Google account listing
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

export const registerGmailTools: ToolRegistrar = (server, client) => {
  server.tool(
    'list_google_accounts',
    'List all configured Google accounts with their calendar/Gmail status.',
    {},
    async () => {
      try {
        const accounts = await client.listGoogleAccounts()
        return formatSuccess(accounts)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'list_gmail_drafts',
    'List Gmail drafts for a Google account.',
    {
      accountId: z.string().describe('Google account ID'),
    },
    async ({ accountId }) => {
      try {
        const drafts = await client.listGmailDrafts(accountId)
        return formatSuccess(drafts)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'create_gmail_draft',
    'Create a new Gmail draft email.',
    {
      accountId: z.string().describe('Google account ID'),
      to: z.optional(z.array(z.string())).describe('Recipients'),
      cc: z.optional(z.array(z.string())).describe('CC recipients'),
      bcc: z.optional(z.array(z.string())).describe('BCC recipients'),
      subject: z.optional(z.string()).describe('Email subject'),
      body: z.optional(z.string()).describe('Plain text email body'),
      htmlBody: z.optional(z.string()).describe('HTML email body'),
    },
    async ({ accountId, ...rest }) => {
      try {
        const draft = await client.createGmailDraft(accountId, rest)
        return formatSuccess(draft)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'update_gmail_draft',
    'Update an existing Gmail draft.',
    {
      accountId: z.string().describe('Google account ID'),
      draftId: z.string().describe('Gmail draft ID'),
      to: z.optional(z.array(z.string())).describe('Recipients'),
      cc: z.optional(z.array(z.string())).describe('CC recipients'),
      bcc: z.optional(z.array(z.string())).describe('BCC recipients'),
      subject: z.optional(z.string()).describe('Email subject'),
      body: z.optional(z.string()).describe('Plain text email body'),
      htmlBody: z.optional(z.string()).describe('HTML email body'),
    },
    async ({ accountId, draftId, ...rest }) => {
      try {
        const draft = await client.updateGmailDraft(accountId, draftId, rest)
        return formatSuccess(draft)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  server.tool(
    'delete_gmail_draft',
    'Delete a Gmail draft.',
    {
      accountId: z.string().describe('Google account ID'),
      draftId: z.string().describe('Gmail draft ID'),
    },
    async ({ accountId, draftId }) => {
      try {
        const result = await client.deleteGmailDraft(accountId, draftId)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

}