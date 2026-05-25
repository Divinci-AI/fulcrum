import { useState, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Copy01Icon,
  CheckmarkCircle02Icon,
  AiInnovation01Icon,
  Globe02Icon,
  ComputerTerminal01Icon,
  SparklesIcon,
  Book02Icon,
} from '@hugeicons/core-free-icons'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { CodeBlock } from '@/components/ui/code-block'
import { usePort, useFulcrumVersion } from '@/hooks/use-config'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/docs')({
  component: DocsPage,
})

// Curated, human-readable summary of MCP tools by category.
// Tool counts are approximate and meant as a sketch for AI clients —
// the authoritative catalog lives in cli/src/mcp/registry.ts and is
// reachable at runtime via the `search_tools` tool.
const TOOL_CATEGORIES: Array<{
  name: string
  count: string
  blurb: string
  examples: string[]
}> = [
  {
    name: 'Tasks',
    count: '25+',
    blurb: 'Kanban tasks with worktrees, tags, links, attachments, dependencies, due dates, recurrence.',
    examples: ['list_tasks', 'create_task', 'move_task', 'set_task_due_date', 'get_task_dependency_graph'],
  },
  {
    name: 'Projects',
    count: '12',
    blurb: 'Projects, repository scanning, project tags, links, and file attachments.',
    examples: ['list_projects', 'create_project', 'scan_projects', 'add_project_tag'],
  },
  {
    name: 'Repositories',
    count: '10',
    blurb: 'Repository management, project linking, Copier template scaffolding.',
    examples: ['list_repositories', 'add_repository', 'link_repository_to_project', 'create_from_template'],
  },
  {
    name: 'Apps',
    count: '10',
    blurb: 'Docker Compose deployment, container status, logs, deployment history.',
    examples: ['list_apps', 'deploy_app', 'get_app_logs', 'stop_app'],
  },
  {
    name: 'Filesystem',
    count: '7',
    blurb: 'Read, write, edit files; list directories; recursive file trees with path-traversal protection.',
    examples: ['read_file', 'write_file', 'edit_file', 'list_directory', 'get_file_tree'],
  },
  {
    name: 'Execution',
    count: '4',
    blurb: 'Run shell commands with optional persistent sessions.',
    examples: ['execute_command', 'list_exec_sessions', 'destroy_exec_session'],
  },
  {
    name: 'Memory',
    count: '6',
    blurb: 'Persistent agent memory with FTS5 search; master MEMORY.md file.',
    examples: ['memory_store', 'memory_search', 'memory_file_read', 'memory_file_update'],
  },
  {
    name: 'Search',
    count: '1',
    blurb: 'Unified full-text search across tasks, projects, messages, events, memories, conversations.',
    examples: ['search'],
  },
  {
    name: 'Calendar',
    count: '13',
    blurb: 'CalDAV accounts, calendars, events, and one-way copy rules across calendars.',
    examples: ['list_calendar_events', 'create_calendar_event', 'sync_calendars', 'create_caldav_copy_rule'],
  },
  {
    name: 'Email & Gmail',
    count: '9',
    blurb: 'Stored email database, IMAP search/fetch, Gmail drafts via OAuth.',
    examples: ['list_emails', 'search_emails', 'list_gmail_drafts', 'create_gmail_draft'],
  },
  {
    name: 'Messaging',
    count: '2',
    blurb: 'Receive and send messages via WhatsApp, Discord, Telegram, Slack, Gmail.',
    examples: ['get_message', 'message'],
  },
  {
    name: 'Notifications',
    count: '3',
    blurb: 'Multi-channel notifications: Slack, Discord, Pushover, WhatsApp, Telegram, Gmail, sound, desktop.',
    examples: ['send_notification', 'get_notification_settings', 'update_notification_settings'],
  },
  {
    name: 'Jobs',
    count: '9',
    blurb: 'Scheduled jobs via systemd timers (Linux) or launchd (macOS).',
    examples: ['list_jobs', 'create_job', 'run_job_now', 'get_job_logs'],
  },
  {
    name: 'Settings',
    count: '4',
    blurb: 'Read and update Fulcrum configuration (~80 settings).',
    examples: ['list_settings', 'get_setting', 'update_setting', 'reset_setting'],
  },
  {
    name: 'Backup',
    count: '5',
    blurb: 'Database and settings snapshots with auto-safety-backup on restore.',
    examples: ['list_backups', 'create_backup', 'restore_backup'],
  },
  {
    name: 'Assistant',
    count: '2',
    blurb: 'Concierge tools: send messages via channels, query sweep history.',
    examples: ['message', 'get_last_sweep'],
  },
  {
    name: 'UI Context',
    count: '1',
    blurb: 'Read the user’s current browser context: route, selected entity, visible items.',
    examples: ['get_page_context'],
  },
  {
    name: 'Discovery',
    count: '1',
    blurb: 'Find any tool by keyword or category — start here when in doubt.',
    examples: ['search_tools'],
  },
]

function buildAiInstructions(port: number, version: string | null): string {
  const versionLine = version ? ` (v${version})` : ''
  const categoryLines = TOOL_CATEGORIES.map(
    (c) => `- **${c.name} (${c.count})** — ${c.blurb}`,
  ).join('\n')

  return `# Fulcrum MCP Integration${versionLine}

Fulcrum is a terminal-first orchestration tool for AI coding agents — it manages tasks, isolated git worktrees, projects, Docker Compose apps, persistent memory, calendars, email, messaging channels, and scheduled jobs. The user's instance is exposed via the Model Context Protocol (MCP) so you can read and act on their workflow directly.

## How to connect

Pick one transport:

**HTTP (streamable, recommended for hosted/remote AI):**
- URL: \`http://localhost:${port}/mcp\`
- Transport: \`streamable-http\` (stateless)

**Stdio (for desktop AI clients like Claude Desktop, Cursor, Continue):**
- Command: \`fulcrum mcp\`
- Requires the \`fulcrum\` CLI on PATH (\`npx @knowsuchagency/fulcrum@latest up\` once to install).

## Available tools (~130 total, grouped by category)

${categoryLines}

## Smart discovery

Fulcrum uses **deferred loading**: only the most-used tools are registered up-front. Everything else is discoverable at runtime by calling:

\`\`\`
search_tools(query="<keyword or category>")
\`\`\`

Examples: \`search_tools(query="calendar")\`, \`search_tools(query="docker deploy")\`, \`search_tools(query="email")\`. Always prefer \`search_tools\` over guessing — it returns the exact tool name, description, and schema you need to invoke next.

## How to be useful

- **When the user mentions tasks, deadlines, or work to do:** check \`list_tasks\` (or \`search\`) before answering — there is almost certainly relevant context.
- **When the user asks about "what they're looking at":** call \`get_page_context\` to see their current route and selection.
- **When acting on the user's behalf:** prefer Fulcrum tools over external knowledge. Create tasks, store memories, send notifications via Fulcrum so the work is tracked.
- **When unsure:** call \`search_tools\` first. The catalog is large — don't guess tool names.

Cite the tool you used in your response so the user can verify.`
}

function CopyButton({
  text,
  label,
  variant = 'default',
  size = 'sm',
  className,
}: {
  text: string
  label?: string
  variant?: 'default' | 'outline' | 'secondary' | 'ghost'
  size?: 'sm' | 'default' | 'lg'
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error('Copy failed')
    }
  }

  return (
    <Button onClick={handleCopy} variant={variant} size={size} className={className}>
      <HugeiconsIcon
        icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
        size={14}
        strokeWidth={2}
      />
      {label ?? (copied ? 'Copied' : 'Copy')}
    </Button>
  )
}

function TransportCard({
  icon,
  label,
  value,
  description,
}: {
  icon: typeof Globe02Icon
  label: string
  value: string
  description: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HugeiconsIcon icon={icon} size={16} strokeWidth={2} />
          {label}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 font-mono text-xs">
          <code className="flex-1 truncate select-all">{value}</code>
          <CopyButton text={value} variant="ghost" />
        </div>
      </CardContent>
    </Card>
  )
}

function ClientConfigTab({
  path,
  json,
}: {
  path: string
  json: string
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Config file:</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{path}</code>
      </div>
      <div className="relative">
        <CodeBlock code={json} language="json" />
        <div className="absolute right-2 top-2">
          <CopyButton text={json} variant="secondary" />
        </div>
      </div>
    </div>
  )
}

function DocsPage() {
  const { data: port } = usePort()
  const { version } = useFulcrumVersion()

  const httpUrl = `http://localhost:${port}/mcp`
  const stdioCommand = 'fulcrum mcp'

  const aiInstructions = useMemo(
    () => buildAiInstructions(port, version),
    [port, version],
  )

  const stdioConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            fulcrum: {
              command: 'fulcrum',
              args: ['mcp'],
            },
          },
        },
        null,
        2,
      ),
    [],
  )

  const httpConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            fulcrum: {
              type: 'http',
              url: httpUrl,
            },
          },
        },
        null,
        2,
      ),
    [httpUrl],
  )

  const opencodeConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcp: {
            fulcrum: {
              type: 'local',
              command: ['fulcrum', 'mcp'],
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    [],
  )

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        {/* Hero */}
        <div className="mb-10">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <HugeiconsIcon icon={Book02Icon} size={14} strokeWidth={2} />
            <span>Documentation</span>
            <span>/</span>
            <span>MCP</span>
          </div>
          <h1 className="mb-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            Connect AI agents to Fulcrum
          </h1>
          <p className="text-sm text-muted-foreground sm:text-base">
            Fulcrum exposes everything — tasks, projects, apps, files, memory, calendar,
            email, messaging — through the{' '}
            <a
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Model Context Protocol
            </a>
            . Point any MCP-capable AI at this server and it gets {TOOL_CATEGORIES.length}{' '}
            categories of tooling for your real workflow.
          </p>
        </div>

        {/* The big "tell your AI" card — the headline feature */}
        <Card
          className={cn(
            'mb-8 border-2',
            'ring-2 ring-accent/30',
          )}
        >
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <HugeiconsIcon icon={SparklesIcon} size={18} strokeWidth={2} />
                  Hand these instructions to any AI
                </CardTitle>
                <CardDescription className="mt-1">
                  Paste this into ChatGPT, Claude, Gemini, or any other assistant. It explains
                  how to connect to your Fulcrum instance and what tools are available.
                </CardDescription>
              </div>
              <CopyButton
                text={aiInstructions}
                label="Copy AI instructions"
                variant="default"
                size="default"
                className="shrink-0"
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {aiInstructions}
            </div>
          </CardContent>
        </Card>

        {/* Quick-connect transports */}
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Connection
        </h2>
        <div className="mb-8 grid gap-3 sm:grid-cols-2">
          <TransportCard
            icon={Globe02Icon}
            label="HTTP (streamable)"
            value={httpUrl}
            description="Stateless streamable HTTP. Works with any modern MCP client."
          />
          <TransportCard
            icon={ComputerTerminal01Icon}
            label="Stdio"
            value={stdioCommand}
            description="For desktop AI clients. Requires the fulcrum CLI on PATH."
          />
        </div>

        {/* Client-specific config */}
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Client configuration
        </h2>
        <Card className="mb-8">
          <CardContent className="pt-2">
            <Tabs defaultValue="claude-desktop">
              <TabsList className="mb-4 flex-wrap">
                <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
                <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
                <TabsTrigger value="cursor">Cursor</TabsTrigger>
                <TabsTrigger value="opencode">OpenCode</TabsTrigger>
                <TabsTrigger value="http">HTTP / Generic</TabsTrigger>
              </TabsList>

              <TabsContent value="claude-desktop">
                <ClientConfigTab
                  path="~/Library/Application Support/Claude/claude_desktop_config.json"
                  json={stdioConfig}
                />
              </TabsContent>

              <TabsContent value="claude-code">
                <div className="mb-3 text-xs text-muted-foreground">
                  Easiest: install the Claude Code plugin from the Fulcrum marketplace.
                </div>
                <CodeBlock
                  code={`claude plugin marketplace add knowsuchagency/fulcrum
claude plugin install fulcrum@fulcrum --scope user`}
                  language="bash"
                />
                <div className="mt-4 mb-2 text-xs text-muted-foreground">
                  Or add manually to <code className="rounded bg-muted px-1.5 py-0.5 font-mono">~/.claude/settings.json</code>:
                </div>
                <div className="relative">
                  <CodeBlock code={httpConfig} language="json" />
                  <div className="absolute right-2 top-2">
                    <CopyButton text={httpConfig} variant="secondary" />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="cursor">
                <ClientConfigTab path="~/.cursor/mcp.json" json={stdioConfig} />
              </TabsContent>

              <TabsContent value="opencode">
                <ClientConfigTab path="~/.config/opencode/config.json" json={opencodeConfig} />
              </TabsContent>

              <TabsContent value="http">
                <div className="mb-3 text-xs text-muted-foreground">
                  For any MCP client that supports streamable HTTP transport (no CLI required):
                </div>
                <div className="relative">
                  <CodeBlock code={httpConfig} language="json" />
                  <div className="absolute right-2 top-2">
                    <CopyButton text={httpConfig} variant="secondary" />
                  </div>
                </div>
                <div className="mt-3 rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                  Remote agents can reach this server over SSH port forwarding (
                  <code className="rounded bg-background px-1 py-0.5 font-mono">
                    ssh -L {port}:localhost:{port} your-server
                  </code>
                  ) or a Tailscale / Cloudflare Tunnel.
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Tool catalog */}
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Tool catalog
        </h2>
        <div className="mb-3 flex items-start gap-2 text-xs text-muted-foreground">
          <HugeiconsIcon
            icon={AiInnovation01Icon}
            size={14}
            strokeWidth={2}
            className="mt-0.5 shrink-0"
          />
          <span>
            ~130 tools total. Fulcrum uses deferred loading — agents discover what they need
            with{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">search_tools</code> rather
            than loading everything into context.
          </span>
        </div>
        <div className="mb-8 grid gap-3 sm:grid-cols-2">
          {TOOL_CATEGORIES.map((cat) => (
            <Card key={cat.name} size="sm">
              <CardContent>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">{cat.name}</h3>
                  <Badge variant="secondary" className="font-mono">
                    {cat.count}
                  </Badge>
                </div>
                <p className="mb-2 text-xs text-muted-foreground">{cat.blurb}</p>
                <div className="flex flex-wrap gap-1">
                  {cat.examples.map((tool) => (
                    <code
                      key={tool}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                    >
                      {tool}
                    </code>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="rounded-md border border-dashed bg-muted/30 p-4 text-xs text-muted-foreground">
          <strong className="text-foreground">Tip:</strong> Once connected, ask your AI to call{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">search_tools</code> with a
          keyword (e.g. "calendar", "deploy", "memory") to discover the exact tools and schemas it
          needs.
        </div>
      </div>
    </div>
  )
}
