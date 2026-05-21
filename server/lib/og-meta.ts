import { eq } from 'drizzle-orm'
import { db, tasks, projects, repositories } from '../db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

// Short, stable hash of a string — used as ?v=<hash> on OG image URLs so
// crawlers (Slack/Discord/iMessage cache aggressively by URL) re-fetch when
// content changes. Not cryptographic — just enough to bust caches.
function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36).slice(0, 8)
}

export type OgMeta = {
  title: string
  description: string
  image: string
  url: string
  type: 'website' | 'article'
}

function buildMetaTags(meta: OgMeta): string {
  const t = escapeHtml(meta.title)
  const d = escapeHtml(meta.description)
  const img = escapeHtml(meta.image)
  const url = escapeHtml(meta.url)
  return [
    `<meta property="og:type" content="${meta.type}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:image" content="${img}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:site_name" content="Fulcrum" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${img}" />`,
    `<meta name="description" content="${d}" />`,
  ].join('\n    ')
}

function originFrom(host: string, proto: string): string {
  return `${proto}://${host}`
}

function resolveProto(headers: Headers): string {
  // Behind Cloudflare/nginx the original protocol is in x-forwarded-proto.
  const xfp = headers.get('x-forwarded-proto')
  if (xfp) return xfp.split(',')[0].trim()
  return 'https'
}

function statusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    TO_DO: 'To Do',
    IN_PROGRESS: 'In Progress',
    IN_REVIEW: 'In Review',
    DONE: 'Done',
    CANCELED: 'Canceled',
  }
  return map[status ?? 'TO_DO'] ?? (status ?? '')
}

function describeTask(t: { title: string; status: string | null; description: string | null; dueDate: string | null }, projectName: string | null): string {
  const parts: string[] = []
  if (projectName) parts.push(projectName)
  parts.push(statusLabel(t.status))
  if (t.dueDate) parts.push(`due ${t.dueDate}`)
  const header = parts.join(' · ')
  if (t.description) {
    return `${header} — ${truncate(t.description, 160)}`
  }
  return header
}

/**
 * Resolves OG metadata for a given path+query. Returns null when the URL
 * isn't a known unfurl-worthy route (caller should fall back to default tags).
 */
export function resolveOgMeta(
  reqPath: string,
  reqQuery: Record<string, string>,
  headers: Headers
): OgMeta | null {
  const host = headers.get('host') ?? 'fulcrum'
  const proto = resolveProto(headers)
  const origin = originFrom(host, proto)

  // Tasks: /tasks?task=<id>  OR  /tasks/<id>
  let taskId: string | null = null
  if (reqPath === '/tasks' || reqPath === '/tasks/') {
    const q = reqQuery.task
    if (q && UUID_RE.test(q)) taskId = q
  } else if (reqPath.startsWith('/tasks/')) {
    const seg = reqPath.slice('/tasks/'.length).split('/')[0]
    if (seg && UUID_RE.test(seg)) taskId = seg
  }
  if (taskId) {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) return null
    const project = task.projectId
      ? db.select().from(projects).where(eq(projects.id, task.projectId)).get()
      : null
    const title = `${truncate(task.title, 100)} · Fulcrum`
    const description = describeTask(task, project?.name ?? null)
    const v = shortHash(task.updatedAt ?? task.id)
    return {
      title,
      description: description || 'Fulcrum task',
      image: `${origin}/og/task/${task.id}.png?v=${v}`,
      url: `${origin}${reqPath}${taskId === reqQuery.task ? `?task=${taskId}` : ''}`,
      type: 'article',
    }
  }

  // Projects: /projects/<id>
  if (reqPath.startsWith('/projects/')) {
    const seg = reqPath.slice('/projects/'.length).split('/')[0]
    if (seg && UUID_RE.test(seg)) {
      const project = db.select().from(projects).where(eq(projects.id, seg)).get()
      if (!project) return null
      const v = shortHash(project.updatedAt ?? project.id)
      return {
        title: `${truncate(project.name, 100)} · Fulcrum`,
        description: project.description
          ? truncate(project.description, 180)
          : 'Project on Fulcrum',
        image: `${origin}/og/project/${project.id}.png?v=${v}`,
        url: `${origin}${reqPath}`,
        type: 'article',
      }
    }
  }

  // Repositories: /repositories/<id>
  if (reqPath.startsWith('/repositories/')) {
    const seg = reqPath.slice('/repositories/'.length).split('/')[0]
    if (seg && UUID_RE.test(seg)) {
      const repo = db.select().from(repositories).where(eq(repositories.id, seg)).get()
      if (!repo) return null
      const branch = repo.lastBaseBranch ? ` · ${repo.lastBaseBranch}` : ''
      const agent = repo.defaultAgent ? ` · ${repo.defaultAgent}` : ''
      const v = shortHash(repo.updatedAt ?? repo.id)
      return {
        title: `${truncate(repo.displayName, 100)} · Fulcrum`,
        description: `Repository${branch}${agent}`,
        image: `${origin}/og/repo/${repo.id}.png?v=${v}`,
        url: `${origin}${reqPath}`,
        type: 'article',
      }
    }
  }

  // Apps overview: /apps
  if (reqPath === '/apps' || reqPath === '/apps/') {
    return {
      title: 'Apps · Fulcrum',
      description: 'Deployed Docker Compose apps with auto DNS & tunnel routing.',
      image: `${origin}/og/apps.png`,
      url: `${origin}${reqPath}`,
      type: 'website',
    }
  }

  // Default home/other pages — return a default unfurl. Returning null here
  // would leave the page with no OG tags at all; a generic card is friendlier.
  return {
    title: 'Fulcrum · Vibe Engineer’s Cockpit',
    description: 'Harness Attention. Orchestrate Agents. Ship.',
    image: `${origin}/og/default.png`,
    url: `${origin}${reqPath}`,
    type: 'website',
  }
}

/**
 * Injects OG meta tags into an HTML document by replacing the `</title>` close
 * tag with `</title>\n    <meta ...>\n    ...`. Safe to call on the standard
 * Vite-built index.html shell.
 */
export function injectOgMeta(html: string, meta: OgMeta): string {
  const tags = buildMetaTags(meta)
  // Replace <title>...</title> with a Fulcrum-prefixed title for the unfurl,
  // but keep the visible browser title minimal. Easier: leave the existing
  // <title>Fulcrum</title> alone and just append OG tags after it.
  if (html.includes('</title>')) {
    return html.replace('</title>', `</title>\n    ${tags}`)
  }
  // Fallback: append before </head>
  return html.replace('</head>', `    ${tags}\n  </head>`)
}
