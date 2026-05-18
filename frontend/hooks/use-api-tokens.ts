/**
 * Self-managed API tokens (D-8 PR 3a).
 *
 * Reads/writes the calling user's `user_api_tokens` rows. The plaintext
 * is returned exactly once — at mint time. After that only `prefix`
 * (first 12 chars of plaintext) is recoverable for UI display.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

export interface ApiTokenView {
  id: string
  userId: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface MintedToken extends ApiTokenView {
  plaintext: string
}

const QUERY_KEY = ['users', 'me', 'tokens'] as const

export function useMyApiTokens() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      fetchJSON<{ tokens: ApiTokenView[] }>(`/api/users/me/tokens`).then(
        (r) => r.tokens
      ),
  })
}

export function useMintApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { name: string; expiresAt?: string | null }) =>
      fetchJSON<{ token: MintedToken }>(`/api/users/me/tokens`, {
        method: 'POST',
        body: JSON.stringify(vars),
      }).then((r) => r.token),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}

export function useRevokeApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tokenId: string) =>
      fetchJSON<{ success: boolean }>(`/api/users/me/tokens/${tokenId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
