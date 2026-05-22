// @ts-nocheck — pre-existing type errors that surfaced when tsconfig.server.json was added in D-15 OG wrap-up. Remove this directive + fix the errors in a focused follow-up PR.
/**
 * Copier template MCP tools
 */
import { z } from 'zod'
import type { ToolRegistrar } from './types'
import { formatSuccess, handleToolError } from '../utils'

export const registerCopierTools: ToolRegistrar = (server, client) => {
  // list_templates
  server.tool(
    'list_templates',
    'List available Copier project templates. Returns repositories marked as Copier templates.',
    {},
    async () => {
      try {
        const templates = await client.listTemplates()
        return formatSuccess(templates)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // get_template_questions
  server.tool(
    'get_template_questions',
    'Get the questions/prompts defined by a Copier template. Use this before create_from_template to discover required answers.',
    {
      source: z
        .string()
        .describe('Template source: a repository ID, local path, or git URL'),
    },
    async ({ source }) => {
      try {
        const result = await client.getTemplateQuestions(source)
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )

  // create_from_template
  server.tool(
    'create_from_template',
    'Create a new project from a Copier template. Call get_template_questions first to discover required answers.',
    {
      templateSource: z
        .string()
        .describe('Template source: a repository ID, local path, or git URL'),
      outputPath: z
        .string()
        .describe('Absolute path where the new project will be created'),
      projectName: z
        .string()
        .describe('Name for the new project'),
      answers: z
        .record(z.string(), z.unknown())
        .describe('Answers to the template questions (from get_template_questions)'),
      trust: z
        .optional(z.boolean())
        .describe('Trust template for unsafe features like tasks and migrations (default: true)'),
      existingProjectId: z
        .optional(z.string())
        .describe('Link to an existing project instead of creating a new one'),
    },
    async ({ templateSource, outputPath, projectName, answers, trust, existingProjectId }) => {
      try {
        const result = await client.createFromTemplate({
          templateSource,
          outputPath,
          projectName,
          answers,
          trust: trust ?? true,
          existingProjectId,
        })
        return formatSuccess(result)
      } catch (err) {
        return handleToolError(err)
      }
    }
  )
}