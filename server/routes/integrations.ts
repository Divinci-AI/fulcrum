/**
 * Local desktop-app integrations (Claude Desktop, later Hermes Desktop).
 * These touch files in the OPERATOR's home directory, so they're gated on
 * an authenticated user — on a multi-user SaaS deployment they configure
 * the host machine, which only the operator/admin should do.
 */
import { Hono } from 'hono'
import {
  connectClaudeDesktop,
  disconnectClaudeDesktop,
  getClaudeDesktopStatus,
} from '../services/claude-desktop-config'
import { requireUser, type CurrentUserContext } from '../middleware/current-user'

const app = new Hono<CurrentUserContext>()

app.get('/claude-desktop', (c) => {
  requireUser(c)
  return c.json(getClaudeDesktopStatus())
})

app.post('/claude-desktop/connect', (c) => {
  requireUser(c)
  try {
    return c.json(connectClaudeDesktop())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to connect' }, 500)
  }
})

app.post('/claude-desktop/disconnect', (c) => {
  requireUser(c)
  try {
    return c.json(disconnectClaudeDesktop())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to disconnect' }, 500)
  }
})

export default app
