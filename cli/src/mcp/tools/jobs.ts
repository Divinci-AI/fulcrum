// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Job scheduling MCP tools
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

const JobScopeSchema = z.enum(['all', 'user', 'system'])

export const registerJobTools: ToolRegistrar = (server, client) => {
  // list_jobs
  server.tool(
    'list_jobs',
    'List scheduled jobs (systemd timers on Linux, launchd on macOS)',
    {
      scope: z.optional(JobScopeSchema).describe('Filter by scope: all, user, or system (default: all)'),
    },
    async ({ scope }) => {
      try {
        const jobs = await client.listJobs(scope)
        return formatSuccess(jobs)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_job
  server.tool(
    'get_job',
    'Get details of a scheduled job including schedule, command, execution stats, and unit file contents',
    {
      name: z.string().describe('Job/timer name'),
      scope: z.optional(z.enum(['user', 'system'])).describe('Job scope (default: user)'),
    },
    async ({ name, scope }) => {
      try {
        const job = await client.getJob(name, scope)
        return formatSuccess(job)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_job_logs
  server.tool(
    'get_job_logs',
    'Get execution logs for a scheduled job (from journalctl)',
    {
      name: z.string().describe('Job/timer name'),
      scope: z.optional(z.enum(['user', 'system'])).describe('Job scope (default: user)'),
      lines: z.optional(z.number()).describe('Number of log lines to return (default: 100)'),
    },
    async ({ name, scope, lines }) => {
      try {
        const result = await client.getJobLogs(name, scope, lines)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // create_job
  server.tool(
    'create_job',
    'Create a new scheduled job (Linux systemd only). Creates a .timer and .service unit file.',
    {
      name: z.string().describe('Job name (alphanumeric, hyphens, underscores only)'),
      description: z.string().describe('Human-readable description'),
      schedule: z.string().describe('systemd OnCalendar schedule (e.g., "daily", "*-*-* 09:00:00", "Mon..Fri 09:00")'),
      command: z.string().describe('Command to execute'),
      workingDirectory: z.optional(z.string()).describe('Working directory for the command'),
      environment: z.optional(z.record(z.string(), z.string())).describe('Environment variables as key-value pairs'),
      persistent: z.optional(z.boolean()).describe('Run missed executions on next boot (default: true)'),
    },
    async ({ name, description, schedule, command, workingDirectory, environment, persistent }) => {
      try {
        const result = await client.createJob({
          name,
          description,
          schedule,
          command,
          workingDirectory,
          environment,
          persistent,
        })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // update_job
  server.tool(
    'update_job',
    'Update a scheduled job (Linux systemd only)',
    {
      name: z.string().describe('Job name to update'),
      description: z.optional(z.string()).describe('New description'),
      schedule: z.optional(z.string()).describe('New schedule'),
      command: z.optional(z.string()).describe('New command'),
      workingDirectory: z.optional(z.string()).describe('New working directory'),
      environment: z.optional(z.record(z.string(), z.string())).describe('New environment variables'),
      persistent: z.optional(z.boolean()).describe('Run missed executions on next boot'),
    },
    async ({ name, description, schedule, command, workingDirectory, environment, persistent }) => {
      try {
        const result = await client.updateJob(name, {
          description,
          schedule,
          command,
          workingDirectory,
          environment,
          persistent,
        })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // delete_job
  server.tool(
    'delete_job',
    'Delete a scheduled job (Linux systemd user jobs only)',
    {
      name: z.string().describe('Job name to delete'),
    },
    async ({ name }) => {
      try {
        const result = await client.deleteJob(name)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // enable_job
  server.tool(
    'enable_job',
    'Enable a scheduled job\'s timer so it runs on schedule',
    {
      name: z.string().describe('Job name'),
      scope: z.optional(z.enum(['user', 'system'])).describe('Job scope (default: user)'),
    },
    async ({ name, scope }) => {
      try {
        const result = await client.enableJob(name, scope)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // disable_job
  server.tool(
    'disable_job',
    'Disable a scheduled job\'s timer so it stops running',
    {
      name: z.string().describe('Job name'),
      scope: z.optional(z.enum(['user', 'system'])).describe('Job scope (default: user)'),
    },
    async ({ name, scope }) => {
      try {
        const result = await client.disableJob(name, scope)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // run_job_now
  server.tool(
    'run_job_now',
    'Trigger immediate execution of a scheduled job',
    {
      name: z.string().describe('Job name'),
      scope: z.optional(z.enum(['user', 'system'])).describe('Job scope (default: user)'),
    },
    async ({ name, scope }) => {
      try {
        const result = await client.runJobNow(name, scope)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}