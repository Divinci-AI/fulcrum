/**
 * Cloudflare Access policy management (D-8 PR 5).
 *
 * Adds and removes individual emails from a CF Access policy's
 * `include[]` so admin-invoked invites also open the CF Access edge
 * for non-Divincian addresses. Config-gated: missing app/policy/account
 * IDs or token make every call a no-op with `{ ok: false, skipped: true,
 * reason }` so deployments without a per-user policy stay on
 * domain-only Divincians.
 *
 * Cloudflare semantics worth knowing:
 *   - Policy GET returns the full policy; PUT replaces it. We GET-merge-PUT.
 *   - `include[]` entries can be `{ email: { email: "..." } }` or other
 *     identity types; we only ever touch the email shape.
 *   - The token needs the "Account › Access: Apps and Policies › Edit"
 *     permission (already in the operator's token per RUNBOOK §3).
 */
import { getSettings } from '../lib/settings'
import { createLogger } from '../lib/logger'

const logger = createLogger('CloudflareAccess')

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CloudflareAccessResult {
  ok: boolean
  /** True when the call was a no-op because configuration is missing.
   * Distinguished from `ok:false` (hard CF error) so callers can choose
   * to surface a soft warning vs. a hard failure. */
  skipped: boolean
  reason?: string
}

interface CfAccessPolicyEmailEntry {
  email: { email: string }
}

interface CfAccessPolicyInclude {
  email?: { email: string }
  /** Other identity shapes (group, login_method, geo, etc.). We pass
   * them through unchanged on PUT — never mutate, never drop. */
  [key: string]: unknown
}

interface CfAccessPolicy {
  id: string
  name: string
  decision: string
  include: CfAccessPolicyInclude[]
  exclude?: CfAccessPolicyInclude[]
  require?: CfAccessPolicyInclude[]
  // ... CF returns many more fields; we don't enumerate them.
  [key: string]: unknown
}

interface CfApiResponse<T> {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result: T
}

function getCfConfig(): {
  apiToken: string | null
  accountId: string | null
  appId: string | null
  policyId: string | null
} {
  const s = getSettings()
  return {
    apiToken: s.integrations.cloudflareApiToken,
    accountId: s.integrations.cloudflareAccountId,
    appId: s.integrations.cloudflareAccessAppId,
    policyId: s.integrations.cloudflareAccessPolicyId,
  }
}

// Exposed so tests can override without spinning up a fetch mock layer.
type FetchImpl = typeof fetch
let _fetchImpl: FetchImpl = fetch
export function setCloudflareFetchImpl(impl: FetchImpl): void {
  _fetchImpl = impl
}
export function resetCloudflareFetchImpl(): void {
  _fetchImpl = fetch
}

async function cfFetch<T>(
  apiToken: string,
  path: string,
  init: RequestInit = {}
): Promise<CfApiResponse<T>> {
  const res = await _fetchImpl(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    throw new Error(`Cloudflare API ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as CfApiResponse<T>
  if (!body.success) {
    const summary = (body.errors ?? [])
      .map((e) => `${e.code} ${e.message}`)
      .join('; ')
    throw new Error(`Cloudflare API error: ${summary || 'unknown'}`)
  }
  return body
}

/**
 * Add `email` to the configured policy's `include[]` as a per-user
 * email rule. Idempotent: if the email is already present the call
 * returns ok without a server round-trip mutating duplicates.
 */
export async function addEmailToPolicy(email: string): Promise<CloudflareAccessResult> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return { ok: false, skipped: false, reason: 'empty email' }

  const cfg = getCfConfig()
  if (!cfg.apiToken || !cfg.accountId || !cfg.appId || !cfg.policyId) {
    return { ok: false, skipped: true, reason: 'CF Access not configured' }
  }

  try {
    const policyResponse = await cfFetch<CfAccessPolicy>(
      cfg.apiToken,
      `/accounts/${cfg.accountId}/access/apps/${cfg.appId}/policies/${cfg.policyId}`
    )
    const policy = policyResponse.result

    const already = policy.include.some(
      (inc) =>
        inc.email && typeof inc.email.email === 'string' &&
        inc.email.email.toLowerCase() === normalized
    )
    if (already) {
      logger.info('Email already in CF Access policy — no PUT', {
        email: normalized,
        policyId: cfg.policyId,
      })
      return { ok: true, skipped: false }
    }

    const newEntry: CfAccessPolicyEmailEntry = { email: { email: normalized } }
    const nextInclude = [...policy.include, newEntry]

    // Cloudflare's PUT replaces the full policy. We preserve every
    // field we received, only mutating include[].
    await cfFetch(
      cfg.apiToken,
      `/accounts/${cfg.accountId}/access/apps/${cfg.appId}/policies/${cfg.policyId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...policy, include: nextInclude }),
      }
    )
    logger.info('Added email to CF Access policy', {
      email: normalized,
      policyId: cfg.policyId,
    })
    return { ok: true, skipped: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('CF Access addEmailToPolicy failed', {
      email: normalized,
      error: message,
    })
    return { ok: false, skipped: false, reason: message }
  }
}

/**
 * Remove `email` from the configured policy's `include[]`. No-op when
 * the email isn't present or CF Access isn't configured.
 */
export async function removeEmailFromPolicy(
  email: string
): Promise<CloudflareAccessResult> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return { ok: false, skipped: false, reason: 'empty email' }

  const cfg = getCfConfig()
  if (!cfg.apiToken || !cfg.accountId || !cfg.appId || !cfg.policyId) {
    return { ok: false, skipped: true, reason: 'CF Access not configured' }
  }

  try {
    const policyResponse = await cfFetch<CfAccessPolicy>(
      cfg.apiToken,
      `/accounts/${cfg.accountId}/access/apps/${cfg.appId}/policies/${cfg.policyId}`
    )
    const policy = policyResponse.result

    const next = policy.include.filter(
      (inc) =>
        !(
          inc.email &&
          typeof inc.email.email === 'string' &&
          inc.email.email.toLowerCase() === normalized
        )
    )
    if (next.length === policy.include.length) {
      // Wasn't there — nothing to do.
      return { ok: true, skipped: false }
    }
    await cfFetch(
      cfg.apiToken,
      `/accounts/${cfg.accountId}/access/apps/${cfg.appId}/policies/${cfg.policyId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...policy, include: next }),
      }
    )
    logger.info('Removed email from CF Access policy', {
      email: normalized,
      policyId: cfg.policyId,
    })
    return { ok: true, skipped: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('CF Access removeEmailFromPolicy failed', {
      email: normalized,
      error: message,
    })
    return { ok: false, skipped: false, reason: message }
  }
}
