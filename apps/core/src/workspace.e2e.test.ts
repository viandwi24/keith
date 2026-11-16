/** P40.2 and P40.3: the workspace document over RPC and the feed, and Keith's `workspace` tool (docs/specs/workspace.md). */
import { afterAll, expect, test } from 'bun:test'
import { boot, cleanup, connect, FAST, newDir, send } from './testing/core-harness.ts'
import { testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

test('get, apply, conflict and the workspace-changed record on the person feed', async () => {
  const front = testProvider({ id: 'front-p', models: { f: [{ text: 'x' }] } })
  const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
  const r = await boot(newDir(), [front, worker] as never[], undefined, FAST)
  await connect(r.client)

  const empty = await r.client.rpc.workspace.get()
  expect(empty).toMatchObject({ version: 0, desktops: [{ id: 'd1', name: 'Desktop 1' }] })

  const open = {
    op: 'window.open' as const,
    desktopId: 'd1',
    id: 'w1',
    app: 'web:chat',
    title: 'Chat',
  }
  const applied = await r.client.rpc.workspace.apply({
    baseVersion: 0,
    ops: [open],
    clientId: 'tab-a',
  })
  expect(applied).toMatchObject({ status: 'applied', doc: { version: 1 } })
  expect(await r.client.rpc.workspace.get()).toEqual(applied.doc)

  const stale = await r.client.rpc.workspace.apply({ baseVersion: 0, ops: [{ ...open, id: 'w2' }] })
  expect(stale).toMatchObject({ status: 'conflict', doc: { version: 1 } })

  await expect(
    r.client.rpc.workspace.apply({ baseVersion: 1, ops: [{ ...open, app: 'not an app' }] }),
  ).rejects.toThrow()

  const feed = await r.client.harness.activity.page({ after: 0, limit: 500 })
  const changed = feed.events.filter((e) => e.type === 'workspace-changed')
  expect(changed).toHaveLength(1)
  expect(changed[0]?.payload).toMatchObject({
    version: 1,
    by: 'person',
    clientId: 'tab-a',
    ops: [open],
  })
  expect(changed[0]?.sessionId?.startsWith('front:')).toBe(true)
})

test('P40.5: the window apps come from the plugin web; a window of an app nobody contributes is refused', async () => {
  const front = testProvider({ id: 'front-p', models: { f: [{ text: 'x' }] } })
  const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
  const r = await boot(newDir(), [front, worker] as never[], undefined, FAST)
  await connect(r.client)

  const apps = await r.client.rpc.workspace.apps()
  const ids = apps.map((a) => a.id)
  expect(ids).toEqual(
    expect.arrayContaining(['web:tasks', 'web:browser', 'web:doc', 'web:media', 'web:tui']),
  )
  expect(apps.find((a) => a.id === 'web:browser')).toMatchObject({
    entry: { builtin: 'browser' },
    singleton: false,
    params: { type: 'object', properties: { url: { type: 'string' } } },
  })
  const refused = await r.client.rpc.workspace.apply({
    baseVersion: 0,
    ops: [{ op: 'window.open', desktopId: 'd1', id: 'w1', app: 'nope:app', title: 'X' }],
  })
  expect(refused).toMatchObject({ status: 'refused', error: 'unknown-app' })
  const bad = await r.client.rpc.workspace.apply({
    baseVersion: 0,
    ops: [
      {
        op: 'window.open',
        desktopId: 'd1',
        id: 'w1',
        app: 'web:browser',
        title: 'B',
        params: { url: 'http://x' },
      },
    ],
  })
  expect(bad).toMatchObject({ status: 'refused', error: 'bad-params' })
})

test('P40.3: Keith opens a window by keith, asks the screen to show it (held), the turn sees the screen, and the person undoes it', async () => {
  const WEB = crypto.randomUUID()
  const front = testProvider({
    id: 'front-p',
    models: {
      f: [
        {
          toolCalls: [
            {
              toolName: 'workspace',
              toolCallId: 'ws-1',
              input: { action: 'open', app: 'web:tasks', show: true },
            },
          ],
        },
        { text: 'Your tasks are on the workspace.' },
      ],
    },
  })
  const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
  const r = await boot(newDir(), [front, worker] as never[], undefined, FAST)
  await connect(r.client)

  // the person's web app: draws the workspace and shows it on request; it is busy, so it holds the request
  await r.client.rpc.presence.clients.register({
    id: WEB,
    kind: 'web',
    label: 'web-LABEL',
    capabilities: ['chat', 'workspace.show', 'render.workspace'],
    version: '0.0.0',
  })
  await r.client.rpc.presence.clients.heartbeat({
    id: WEB,
    active: true,
    view: { mode: 'workspace', desktopId: 'd1' },
  })
  const feed = r.client.feed()
  const names: string[] = []
  feed.subscribeEvents((record) => {
    const payload = record.payload as Record<string, unknown>
    if (record.type !== 'brain.parietal.deliver' || payload.clientId !== WEB) return
    names.push(String(payload.name))
    void r.client.rpc.presence.clients
      .ack({ id: WEB, deliveryId: String(payload.deliveryId), ok: true, result: 'held' })
      .catch(() => undefined)
  })
  let status = 'idle'
  feed.subscribe((state) => {
    status = state.status
  })
  feed.start()
  await until(
    'the feed is live',
    () => status === 'live',
    (ok) => ok,
  )

  await send(r.client, 'show me my tasks')

  // the window is Keith's, on the desktop the screen showed, and the screen was asked for exactly it
  const doc = await r.client.rpc.workspace.get()
  const window = doc.desktops[0]?.windows[0]
  expect(window).toMatchObject({ app: 'web:tasks', title: 'Tasks', openedBy: 'keith' })
  expect(names).toEqual([`d1/${window?.id}`])

  // the turn saw the screen in its reminder, and the tool result relays the held answer
  const prompts = JSON.stringify(front.models.get('f')?.prompts ?? [])
  expect(prompts).toContain(
    'On screen now: \\"web-LABEL\\", workspace, desktop \\"Desktop 1\\" (d1)',
  )
  expect(prompts).toContain('held')

  const events = (await r.client.harness.activity.page({ after: 0, limit: 500 })).events
  expect(events.find((e) => e.type === 'workspace-changed')?.payload).toMatchObject({ by: 'keith' })
  expect(events.find((e) => e.type === 'brain.parietal.workspace')?.payload).toMatchObject({
    region: 'parietal',
    action: 'open',
    ok: true,
  })

  // the person takes it back from the dock; a second undo has nothing to take back
  const undone = await r.client.rpc.workspace.undoKeith()
  expect(undone).toMatchObject({ status: 'applied', doc: { version: doc.version + 1 } })
  expect(undone.doc.desktops[0]?.windows).toEqual([])
  expect(await r.client.rpc.workspace.undoKeith()).toMatchObject({
    status: 'refused',
    error: 'nothing-to-undo',
  })
  feed.stop()
})

test('P40.3: with only a TUI online Keith opens a window with no screen, gets no-screen for show, and must ask before closing the person window', async () => {
  const TUI = crypto.randomUUID()
  const front = testProvider({
    id: 'front-p',
    models: {
      f: [
        {
          toolCalls: [
            {
              toolName: 'workspace',
              toolCallId: 'ws-1',
              input: { action: 'open', app: 'web:inbox', show: true },
            },
            {
              toolName: 'workspace',
              toolCallId: 'ws-2',
              input: { action: 'close', windowId: 'mine' },
            },
          ],
        },
        { text: 'The inbox waits on your workspace. Shall I close your chat window?' },
      ],
    },
  })
  const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
  const r = await boot(newDir(), [front, worker] as never[], undefined, FAST)
  await connect(r.client)
  await r.client.rpc.workspace.apply({
    baseVersion: 0,
    ops: [{ op: 'window.open', desktopId: 'd1', id: 'mine', app: 'web:chat', title: 'Chat' }],
  })
  await r.client.rpc.presence.clients.register({
    id: TUI,
    kind: 'tui',
    label: 'tui-LABEL',
    capabilities: ['chat', 'notify', 'render.markdown'],
    version: '0.0.0',
  })
  await r.client.rpc.presence.clients.heartbeat({ id: TUI, active: true })

  await send(r.client, 'put my inbox up and close the chat')

  const doc = await r.client.rpc.workspace.get()
  expect(doc.desktops[0]?.windows.map((w) => [w.id, w.openedBy])).toEqual([
    ['mine', 'person'],
    [expect.any(String), 'keith'],
  ])
  const prompts = JSON.stringify(front.models.get('f')?.prompts ?? [])
  // the TUI draws no workspace: no screen line, no delivery, and the tool says so
  expect(prompts).not.toContain('On screen now')
  expect(prompts).toContain('no-screen')
  expect(prompts).toContain('ask-first')
  const events = (await r.client.harness.activity.page({ after: 0, limit: 500 })).events
  expect(events.some((e) => e.type === 'brain.parietal.deliver')).toBe(false)
  expect(
    events
      .filter((e) => e.type === 'brain.parietal.workspace')
      .map(
        (e) => `${(e.payload as { action: string }).action}:${(e.payload as { ok: boolean }).ok}`,
      )
      .sort(),
  ).toEqual(['close:false', 'open:true'])
})
