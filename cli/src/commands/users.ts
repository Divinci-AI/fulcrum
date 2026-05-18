/**
 * `fulcrum users …` — tenant user management (D-8 PR 3b).
 *
 * Subcommands:
 *   list                       List every user in the tenant
 *   invite <email> [--admin]   Pre-provision a user row
 *   promote <email>            Set isAdmin = true
 *   demote  <email>            Set isAdmin = false
 *
 * Requires `fulcrum login` to have stored a bearer token (or
 * FULCRUM_TOKEN env). All write subcommands require an admin token.
 */
import { defineCommand } from 'citty'
import { FulcrumClient } from '../client'
import { output, isJsonOutput } from '../utils/output'
import { CliError, ExitCodes } from '../utils/errors'

interface UserRow {
  id: string
  email: string
  displayName: string | null
  isAdmin: boolean
  createdAt: string
  lastSeenAt: string | null
}

function fmtUser(u: UserRow): string {
  const role = u.isAdmin ? 'admin' : 'member'
  const seen = u.lastSeenAt
    ? `last seen ${new Date(u.lastSeenAt).toISOString().slice(0, 10)}`
    : 'invited (never signed in)'
  const name = u.displayName ? ` (${u.displayName})` : ''
  return `${u.email}${name} — ${role} — ${seen}`
}

async function findUserByEmail(client: FulcrumClient, email: string): Promise<UserRow> {
  const normalized = email.trim().toLowerCase()
  const { users } = await client.listUsers()
  const match = users.find((u) => u.email.toLowerCase() === normalized)
  if (!match) {
    throw new CliError(
      'USER_NOT_FOUND',
      `No user with email ${email} found in this tenant`,
      ExitCodes.NOT_FOUND
    )
  }
  return match
}

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List every user in the tenant' },
  args: {
    url: { type: 'string', required: false },
    port: { type: 'string', required: false },
  },
  async run({ args }) {
    const client = new FulcrumClient(args.url, args.port)
    const { users } = await client.listUsers()
    if (isJsonOutput()) {
      output(users)
      return
    }
    if (users.length === 0) {
      console.log('No users yet.')
      return
    }
    for (const u of users) console.log(fmtUser(u))
  },
})

const inviteCmd = defineCommand({
  meta: { name: 'invite', description: 'Pre-provision a user row (admin)' },
  args: {
    email: { type: 'positional', required: true },
    admin: { type: 'boolean', required: false, description: 'Grant admin' },
    'display-name': { type: 'string', required: false },
    url: { type: 'string', required: false },
    port: { type: 'string', required: false },
  },
  async run({ args }) {
    const client = new FulcrumClient(args.url, args.port)
    const { user } = await client.inviteUser({
      email: args.email,
      isAdmin: args.admin ? true : undefined,
      displayName: args['display-name'] ?? null,
    })
    if (isJsonOutput()) {
      output(user)
      return
    }
    console.log(`Invited ${user.email}${user.isAdmin ? ' (admin)' : ''}`)
  },
})

const promoteCmd = defineCommand({
  meta: { name: 'promote', description: 'Grant tenant-admin to a user (admin)' },
  args: {
    email: { type: 'positional', required: true },
    url: { type: 'string', required: false },
    port: { type: 'string', required: false },
  },
  async run({ args }) {
    const client = new FulcrumClient(args.url, args.port)
    const target = await findUserByEmail(client, args.email)
    const { user } = await client.setUserAdmin(target.id, true)
    if (isJsonOutput()) {
      output(user)
      return
    }
    console.log(`Promoted ${user.email} — now admin`)
  },
})

const demoteCmd = defineCommand({
  meta: { name: 'demote', description: 'Revoke tenant-admin from a user (admin)' },
  args: {
    email: { type: 'positional', required: true },
    url: { type: 'string', required: false },
    port: { type: 'string', required: false },
  },
  async run({ args }) {
    const client = new FulcrumClient(args.url, args.port)
    const target = await findUserByEmail(client, args.email)
    const { user } = await client.setUserAdmin(target.id, false)
    if (isJsonOutput()) {
      output(user)
      return
    }
    console.log(`Demoted ${user.email} — now member`)
  },
})

export const usersCommand = defineCommand({
  meta: { name: 'users', description: 'Tenant user management' },
  subCommands: {
    list: listCmd,
    invite: inviteCmd,
    promote: promoteCmd,
    demote: demoteCmd,
  },
})
