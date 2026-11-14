import { afterEach, describe, expect, test } from 'bun:test'
import type { ClientRecord, PresenceMine } from '@keith/contracts'
import { frameUntil, pressUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const waitFor = async (check: () => boolean, what: string): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 15_000) throw new Error(`never happened: ${what}`)
    await Bun.sleep(15)
  }
}

const laptop: ClientRecord = {
  id: '0190a6a0-0000-4000-8000-0000000000aa',
  personId: 'owner',
  kind: 'tui',
  label: 'studio-mac',
  capabilities: ['chat', 'notify'],
  version: '0.1.0',
  firstSeenAt: 1,
  lastSeenAt: 2,
  lastActiveAt: 2,
  online: true,
}

const mine: Partial<PresenceMine> = {
  presence: {
    personId: 'owner',
    state: 'busy',
    reachableOn: [laptop.id],
    activeClient: laptop.id,
    note: 'in a meeting',
    asOf: 0,
  },
  status: { busy: true, note: 'in a meeting', until: Date.now() + 60 * 60_000 },
  clients: [laptop],
}

describe('the presence reporter in the app', () => {
  test('the terminal registers as a tui client with chat and notify', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await waitFor(() => core.presence.registers.length > 0, 'a register')
    expect(core.presence.registers[0]).toMatchObject({
      kind: 'tui',
      capabilities: ['chat', 'notify', 'open.view', 'render.markdown'],
    })
    unmount()
    void lastFrame
    void stdin
  })

  test('a key press makes the next heartbeat say active', async () => {
    const { stdin, core, unmount } = await setupApp({ presenceHeartbeatMs: 40 })
    await waitFor(() => core.presence.heartbeats.some((h) => !h.active), 'a quiet heartbeat')
    const before = core.presence.heartbeats.length
    stdin.write('x')
    await waitFor(
      () => core.presence.heartbeats.slice(before).some((h) => h.active),
      'an active heartbeat after the key',
    )
    unmount()
  })

  test('a notice for this client shows as a toast and is acked with ok', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await waitFor(() => core.presence.registers.length > 0, 'a register')
    const id = core.presence.registers[0]?.id ?? ''
    core.emit({
      type: 'brain.parietal.deliver',
      payload: {
        region: 'parietal',
        clientId: id,
        deliveryId: 'd-9',
        capability: 'notify',
        name: 'reminder',
      },
    })
    await frameUntil(lastFrame, (f) => f.includes('Keith · reminder'))
    await waitFor(() => core.presence.acks.some((a) => a.deliveryId === 'd-9'), 'the ack')
    expect(core.presence.acks.find((a) => a.deliveryId === 'd-9')).toEqual({
      id,
      deliveryId: 'd-9',
      ok: true,
    })
    unmount()
  })

  test('a notice with text shows the text in the toast', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await waitFor(() => core.presence.registers.length > 0, 'a register')
    const id = core.presence.registers[0]?.id ?? ''
    core.emit({
      type: 'brain.parietal.deliver',
      payload: {
        region: 'parietal',
        clientId: id,
        deliveryId: 'd-text',
        capability: 'notify',
        name: 'reminder',
        text: 'stand up at 9',
      },
    })
    await frameUntil(lastFrame, (f) => f.includes('Keith · reminder: stand up at 9'))
    unmount()
  })

  test('a notice for another client is not shown or acked', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await waitFor(() => core.presence.registers.length > 0, 'a register')
    core.emit({
      type: 'brain.parietal.deliver',
      payload: {
        region: 'parietal',
        clientId: '0190a6a0-0000-4000-8000-0000000000bb',
        deliveryId: 'd-other',
        capability: 'notify',
        name: 'reminder',
      },
    })
    await Bun.sleep(80)
    expect(lastFrame() ?? '').not.toContain('Keith · reminder')
    expect(core.presence.acks).toEqual([])
    unmount()
  })
})

describe('open.view deliveries', () => {
  const MENU = [{ id: 'notes.browse', plugin: 'notes', label: 'Notes', viewId: 'notes.list' }]
  const ask = (
    core: { emit(r: { type: string; payload: unknown }): void },
    id: string,
    deliveryId: string,
    name: string,
    capability = 'open.view',
  ) =>
    core.emit({
      type: 'brain.parietal.deliver',
      payload: { region: 'parietal', clientId: id, deliveryId, capability, name },
    })

  test('a delivery for a plugin view opens that view and posts the result', async () => {
    const { lastFrame, core, unmount } = await setupApp({
      views: { menu: MENU, frame: (h) => `view ${h.viewId} ${h.cols}x${h.rows}` },
    })
    await waitFor(() => core.presence.registers.length > 0, 'a register')
    await waitFor(() => (core.views?.menuReads ?? 0) > 0, 'the view menu')
    const id = core.presence.registers[0]?.id ?? ''
    ask(core, id, 'd-view', 'plugin:notes:list')
    await frameUntil(lastFrame, (f) => f.includes('view notes.list'))
    await waitFor(() => core.presence.acks.some((a) => a.deliveryId === 'd-view'), 'the ack')
    expect(core.presence.acks.find((a) => a.deliveryId === 'd-view')).toEqual({
      id,
      deliveryId: 'd-view',
      ok: true,
      result: 'opened',
    })
    unmount()
  })

  test('a view the menu does not list is acked unsupported and nothing opens', async () => {
    const { lastFrame, core, unmount } = await setupApp({
      views: { menu: MENU, frame: (h) => `view ${h.viewId}` },
    })
    await waitFor(() => core.presence.registers.length > 0, 'a register')
    await waitFor(() => (core.views?.menuReads ?? 0) > 0, 'the view menu')
    const id = core.presence.registers[0]?.id ?? ''
    ask(core, id, 'd-ghost', 'plugin:ghost:view')
    await waitFor(() => core.presence.acks.some((a) => a.deliveryId === 'd-ghost'), 'the ack')
    expect(core.presence.acks.find((a) => a.deliveryId === 'd-ghost')).toEqual({
      id,
      deliveryId: 'd-ghost',
      ok: false,
      result: 'unsupported',
    })
    expect(lastFrame() ?? '').not.toContain('view ghost')
    expect(core.views?.hellos).toEqual([])
    unmount()
  })

  test('a capability the terminal does not announce is acked unsupported', async () => {
    const { core, unmount } = await setupApp()
    await waitFor(() => core.presence.registers.length > 0, 'a register')
    const id = core.presence.registers[0]?.id ?? ''
    ask(core, id, 'd-loc', 'city', 'location.share')
    await waitFor(() => core.presence.acks.some((a) => a.deliveryId === 'd-loc'), 'the ack')
    expect(core.presence.acks.find((a) => a.deliveryId === 'd-loc')).toEqual({
      id,
      deliveryId: 'd-loc',
      ok: false,
      result: 'unsupported',
    })
    unmount()
  })
})

describe('/presence', () => {
  test('shows the state, the clients and the audiences with their levels', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({ presence: { mine } })
    await typeLine(stdin, '/presence')
    const frame = await frameUntil(lastFrame, (f) => f.includes('audience'))
    expect(frame).toContain('╭─ Presence ─╮')
    expect(frame).toContain('busy until')
    expect(frame).toContain('in a meeting')
    expect(frame).toContain('tui  studio-mac')
    expect(frame).toContain('online')
    expect(frame).toContain('owner')
    expect(frame).toContain('@users')
    expect(frame).toContain('detail')
    expect(frame).toContain('[esc] back')
    unmount()
  })

  test('enter cycles the selected audience and the change is sent', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({ presence: { mine } })
    await typeLine(stdin, '/presence')
    await frameUntil(lastFrame, (f) => f.includes('audience'))
    stdin.write('\r')
    await waitFor(() => core.presence.disclosureSets.length === 1, 'the first set')
    expect(core.presence.disclosureSets[0]).toEqual({ audience: 'owner', level: 'none' })
    // down to @users (state) and cycle it once more: detail
    stdin.write('\u001b[B')
    await Bun.sleep(30)
    stdin.write('\r')
    await waitFor(() => core.presence.disclosureSets.length === 2, 'the second set')
    expect(core.presence.disclosureSets[1]).toEqual({ audience: '@users', level: 'detail' })
    unmount()
  })

  test('esc closes it and the chat is back', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({ presence: { mine } })
    await typeLine(stdin, '/presence')
    await frameUntil(lastFrame, (f) => f.includes('audience'))
    await pressUntil(
      stdin,
      lastFrame,
      '\u001b',
      (f) => !f.includes('audience') && f.includes('type a message'),
    )
    unmount()
  })

  test('/busy 2h in a meeting sets the status; /free clears it', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await typeLine(stdin, '/busy 2h in a meeting')
    await frameUntil(lastFrame, (f) => f.includes('Busy until'))
    expect(core.presence.statusSets).toEqual([{ busy: true, note: 'in a meeting', minutes: 120 }])
    await typeLine(stdin, '/free')
    await frameUntil(lastFrame, (f) => f.includes('You are free.'))
    expect(core.presence.statusSets[1]).toEqual({ busy: false })
    unmount()
  })

  test('a bad /busy duration is refused with the usage and sets nothing', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await typeLine(stdin, '/busy 25h')
    await frameUntil(lastFrame, (f) => f.includes('Usage: /busy'))
    expect(core.presence.statusSets).toEqual([])
    unmount()
  })
})
