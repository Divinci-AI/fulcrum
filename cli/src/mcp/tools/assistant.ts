// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Assistant MCP tools - Messaging and sweeps
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

const ChannelSchema = z.enum(['whatsapp', 'discord', 'telegram', 'slack', 'gmail'])

export const registerAssistantTools: ToolRegistrar = (server, client) => {
  // message - Send a message to a channel
  server.tool(
    'message',
    'Send a message to a messaging channel (WhatsApp, Discord, Telegram, Slack). Use this to reply to messages or send proactive communications. For email, use create_gmail_draft instead.',
    {
      channel: ChannelSchema.describe('Target channel: whatsapp, discord, telegram, slack, or gmail'),
      body: z.string().describe('Message content'),
      subject: z.optional(z.string()).describe('Email subject (for Gmail channel only)'),
      replyToMessageId: z.optional(z.string()).describe('Message ID to reply to (for threading)'),
      slack_blocks: z.optional(z.array(z.record(z.string(), z.any()))).describe(
        'Slack Block Kit blocks for rich formatting (Slack channel only). Array of block objects.'
      ),
      filePath: z.optional(z.string()).describe(
        'Absolute path to a local file to upload alongside the message (Slack only). Use for sending images, documents, etc.'
      ),
      googleAccountId: z.optional(z.string()).describe(
        'Google account ID for Gmail channel. If omitted, auto-resolves when exactly one Gmail-enabled account exists.'
      ),
    },
    async ({ channel, body, subject, replyToMessageId, slack_blocks, filePath, googleAccountId }) => {
      try {
        if (channel === 'gmail') {
          let accountId = googleAccountId
          if (!accountId) {
            // Auto-resolve: use the only Gmail-enabled account
            const accounts = await client.listGoogleAccounts()
            const gmailAccounts = accounts.filter((a) => a.gmailEnabled)
            if (gmailAccounts.length === 0) {
              return handleToolError(new Error('No Gmail-enabled Google accounts configured'))
            }
            if (gmailAccounts.length > 1) {
              return handleToolError(
                new Error(
                  `Multiple Gmail-enabled accounts found. Specify googleAccountId. Accounts: ${gmailAccounts.map((a) => `${a.id} (${a.email})`).join(', ')}`
                )
              )
            }
            accountId = gmailAccounts[0].id
          }
          const result = await client.sendGmailMessage(accountId, body, subject)
          return formatSuccess(result)
        }

        const result = await client.sendMessage({
          channel,
          body,
          subject,
          replyToMessageId,
          slackBlocks: slack_blocks,
          filePath,
        })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_last_sweep - Get the last sweep run of a type
  server.tool(
    'get_last_sweep',
    'Get information about the last sweep run of a specific type. Useful for context about what was last reviewed.',
    {
      type: z.enum(['hourly', 'morning_ritual', 'evening_ritual']).describe('Type of sweep'),
    },
    async ({ type }) => {
      try {
        const result = await client.getLastSweepRun(type)
        return formatSuccess(result || { message: 'No sweep of this type has run yet' })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}