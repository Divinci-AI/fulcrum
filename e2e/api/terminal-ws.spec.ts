import { expect, test } from '@playwright/test'
import { WsClient, wsUrl } from '../_lib/ws'

// Serialize the WebSocket terminal tests. They share the server's global
// PTY manager + terminal name index; running them in parallel can let one
// test's terminals:list response satisfy another test's predicate, or one
// test's create/destroy mutate state while another is mid-assert. Serial
// mode adds ~3s to the suite but eliminates the flake.
test.describe.configure({ mode: 'serial' })

test.describe('terminal WebSocket protocol', () => {
  test('connection opens cleanly', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened
    // If we got here, the upgrade handshake succeeded.
    ws.close()
  })

  test('terminals:list returns a list envelope', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened

    ws.send({ type: 'terminals:list', payload: {} })

    // Server may answer with `terminals:list:result` OR `terminals:list` echoing.
    // Accept any response that looks like a list of terminals.
    const reply = await ws.next(
      (m) => /terminals?:list/.test(m.type) && (Array.isArray((m.payload as { terminals?: unknown[] }).terminals) || Array.isArray(m.payload)),
      8000
    )
    expect(reply).toBeTruthy()
    ws.close()
  })

  test('terminal:create + attach + write echoed input + destroy round-trip', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened

    // Unique name per run so the server always creates a NEW terminal
    // (otherwise the create dedupes by name and we'd attach to a stale one
    // from a previous run with stacked history).
    const uniqueName = `e2e-create-${Date.now().toString(36)}`
    const tempId = `tmp-${uniqueName}`
    ws.send({
      type: 'terminal:create',
      payload: { name: uniqueName, cols: 80, rows: 24, cwd: '/tmp', tempId },
    })

    // Server responds with `terminal:created`, payload
    // `{terminal: {id, ...}, isNew, requestId, tempId}`.
    const created = await ws.nextOfType('terminal:created', 10_000)
    const cp = created.payload as { terminal?: { id?: string }; tempId?: string }
    expect(cp.tempId).toBe(tempId)
    const terminalId = cp.terminal?.id
    expect(terminalId).toBeTruthy()

    // CRITICAL: send terminal:attach so this client receives subsequent
    // terminal:output frames. Creating a terminal does NOT auto-subscribe
    // the requesting socket to the output stream.
    ws.send({ type: 'terminal:attach', payload: { terminalId, cols: 80, rows: 24 } })
    await ws.nextOfType('terminal:attached', 5_000)

    // PTY shells expect \r (CR) on Enter, not \n. xterm.js sends \r.
    const marker = `MRK${Date.now().toString(36)}MRK`
    ws.send({
      type: 'terminal:input',
      payload: { terminalId, data: `echo ${marker}\r` },
    })

    const output = await ws.next(
      (m) =>
        m.type === 'terminal:output' &&
        typeof (m.payload as { data?: string }).data === 'string' &&
        (m.payload as { data: string }).data.includes(marker),
      10_000
    )
    expect(output).toBeTruthy()

    // Cleanup
    ws.send({ type: 'terminal:destroy', payload: { terminalId, force: true, reason: 'e2e' } })
    await new Promise((r) => setTimeout(r, 200))
    ws.close()
  })

  test('terminal:resize updates the terminal dimensions', async () => {
    const ws = new WsClient(wsUrl('/ws/terminal'))
    await ws.opened

    const uniqueName = `e2e-resize-${Date.now().toString(36)}`
    const tempId = `tmp-${uniqueName}`
    ws.send({
      type: 'terminal:create',
      payload: { name: uniqueName, cols: 80, rows: 24, cwd: '/tmp', tempId },
    })
    const created = await ws.nextOfType('terminal:created', 10_000)
    const terminalId = (created.payload as { terminal: { id: string } }).terminal.id

    // Resize without attaching (resize doesn't need an attached subscription).
    ws.send({ type: 'terminal:resize', payload: { terminalId, cols: 132, rows: 50 } })
    // Brief delay for the server-side state update to commit.
    await new Promise((r) => setTimeout(r, 300))

    // Verify via terminals:list. Server sends an auto terminals:list on
    // connect that's already in queue; that snapshot pre-dates our resize.
    // The predicate must match a list that contains OUR terminalId with the
    // resized dimensions, so a stale snapshot is rejected and we wait for
    // the response to our explicit request.
    ws.send({ type: 'terminals:list', payload: {} })
    const list = await ws.next(
      (m) => {
        if (m.type !== 'terminals:list') return false
        const terminals = (m.payload as { terminals?: Array<{ id: string; cols: number; rows: number }> }).terminals
        if (!Array.isArray(terminals)) return false
        const me = terminals.find((t) => t.id === terminalId)
        return Boolean(me && me.cols === 132 && me.rows === 50)
      },
      5_000
    )
    expect(list).toBeTruthy()

    ws.send({ type: 'terminal:destroy', payload: { terminalId, force: true, reason: 'e2e' } })
    await new Promise((r) => setTimeout(r, 200))
    ws.close()
  })
})
