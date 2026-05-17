/**
 * Per-user notification preferences (D-6 PR 4).
 *
 * Reads/writes the calling user's overrides on top of the tenant-wide
 * notification settings. The tenant-wide knobs continue to live in the
 * Notifications section (managed by the existing useNotificationSettings).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

export interface NotificationPreferencesView {
  toastEnabled: boolean | null
  desktopEnabled: boolean | null
  soundEnabled: boolean | null
  pushoverEnabled: boolean | null
  pushoverUserKeySet: boolean
}

export interface PreferencePatch {
  toastEnabled?: boolean | null
  desktopEnabled?: boolean | null
  soundEnabled?: boolean | null
  pushoverEnabled?: boolean | null
  pushoverUserKey?: string | null
}

const QUERY_KEY = ['users', 'me', 'notifications'] as const

export function useMyNotificationPreferences() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      fetchJSON<{ preferences: NotificationPreferencesView }>(
        '/api/users/me/notifications'
      ).then((r) => r.preferences),
  })
}

export function useUpdateMyNotificationPreferences() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: PreferencePatch) =>
      fetchJSON<{ preferences: NotificationPreferencesView }>(
        '/api/users/me/notifications',
        { method: 'PATCH', body: JSON.stringify(patch) }
      ).then((r) => r.preferences),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
