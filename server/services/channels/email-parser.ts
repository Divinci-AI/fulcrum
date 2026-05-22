/**
 * Email parsing utilities for headers and content extraction.
 */

import { log } from '../../lib/logger'
import { type EmailHeaders, SIGNATURE_PATTERNS, QUOTED_REPLY_PATTERNS } from './email-types'

/**
 * Parse email headers from raw source.
 */
export function parseEmailHeaders(
  source: Buffer,
  envelope: { from?: { address?: string; name?: string }[]; subject?: string; date?: string | Date }
): EmailHeaders {
  const raw = source.toString('utf-8')
  const headerEnd = raw.indexOf('\r\n\r\n')
  const headerSection = headerEnd > 0 ? raw.slice(0, headerEnd) : raw

  // Helper to extract header value
  const getHeader = (name: string): string | null => {
    const regex = new RegExp(`^${name}:\\s*(.+?)(?=\\r?\\n(?:[^\\s]|$))`, 'im')
    const match = headerSection.match(regex)
    return match ? match[1].replace(/\r?\n\s+/g, ' ').trim() : null
  }

  // Parse addresses from header value
  const parseAddresses = (header: string | null): string[] => {
    if (!header) return []
    const addresses: string[] = []
    // Match email addresses in various formats
    const regex = /<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/g
    let match
    while ((match = regex.exec(header)) !== null) {
      addresses.push(match[1].toLowerCase())
    }
    return addresses
  }

  // Parse References header (space-separated Message-IDs)
  const referencesHeader = getHeader('References')
  const references = referencesHeader
    ? referencesHeader.split(/\s+/).filter(r => r.startsWith('<') || r.includes('@'))
    : []

  return {
    messageId: getHeader('Message-ID'),
    inReplyTo: getHeader('In-Reply-To'),
    references,
    from: envelope?.from?.[0]?.address?.toLowerCase() || parseAddresses(getHeader('From'))[0] || null,
    fromName: envelope?.from?.[0]?.name || null,
    to: parseAddresses(getHeader('To')),
    cc: parseAddresses(getHeader('Cc')),
    subject: envelope?.subject || getHeader('Subject'),
    date: envelope?.date ? new Date(envelope.date) : null,
    // Headers for automated email detection (RFC 3834 compliance)
    autoSubmitted: getHeader('Auto-Submitted'),
    precedence: getHeader('Precedence'),
    listUnsubscribe: getHeader('List-Unsubscribe'),
    xAutoResponseSuppress: getHeader('X-Auto-Response-Suppress'),
    xMailer: getHeader('X-Mailer'),
    contentType: getHeader('Content-Type'),
    returnPath: getHeader('Return-Path'),
  }
}

/**
 * Parse email content from raw source, handling multipart and encoding.
 */
export async function parseEmailContent(source: Buffer, connectionId: string): Promise<string | null> {
  try {
    const raw = source.toString('utf-8')

    // Find the content after headers (double newline)
    const headerEnd = raw.indexOf('\r\n\r\n')
    if (headerEnd === -1) return null

    let content = raw.slice(headerEnd + 4)

    // Handle multipart emails - extract text/plain part
    const contentTypeMatch = raw.match(/Content-Type:\s*([^;\r\n]+)/i)
    const contentType = contentTypeMatch?.[1]?.toLowerCase() || ''

    if (contentType.includes('multipart')) {
      // Extract boundary
      const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i)
      if (boundaryMatch) {
        const boundary = boundaryMatch[1]
        const parts = content.split(`--${boundary}`)

        // Find text/plain part first, then fall back to text/html
        let foundPart: { body: string; encoding: string | null } | null = null
        let htmlPart: { body: string; encoding: string | null } | null = null

        for (const part of parts) {
          const partLower = part.toLowerCase()
          const partContentStart = part.indexOf('\r\n\r\n')
          if (partContentStart === -1) continue

          const partHeaders = part.slice(0, partContentStart).toLowerCase()
          const partBody = part.slice(partContentStart + 4)
          const encodingMatch = partHeaders.match(/content-transfer-encoding:\s*(\S+)/)
          const encoding = encodingMatch?.[1] ?? null

          if (partLower.includes('content-type: text/plain')) {
            foundPart = { body: partBody, encoding }
            break
          }
          if (!htmlPart && partLower.includes('content-type: text/html')) {
            htmlPart = { body: partBody, encoding }
          }
        }

        // Fall back to HTML part if no text/plain
        if (!foundPart && htmlPart) {
          foundPart = htmlPart
        }

        if (foundPart) {
          content = foundPart.body
          // Decode the part's transfer encoding
          if (foundPart.encoding === 'quoted-printable') {
            content = decodeQuotedPrintable(content)
          } else if (foundPart.encoding === 'base64') {
            content = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8')
          }
          // Strip HTML if this was an HTML part
          if (foundPart === htmlPart) {
            content = stripHtml(content)
          }
          // Skip the global encoding handlers
          return cleanEmailContent(content).trim() || null
        }
      }
    }

    // Handle quoted-printable encoding (non-multipart)
    if (raw.toLowerCase().includes('content-transfer-encoding: quoted-printable')) {
      content = decodeQuotedPrintable(content)
    }

    // Handle base64 encoding (non-multipart)
    if (raw.toLowerCase().includes('content-transfer-encoding: base64')) {
      content = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8')
    }

    // Handle non-multipart HTML emails
    if (contentType.includes('text/html')) {
      content = stripHtml(content)
    }

    // Clean up the content
    content = cleanEmailContent(content)

    return content.trim() || null
  } catch (err) {
    log.messaging.error('Failed to parse email content', {
      connectionId,
      error: String(err),
    })
    return null
  }
}

/**
 * Decode quoted-printable encoded content.
 */
export function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // Remove soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * Strip HTML tags and convert to readable plain text.
 */
export function stripHtml(html: string): string {
  let text = html
  // Remove <style> and <script> blocks entirely
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  // Replace block-level elements with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/?(p|div|tr|h[1-6]|blockquote|section|article|header|footer)[\s>][^>]*>/gi, '\n')
  text = text.replace(/<li[\s>][^>]*>/gi, '\n- ')
  text = text.replace(/<\/li>/gi, '')
  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '')
  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  // Normalize whitespace
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}

/**
 * Clean email content by stripping signatures and quoted replies.
 */
export function cleanEmailContent(content: string): string {
  let cleaned = content

  // Strip signatures
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = cleaned.match(pattern)
    if (match) {
      cleaned = cleaned.slice(0, match.index)
    }
  }

  // Strip quoted replies
  for (const pattern of QUOTED_REPLY_PATTERNS) {
    const match = cleaned.match(pattern)
    if (match && match.index !== undefined) {
      cleaned = cleaned.slice(0, match.index)
    }
  }

  // Normalize whitespace
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned
}
