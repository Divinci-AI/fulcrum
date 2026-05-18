/**
 * Tenant user management hooks (D-8 PR 2).
 *
 * Wraps the admin-gated endpoints for listing, inviting, promoting, and
 * demoting users. The list query is also used by mention pickers and is
 * read-only for non-admins, so `useListUsers` is safe to call from
 * non-admin code paths. The mutations 4xx for non-admins.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

export interface TenantUser {
  id: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  isAdmin: boolean
  createdAt: string
  updatedAt: string
  /** null = invited (PR 1) or pre-D-6 row; non-null = has authenticated at
   * least once via CF Access / dev fallback. UI surfaces null as a faded
   * "invited" badge. */
  lastSeenAt: string | null
}

const LIST_KEY = ['users', 'list'] as const

export function useListUsers() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () =>
      fetchJSON<{ users: TenantUser[] }>(`/api/users`).then((r) => r.users),
  })
}

export interface InviteUserVars {
  email: string
  isAdmin?: boolean
  displayName?: string | null
}

export interface CfAccessResult {
  ok: boolean
  configured: boolean
  reason?: string
}

export interface InviteEmailResult {
  /** True iff an invite email was delivered or drafted. False = the
   * tenant has neither CF Email nor a Gmail-enabled inviter account,
   * OR (D-10 PR 9) CF reported a permanent bounce. */
  drafted: boolean
  /** D-10 PR 8: which path actually fired. */
  mode?: 'cloudflare' | 'gmail-draft' | 'none'
  /** Gmail draft id (only when mode='gmail-draft'). */
  draftId?: string
  /** D-10 PR 9: CF outcome bucket when mode='cloudflare'.
   *   - 'delivered': handed off to destination MX (best case)
   *   - 'queued': CF will retry (transient issue)
   *   - 'bounced': permanent failure; drafted will be false */
  delivery?: 'delivered' | 'queued' | 'bounced'
  reason?: string
}

export interface InviteResponse {
  user: TenantUser
  invitedBy: string
  cfAccess: CfAccessResult
  inviteEmail: InviteEmailResult
}

export function useInviteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: InviteUserVars) =>
      fetchJSON<InviteResponse>(`/api/users`, {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY })
    },
  })
}

export function useSetUserAdmin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: string; isAdmin: boolean }) =>
      fetchJSON<{ user: TenantUser; grantedBy: string }>(
        `/api/users/${vars.id}/admin`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isAdmin: vars.isAdmin }),
        }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY })
    },
  })
}

// D-10 PR 6 — resend the Gmail invite draft for an existing user row.
// Useful when the initial draft failed (e.g. Google account needed
// re-auth) or when the admin wants to remind an invitee.
export function useResendInvite() {
  return useMutation({
    mutationFn: (id: string) =>
      fetchJSON<{ user: TenantUser; inviteEmail: InviteEmailResult }>(
        `/api/users/${id}/resend-invite`,
        { method: 'POST' }
      ),
  })
}

// D-10 PR 6 — hard-delete a user. The server refuses self-delete and
// last-admin-delete with 409.
export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      fetchJSON<{
        success: boolean
        cfAccess: CfAccessResult
        cleanup: Record<string, number>
      }>(`/api/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY })
    },
  })
}
