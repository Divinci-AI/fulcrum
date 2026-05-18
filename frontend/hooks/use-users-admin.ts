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
  drafted: boolean
  draftId?: string
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
