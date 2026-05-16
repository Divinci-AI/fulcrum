import { Octokit } from '@octokit/rest'
import type { GithubAccount } from '../db'
import {
  listGithubAccountsForUser,
  getGithubAccountForUser,
  readPatForAccount,
} from './github-account-service'
import { log } from '../lib/logger'

export interface GitHubIssue {
  id: number
  number: number
  title: string
  htmlUrl: string
  createdAt: string
  updatedAt: string
  repository: { owner: string; repo: string; fullName: string }
  labels: { name: string; color: string }[]
}

export interface GitHubPR {
  id: number
  number: number
  title: string
  htmlUrl: string
  createdAt: string
  updatedAt: string
  draft: boolean
  repository: { owner: string; repo: string; fullName: string }
  author: { login: string; avatarUrl: string }
  labels: { name: string; color: string }[]
}

export interface GitHubUser {
  login: string
  avatarUrl: string
}

export interface GitHubOrg {
  login: string
  avatarUrl: string
}

export type PRFilter = 'all' | 'created' | 'assigned' | 'review_requested' | 'mentioned'
export type IssueFilter = 'assigned' | 'created' | 'mentioned'

// D-6 PR 2: Octokit clients are now per-account. Keyed by github_accounts.id.
// Each account's PAT is read from fnox on first use and the client is held in
// this map until the PAT rotates (handled by deleting the cache entry from
// `rotateGithubAccountPat` callers — for now we just re-read on every call,
// since the cost of Octokit construction is trivial).
const octokitByAccount = new Map<string, Octokit>()

// Resolves the active account for a user. If `accountId` is provided, that
// specific account is used after an ownership check; otherwise the user's
// first (earliest-created) account is used. Returns null when the user has
// no accounts — callers treat that as "GitHub not connected for this user".
function resolveAccount(userId: string, accountId?: string): GithubAccount | null {
  if (accountId) {
    return getGithubAccountForUser(accountId, userId) ?? null
  }
  const accounts = listGithubAccountsForUser(userId)
  return accounts[0] ?? null
}

export function getOctokitForUser(userId: string, accountId?: string): Octokit | null {
  const account = resolveAccount(userId, accountId)
  if (!account) return null
  const cached = octokitByAccount.get(account.id)
  if (cached) return cached
  const pat = readPatForAccount(account)
  if (!pat) {
    log.github.warn('GitHub account row exists but PAT secret is missing', {
      accountId: account.id,
    })
    return null
  }
  const client = new Octokit({ auth: pat })
  octokitByAccount.set(account.id, client)
  return client
}

// Clear cached Octokit clients for an account. Callers MUST invoke this
// after rotating or deleting an account so a stale client doesn't keep
// using the old PAT.
export function invalidateGithubAccountCache(accountId: string): void {
  octokitByAccount.delete(accountId)
}

// Test/dev seam: drop every cached client. Wired into the test env reset.
export function clearAllGithubCaches(): void {
  octokitByAccount.clear()
}

// Parse GitHub remote URL to extract owner/repo
// Handles: https://github.com/owner/repo.git, git@github.com:owner/repo.git
export function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | null {
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] }
  }

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }

  return null
}

export async function getAuthenticatedUser(
  userId: string,
  accountId?: string
): Promise<GitHubUser | null> {
  const octokit = getOctokitForUser(userId, accountId)
  if (!octokit) return null

  try {
    const { data } = await octokit.users.getAuthenticated()
    return {
      login: data.login,
      avatarUrl: data.avatar_url,
    }
  } catch {
    return null
  }
}

export async function fetchUserOrgs(userId: string, accountId?: string): Promise<GitHubOrg[]> {
  const octokit = getOctokitForUser(userId, accountId)
  if (!octokit) return []

  try {
    const { data } = await octokit.orgs.listForAuthenticatedUser({
      per_page: 100,
    })
    return data.map((org) => ({
      login: org.login,
      avatarUrl: org.avatar_url,
    }))
  } catch (err) {
    log.github.error('Failed to fetch GitHub orgs', { error: String(err) })
    return []
  }
}

export async function fetchUserIssues(
  userId: string,
  filter: IssueFilter = 'assigned',
  repoFilters?: { owner: string; repo: string }[],
  org?: string,
  accountId?: string
): Promise<GitHubIssue[]> {
  const octokit = getOctokitForUser(userId, accountId)
  if (!octokit) return []

  try {
    // Build search query based on filter
    const filterQueries: Record<IssueFilter, string> = {
      assigned: 'is:issue is:open assignee:@me',
      created: 'is:issue is:open author:@me',
      mentioned: 'is:issue is:open mentions:@me',
    }
    let query = filterQueries[filter]

    // Add org filter
    if (org) {
      query = `${query} org:${org}`
    } else if (repoFilters && repoFilters.length > 0) {
      const repoQueries = repoFilters.map((r) => `repo:${r.owner}/${r.repo}`).join(' ')
      query = `${query} ${repoQueries}`
    }

    const { data } = await octokit.search.issuesAndPullRequests({
      q: query,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
    })

    return data.items
      .filter((item) => !('pull_request' in item && item.pull_request))
      .map((issue) => {
        // Extract owner/repo from repository_url
        const repoMatch = issue.repository_url.match(/repos\/([^/]+)\/([^/]+)$/)
        const owner = repoMatch?.[1] ?? ''
        const repo = repoMatch?.[2] ?? ''

        return {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          htmlUrl: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          repository: {
            owner,
            repo,
            fullName: `${owner}/${repo}`,
          },
          labels: (issue.labels ?? [])
            .filter((l): l is { name: string; color: string } => typeof l === 'object' && l !== null && 'name' in l)
            .map((l) => ({
              name: l.name ?? '',
              color: l.color ?? '',
            })),
        }
      })
  } catch (err) {
    log.github.error('Failed to fetch GitHub issues', { error: String(err) })
    return []
  }
}

export async function fetchUserPRs(
  userId: string,
  filter: PRFilter,
  repoFilters?: { owner: string; repo: string }[],
  org?: string,
  accountId?: string
): Promise<GitHubPR[]> {
  const octokit = getOctokitForUser(userId, accountId)
  if (!octokit) return []

  try {
    const results: GitHubPR[] = []

    // Build scope filter (org or repo list)
    let scopeQueryPart = ''
    if (org) {
      scopeQueryPart = `org:${org}`
    } else if (repoFilters && repoFilters.length > 0) {
      scopeQueryPart = repoFilters.map((r) => `repo:${r.owner}/${r.repo}`).join(' ')
    }

    // Helper to parse PR from API response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsePR = (pr: any): GitHubPR => {
      const repoMatch = pr.repository_url.match(/repos\/([^/]+)\/([^/]+)$/)
      const owner = repoMatch?.[1] ?? ''
      const repo = repoMatch?.[2] ?? ''

      return {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        htmlUrl: pr.html_url,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        draft: pr.draft ?? false,
        repository: {
          owner,
          repo,
          fullName: `${owner}/${repo}`,
        },
        author: {
          login: pr.user?.login ?? '',
          avatarUrl: pr.user?.avatar_url ?? '',
        },
        labels: (pr.labels ?? [])
          .filter((l): l is { name: string; color: string } => typeof l === 'object' && l !== null && 'name' in l)
          .map((l) => ({
            name: l.name ?? '',
            color: l.color ?? '',
          })),
      }
    }

    // Fetch based on filter
    if (filter === 'all' || filter === 'created') {
      const query = `is:pr is:open author:@me ${scopeQueryPart}`.trim()
      const { data } = await octokit.search.issuesAndPullRequests({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      })
      for (const pr of data.items) {
        results.push(parsePR(pr))
      }
    }

    if (filter === 'all' || filter === 'assigned') {
      const query = `is:pr is:open assignee:@me ${scopeQueryPart}`.trim()
      const { data } = await octokit.search.issuesAndPullRequests({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      })
      for (const pr of data.items) {
        if (!results.some((r) => r.id === pr.id)) {
          results.push(parsePR(pr))
        }
      }
    }

    if (filter === 'all' || filter === 'review_requested') {
      const query = `is:pr is:open review-requested:@me ${scopeQueryPart}`.trim()
      const { data } = await octokit.search.issuesAndPullRequests({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      })
      for (const pr of data.items) {
        if (!results.some((r) => r.id === pr.id)) {
          results.push(parsePR(pr))
        }
      }
    }

    if (filter === 'all' || filter === 'mentioned') {
      const query = `is:pr is:open mentions:@me ${scopeQueryPart}`.trim()
      const { data } = await octokit.search.issuesAndPullRequests({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      })
      for (const pr of data.items) {
        if (!results.some((r) => r.id === pr.id)) {
          results.push(parsePR(pr))
        }
      }
    }

    // Sort by updated date (newest first)
    results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    return results
  } catch (err) {
    log.github.error('Failed to fetch GitHub PRs', { error: String(err) })
    return []
  }
}
