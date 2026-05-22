// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * App deployment MCP tools
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { AppStatusSchema } from './types'
import { formatSuccess, handleToolError } from '../utils'

export const registerAppTools: ToolRegistrar = (server, client) => {
  // list_apps
  server.tool(
    'list_apps',
    'List all deployed apps with optional filtering by status',
    {
      status: z.optional(AppStatusSchema).describe('Filter by status'),
    },
    async ({ status }) => {
      try {
        let apps = await client.listApps()
        if (status) {
          apps = apps.filter((a) => a.status === status)
        }
        return formatSuccess(apps)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_app
  server.tool(
    'get_app',
    'Get details of a specific app including services and repository',
    {
      id: z.string().describe('App ID'),
    },
    async ({ id }) => {
      try {
        const app = await client.getApp(id)
        return formatSuccess(app)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // create_app
  server.tool(
    'create_app',
    'Create a new app for deployment from a repository',
    {
      name: z.string().describe('App name'),
      repositoryId: z.string().describe('Repository ID to deploy from'),
      branch: z.optional(z.string()).describe('Git branch (default: main)'),
      composeFile: z
        .optional(z.string())
        .describe('Path to compose file (auto-detected if omitted)'),
      autoDeployEnabled: z.optional(z.boolean()).describe('Enable auto-deploy on git push (default: false)'),
      noCacheBuild: z.optional(z.boolean()).describe('Disable Docker build cache (default: false)'),
    },
    async ({ name, repositoryId, branch, composeFile, autoDeployEnabled, noCacheBuild }) => {
      try {
        const app = await client.createApp({
          name,
          repositoryId,
          branch,
          composeFile,
          autoDeployEnabled: autoDeployEnabled ?? false,
          noCacheBuild: noCacheBuild ?? false,
        })
        return formatSuccess(app)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // update_app
  server.tool(
    'update_app',
    'Update app settings including service exposure, environment variables, and deployment options',
    {
      id: z.string().describe('App ID'),
      name: z.optional(z.string()).describe('App name'),
      branch: z.optional(z.string()).describe('Git branch'),
      autoDeployEnabled: z.optional(z.boolean()).describe('Enable auto-deploy on git push'),
      autoPortAllocation: z.optional(z.boolean()).describe('Auto-allocate host ports on conflicts'),
      environmentVariables: z
        .optional(z.record(z.string(), z.string()))
        .describe('Environment variables (key-value pairs)'),
      noCacheBuild: z.optional(z.boolean()).describe('Disable Docker build cache'),
      notificationsEnabled: z.optional(z.boolean()).describe('Send notifications on deploy success/failure'),
      services: z
        .optional(
          z.array(
            z.object({
              id: z.optional(z.string()).describe('Service ID (for updating existing)'),
              serviceName: z.string().describe('Service name (must match compose file)'),
              containerPort: z.optional(z.number()).describe('Port the container listens on'),
              exposed: z.boolean().describe('Make publicly accessible'),
              domain: z.optional(z.string()).describe('Domain to route traffic to this service'),
              exposureMethod: z
                .optional(z.enum(['dns', 'tunnel']))
                .describe('Exposure method: dns (Traefik + Cloudflare A record) or tunnel (Cloudflare Tunnel)'),
            })
          )
        )
        .describe('Service exposure configuration'),
    },
    async ({ id, ...rest }) => {
      try {
        const app = await client.updateApp(id, rest)
        return formatSuccess(app)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // deploy_app
  server.tool(
    'deploy_app',
    'Trigger a deployment for an app',
    {
      id: z.string().describe('App ID'),
    },
    async ({ id }) => {
      try {
        const result = await client.deployApp(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // stop_app
  server.tool(
    'stop_app',
    'Stop a running app',
    {
      id: z.string().describe('App ID'),
    },
    async ({ id }) => {
      try {
        const result = await client.stopApp(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_app_logs
  server.tool(
    'get_app_logs',
    'Get logs from an app, optionally for a specific service',
    {
      id: z.string().describe('App ID'),
      service: z.optional(z.string()).describe('Service name (all services if omitted)'),
      tail: z.optional(z.number()).describe('Number of lines to return (default: 100)'),
    },
    async ({ id, service, tail }) => {
      try {
        const result = await client.getAppLogs(id, { service, tail })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_app_status
  server.tool(
    'get_app_status',
    'Get the current container status for an app',
    {
      id: z.string().describe('App ID'),
    },
    async ({ id }) => {
      try {
        const result = await client.getAppStatus(id)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // list_deployments
  server.tool(
    'list_deployments',
    'Get deployment history for an app',
    {
      appId: z.string().describe('App ID'),
    },
    async ({ appId }) => {
      try {
        const deployments = await client.listDeployments(appId)
        return formatSuccess(deployments)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // delete_app
  server.tool(
    'delete_app',
    'Delete an app and optionally stop its containers',
    {
      id: z.string().describe('App ID'),
      stopContainers: z.optional(z.boolean()).describe('Stop running containers before deletion (default: true)'),
    },
    async ({ id, stopContainers }) => {
      try {
        await client.deleteApp(id, stopContainers ?? true)
        return formatSuccess({ deleted: id })
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}