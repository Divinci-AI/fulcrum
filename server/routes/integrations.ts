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
import { requireAdminUser, type CurrentUserContext } from '../middleware/current-user'

const app = new Hono<CurrentUserContext>()

// All three are admin-gated: they read/write files in the HOST machine's
// home directory. On a multi-user deployment a regular member must not be
// able to modify the operator's Claude Desktop config.
app.get('/claude-desktop', (c) => {
  requireAdminUser(c)
  return c.json(getClaudeDesktopStatus())
})

app.post('/claude-desktop/connect', (c) => {
  requireAdminUser(c)
  try {
    return c.json(connectClaudeDesktop())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to connect' }, 500)
  }
})

app.post('/claude-desktop/disconnect', (c) => {
  requireAdminUser(c)
  try {
    return c.json(disconnectClaudeDesktop())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to disconnect' }, 500)
  }
})

export default app
