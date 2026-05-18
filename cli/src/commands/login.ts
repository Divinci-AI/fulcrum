/**
 * `fulcrum login` — save server URL + API token (D-8 PR 3b).
 *
 * Wraps `cli-config.ts` with a friendly CLI surface. Verifies that the
 * token actually authenticates by calling /api/users/me before writing
 * the config — so a typo'd token fails fast rather than silently
 * pollutes the file.
 *
 * Env-driven mode: passing `--token-stdin` reads the token from stdin
 * so it doesn't show up in shell history. The common path is still
 * `fulcrum login --url=... --token=fulc_...`.
 */
import { defineCommand } from 'citty'
import { FulcrumClient } from '../client'
import { CliError, ExitCodes } from '../utils/errors'
import { saveCliConfig } from '../utils/cli-config'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Save server URL + API token for subsequent CLI calls',
  },
  args: {
    url: {
      type: 'string',
      description: 'Fulcrum server URL (e.g. https://fulcrum-acme.divinci.ai)',
      required: false,
    },
    token: {
      type: 'string',
      description: 'API token (fulc_...). Use --token-stdin to read from stdin instead.',
      required: false,
    },
    'token-stdin': {
      type: 'boolean',
      description: 'Read token from stdin (no shell history footprint)',
      required: false,
    },
  },
  async run({ args }) {
    if (!args.url) {
      throw new CliError(
        'MISSING_URL',
        '--url is required (e.g. --url=https://fulcrum-acme.divinci.ai)',
        ExitCodes.INVALID_ARGS
      )
    }
    let token: string
    if (args['token-stdin']) {
      token = await readStdin()
    } else {
      token = args.token ?? ''
    }
    if (!token) {
      throw new CliError(
        'MISSING_TOKEN',
        'Provide an API token via --token or pipe it to --token-stdin',
        ExitCodes.INVALID_ARGS
      )
    }

    // Verify before we write — call /api/users/me with the candidate
    // token. FulcrumClient reads `FULCRUM_TOKEN` from env so we stash
    // the candidate there for the duration of the probe call.
    const savedEnvToken = process.env.FULCRUM_TOKEN
    process.env.FULCRUM_TOKEN = token
    let verified: { user: { email: string; isAdmin: boolean } | null }
    try {
      verified = await new FulcrumClient(args.url).getCurrentUser()
    } catch (err) {
      throw new CliError(
        'AUTH_FAILED',
        `Token verification failed: ${err instanceof Error ? err.message : String(err)}`,
        ExitCodes.ERROR
      )
    } finally {
      if (savedEnvToken !== undefined) process.env.FULCRUM_TOKEN = savedEnvToken
      else delete process.env.FULCRUM_TOKEN
    }
    if (!verified.user) {
      throw new CliError(
        'AUTH_FAILED',
        'Server returned null user — token did not resolve to an identity',
        ExitCodes.ERROR
      )
    }

    const path = saveCliConfig({ url: args.url, token })
    console.log(`Logged in as ${verified.user.email}${verified.user.isAdmin ? ' (admin)' : ''}`)
    console.log(`Config written to ${path}`)
  },
})
