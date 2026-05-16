/**
 * React Query hooks for the per-user GitHub accounts surface (D-6 PR 2).
 *
 * The legacy `useGitHubPat` hook in `use-config.ts` still exists for the
 * deprecated tenant-level setting; this module is the modern path. The two
 * coexist for one release while the boot-time bootstrap migrates the
 * legacy PAT into a `github_accounts` row.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

export interface GithubAccount {
  id: string
  label: string
  githubLogin: string | null
  githubAvatarUrl: string | null
  lastValidatedAt: string | null
  createdAt: string
  updatedAt: string
}

const QUERY_KEY = ['github', 'accounts'] as const

export function useGithubAccounts() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      fetchJSON<{ accounts: GithubAccount[] }>('/api/github/accounts').then((r) => r.accounts),
  })
}

export function useCreateGithubAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { label: string; pat: string }) =>
      fetchJSON<GithubAccount>('/api/github/accounts', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['github'] })
    },
  })
}

export function useUpdateGithubAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; label?: string; pat?: string }) =>
      fetchJSON<GithubAccount>(`/api/github/accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['github'] })
    },
  })
}

export function useDeleteGithubAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      fetchJSON<{ success: boolean }>(`/api/github/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['github'] })
    },
  })
}
