import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

interface User {
  id: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  createdAt: string
  updatedAt: string
  lastSeenAt: string | null
}

/**
 * Current user as resolved by the `currentUser` middleware on the server
 * (CF Access header in prod, FULCRUM_DEV_USER_EMAIL fallback in dev).
 * Returns null when no identity is present.
 *
 * Cached indefinitely (staleTime: Infinity) because the user identity
 * doesn't change within a session — and even if displayName is patched
 * via PATCH /api/users/me, that mutation can invalidate this query
 * directly.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => fetchJSON<{ user: User | null }>(`/api/users/me`).then((r) => r.user),
    staleTime: Infinity,
  })
}
