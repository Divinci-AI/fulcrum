/**
 * Thin wrapper for sending notifications via messaging channels.
 * Separated from channels/index.ts to allow independent mocking in notification tests
 * without affecting messaging channel tests.
 *
 * D-7 PR 4: optional `recipientChannelId` threads the per-user
 * channel-native id (from `channel_identity_mappings`) through to the
 * unified `sendMessageToChannel`. The dispatcher passes it when a
 * notification has a `recipientUserId` and that user has registered an
 * id for this channel. Without it, the channel adapter falls back to
 * the legacy auto-resolved recipient.
 */
import { sendMessageToChannel } from './channels'

export async function sendNotificationViaMessaging(
  channel: 'whatsapp' | 'discord' | 'telegram' | 'slack',
  body: string,
  recipientChannelId?: string
): Promise<{ success: boolean; error?: string }> {
  return sendMessageToChannel(channel, body, { to: recipientChannelId })
}
