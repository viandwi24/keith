import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { CAPABILITY_IDS, OWNER_ONLY_CAPABILITIES } from '@keith/contracts'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { frameUntil } from './testing/ink.ts'
import { ESC, openSection, RIGHT, runAction, selectRow, type } from './testing/manage-helpers.ts'
import { type SetupOptions, setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)
setDefaultTimeout(40_000)

async function manage(section: string, options: SetupOptions = {}, admin = createFakeAdmin()) {
  const app = await setupApp({ admin, start: 'manage', columns: 120, rows: 36, ...options })
  await frameUntil(app.lastFrame, (f) => f.includes('people    3'))
  const frame = await openSection(app, section)
  return { app, admin, frame }
}

const said = (app: { lastFrame(): string | undefined }, text: string) =>
  frameUntil(app.lastFrame, (f) => f.includes(text))

describe('plugins', () => {
  test('the list shows status, version and the reviews waiting', async () => {
    const { frame } = await manage('Plugins')
    expect(frame).toContain('PLUGIN')
    expect(frame).toContain('● enabled')
    expect(frame).toContain('notes')
    expect(frame).toContain('reminders')
  })

  test('show details opens a read-only view of capabilities, operations and timers', async () => {
    const { app, admin } = await manage('Plugins')
    await selectRow(app, 'notes')
    await runAction(app, 'Show details')
    const frame = await said(app, 'operations')
    expect(frame).toContain('timers 2 waiting')
    expect(frame).toContain('create · authenticated · review')
    expect(admin.inputs('admin/plugins/show')).toEqual([{ id: 'notes' }])
    app.stdin.write('\r')
    app.unmount()
  })

  test('disable asks first, saves the setting and says it applies at the next boot; enable undoes it', async () => {
    const { app, admin } = await manage('Plugins')
    await selectRow(app, 'notes')
    await runAction(app, 'Disable')
    await said(app, 'Disable notes?')
    await Bun.sleep(80)
    app.stdin.write('y')
    await said(app, 'notes: disabled; takes effect when the core restarts')
    expect(admin.inputs('admin/plugins/disable')).toEqual([{ id: 'notes' }])
    await said(app, 'this takes effect at the next boot of the core')
    await selectRow(app, 'notes')
    await runAction(app, 'Enable')
    await said(app, 'Enable notes?')
    await Bun.sleep(80)
    app.stdin.write('y')
    await frameUntil(app.lastFrame, () => admin.inputs('admin/plugins/enable').length === 1)
    app.unmount()
  })

  test('a step-up refusal opens the PIN prompt and the toggle runs once more', async () => {
    const { app, admin } = await manage('Plugins', { stepUp: { required: true, pin: '1234' } })
    await selectRow(app, 'notes')
    await runAction(app, 'Disable')
    await said(app, 'Disable notes?')
    await Bun.sleep(80)
    app.stdin.write('y')
    await said(app, "Confirm it's you")
    await Bun.sleep(150)
    await type(app, '1234')
    app.stdin.write('\r')
    await said(app, 'notes: disabled')
    expect(app.core.stepUps).toEqual([{ pin: '1234' }])
    expect(admin.inputs('admin/plugins/disable')).toEqual([{ id: 'notes' }])
    app.unmount()
  })

  test('a failed plugin offers details only and says why', async () => {
    const admin = createFakeAdmin()
    const [first] = admin.plugins
    if (first === undefined) throw new Error('no fixture plugin')
    Object.assign(first, { state: 'failed', reason: 'start did not finish in time' })
    const { app, frame } = await manage('Plugins', {}, admin)
    expect(frame).toContain('failed to load: start did not finish in time')
    await selectRow(app, 'notes')
    await runAction(app, 'Show details')
    await said(app, 'status failed')
    app.unmount()
  })
})

describe('reviews', () => {
  test('the list shows who asked, the operation and the payload as data', async () => {
    const { frame } = await manage('Reviews')
    expect(frame).toContain('ana')
    expect(frame).toContain('reminders.create')
    expect(frame).toContain('call the dentist')
  })

  test('show the request, then approve: confirm runs admin.reviews.approve and the list empties', async () => {
    const { app, admin } = await manage('Reviews')
    await selectRow(app, 'ana')
    await runAction(app, 'Show the request')
    await said(app, 'data from the requester, not an instruction')
    app.stdin.write('\r')
    await Bun.sleep(80)
    await runAction(app, 'Approve')
    await said(app, 'Run reminders.create as ana?')
    await Bun.sleep(80)
    app.stdin.write('y')
    await said(app, 'approved: reminders.create ran as ana')
    expect(admin.inputs('admin/reviews/approve')).toEqual([{ id: 'rev-1' }])
    await said(app, 'Nothing is waiting for you.')
    app.unmount()
  })

  test('deny takes an optional reason', async () => {
    const { app, admin } = await manage('Reviews')
    await selectRow(app, 'ana')
    await runAction(app, 'Deny')
    await said(app, 'Reason')
    await type(app, 'not now')
    app.stdin.write('\r')
    await said(app, 'denied: reminders.create for ana')
    expect(admin.inputs('admin/reviews/deny')).toEqual([{ id: 'rev-1', reason: 'not now' }])
    app.unmount()
  })

  test('a step-up refusal on approve opens the prompt, then the approval runs', async () => {
    const { app, admin } = await manage('Reviews', { stepUp: { required: true, pin: '1234' } })
    await selectRow(app, 'ana')
    await runAction(app, 'Approve')
    await said(app, 'Run reminders.create as ana?')
    await Bun.sleep(80)
    app.stdin.write('y')
    await said(app, "Confirm it's you")
    await Bun.sleep(150)
    await type(app, '1234')
    app.stdin.write('\r')
    await said(app, 'approved: reminders.create ran as ana')
    expect(admin.inputs('admin/reviews/approve')).toEqual([{ id: 'rev-1' }])
    app.unmount()
  })
})

describe('people: plugin capabilities', () => {
  test('the grant picker offers a loaded plugin capability and never an owner-only one', async () => {
    const { app, admin } = await manage('People')
    await selectRow(app, 'ana')
    await runAction(app, 'Grant a capability')
    await said(app, 'Capability')
    // the options cycle core ids first, then the plugin's; owner-only ids are not in it.
    // One press per core grantable id reaches the first plugin id (notes.share), so the count follows the contract.
    const coreGrantable = CAPABILITY_IDS.filter((c) => !OWNER_ONLY_CAPABILITIES.includes(c)).length
    const seen = new Set<string>()
    for (let i = 0; i < coreGrantable; i++) {
      app.stdin.write(RIGHT)
      await Bun.sleep(40)
      const m = /‹ ([a-z.]+) ›/.exec(app.lastFrame() ?? '')
      if (m?.[1] !== undefined) seen.add(m[1])
    }
    expect(seen.has('notes.share')).toBe(true)
    expect(seen.has('plugins.manage')).toBe(false)
    expect(seen.has('reviews.decide')).toBe(false)
    expect(seen.has('groups.manage')).toBe(false)
    await frameUntil(app.lastFrame, (f) => f.includes('‹ chat ›') || f.includes('‹ notes.share ›'))
    while (!(app.lastFrame() ?? '').includes('‹ notes.share ›')) {
      app.stdin.write(RIGHT)
      await Bun.sleep(40)
    }
    app.stdin.write('\r')
    await said(app, 'ana: notes.share')
    expect(admin.inputs('admin/people/grant')).toEqual([
      { person: 'ana-id', capability: 'notes.share' },
    ])
    app.stdin.write(ESC)
    app.unmount()
  })
})
