import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cells } from '@keith/ui'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { MEMBER } from './testing/fake-core.ts'
import { createFakeProtocols } from './testing/fake-protocols.ts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { ORDER, openSection, RIGHT, runAction, selectRow, type } from './testing/manage-helpers.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)
setDefaultTimeout(40_000)

const MEMBER_ORDER = [
  'Overview',
  'Protocols',
  'Nodes',
  'Providers & models',
  'Budget',
  'Logs',
  'Privacy',
]

/** The Manage screen on a fake core with the protocol tables, `Protocols` open. */
async function protocols(
  options: { member?: boolean; columns?: number; waitingAsk?: boolean | 'closed' } = {},
) {
  const fake = createFakeProtocols({
    owner: options.member !== true,
    waitingAsk: options.waitingAsk ?? false,
  })
  const admin = createFakeAdmin()
  const app = await setupApp({
    admin,
    rpc: fake.rpc,
    start: 'manage',
    columns: options.columns ?? 120,
    rows: 36,
    ...(options.member === true ? { whoami: MEMBER } : {}),
  })
  await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
  const order = options.member === true ? MEMBER_ORDER : ORDER
  if ((options.columns ?? 120) < 100) {
    // one pane: right moves to the next section, and the content has the keys
    for (let i = 0; i < order.indexOf('Protocols'); i++)
      await pressUntil(app.stdin, app.lastFrame, RIGHT, (f) => f.includes(`╭─ ${order[i + 1]} ─`))
    await frameUntil(app.lastFrame, (f) => f.includes('╭─ Protocols ─'))
    return { app, fake }
  }
  await openSection(app, 'Protocols', order)
  return { app, fake }
}

describe('Apps > Protocols', () => {
  test('a member sees their own protocols and proposals, state and last run; no owner column', async () => {
    const { app } = await protocols({ member: true })
    const frame = await frameUntil(
      app.lastFrame,
      (f) => f.includes('Call Bo back') && f.includes('Water'),
    )
    expect(frame).toContain('╭─ Protocols ─')
    expect(frame).toContain('! proposed')
    expect(frame).toContain('paused until')
    expect(frame).toContain('● on')
    expect(frame).toContain('done 11-10')
    expect(frame).not.toContain('OWNER')
    expect(frame).not.toContain('approval-stale')
    app.unmount()
  })

  test('the owner also sees keith-owned protocols, with an owner column', async () => {
    const { app } = await protocols()
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('approval-stale'))
    expect(frame).toContain('OWNER')
    expect(frame).toContain('keith')
    app.unmount()
  })

  test('every line fits the pane at 80 and 120 columns', async () => {
    for (const columns of [80, 120]) {
      const { app } = await protocols({ columns })
      const frame = await frameUntil(app.lastFrame, (f) => f.includes('Call Bo back'))
      for (const line of frame.split('\n')) expect(cells(line)).toBeLessThanOrEqual(columns)
      app.unmount()
    }
  })

  test('n opens the reminder form; a time and a text save a time protocol with the ladder', async () => {
    const { app, fake } = await protocols()
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Remind me to'))
    await type(app, 'Stretch')
    app.stdin.write('\r')
    await Bun.sleep(60)
    await type(app, '18:30')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, () => fake.inputs('protocols/save').length === 1)
    const [input] = fake.inputs('protocols/save') as {
      name: string
      definition: { trigger: { kind: string }; steps: { kind: string }[] }
    }[]
    expect(input?.name).toBe('Stretch')
    expect(input?.definition.trigger.kind).toBe('time')
    expect(input?.definition.steps.map((s) => s.kind)).toEqual(['notify', 'wait', 'notify'])
    await frameUntil(app.lastFrame, (f) => f.includes('reminder set for'))
    app.unmount()
  })

  test.each([80, 120])(
    'a run waiting on a question shows asks: and Answer sends the chosen option (%i columns)',
    async (columns) => {
      const { app, fake } = await protocols({ columns, waitingAsk: true })
      const frame = await frameUntil(app.lastFrame, (f) =>
        f.includes('asks: Water the plants today?'),
      )
      expect(frame).toContain('asks: Water the plants today?')
      await selectRow(app, 'Ask about')
      await runAction(app, 'Answer')
      await frameUntil(app.lastFrame, (f) => f.includes('[←→] choose'))
      app.stdin.write(RIGHT) // yes -> later
      await Bun.sleep(40)
      app.stdin.write('\r')
      await frameUntil(app.lastFrame, () => fake.inputs('protocols/answer').length === 1)
      expect(fake.inputs('protocols/answer')[0]).toEqual({ runId: 'run-7', option: 'later' })
      await frameUntil(app.lastFrame, (f) => f.includes('Ask about water: answered'))
      app.unmount()
    },
  )

  test('a question the core closed says question closed and the row keeps no answer', async () => {
    // the core lists the run as waiting, but its question is closed: the answer is CONFLICT
    const { app, fake } = await protocols({ waitingAsk: 'closed' })
    await frameUntil(app.lastFrame, (f) => f.includes('asks: Water the plants today?'))
    await selectRow(app, 'Ask about')
    await runAction(app, 'Answer')
    await frameUntil(app.lastFrame, (f) => f.includes('[←→] choose'))
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('question closed'))
    expect(fake.inputs('protocols/answer')).toEqual([{ runId: 'run-closed', option: 'yes' }])
    app.unmount()
  })

  test('pause asks for hours and sends an until; a paused row resumes with until null', async () => {
    const { app, fake } = await protocols()
    await selectRow(app, 'Call Bo back')
    await runAction(app, 'Pause')
    await frameUntil(app.lastFrame, (f) => f.includes('Hours'))
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, () => fake.inputs('protocols/pause').length === 1)
    const [paused] = fake.inputs('protocols/pause') as { id: string; until: number }[]
    expect(paused?.id).toBe('p-call')
    expect(typeof paused?.until).toBe('number')
    await selectRow(app, 'Water the plants')
    await runAction(app, 'Resume')
    await frameUntil(app.lastFrame, () => fake.inputs('protocols/pause').length === 2)
    expect(fake.inputs('protocols/pause')[1]).toEqual({ id: 'p-water', until: null })
    app.unmount()
  })

  test('delete asks first: n cancels, y calls protocols.delete', async () => {
    const { app, fake } = await protocols()
    await selectRow(app, 'Call Bo back')
    await runAction(app, 'Delete')
    await frameUntil(app.lastFrame, (f) => f.includes('cannot be undone'))
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => !f.includes('cannot be undone'))
    expect(fake.inputs('protocols/delete')).toEqual([])
    await selectRow(app, 'Call Bo back')
    await runAction(app, 'Delete')
    await frameUntil(app.lastFrame, (f) => f.includes('[y] confirm'))
    app.stdin.write('y')
    await frameUntil(app.lastFrame, () => fake.inputs('protocols/delete').length === 1)
    expect(fake.inputs('protocols/delete')).toEqual([{ id: 'p-call' }])
    app.unmount()
  })

  test('a pending proposal is confirmed as a protocol', async () => {
    const { app, fake } = await protocols({ member: true })
    await selectRow(app, 'Stretch every')
    await runAction(app, 'Confirm')
    await frameUntil(app.lastFrame, () => fake.inputs('protocols/confirm').length === 1)
    expect(fake.inputs('protocols/confirm')).toEqual([{ id: 'prop-1' }])
    app.unmount()
  })
})
