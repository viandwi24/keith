import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cells } from '@keith/ui'
import { clock } from './features/manage/protocols/protocols-state.ts'
import { DAY_MS } from './features/manage/succession/succession-state.ts'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { MEMBER } from './testing/fake-core.ts'
import {
  createFakeSuccession,
  type FakeSuccessionOptions,
  SUCCESSION_NOW,
} from './testing/fake-succession.ts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { ORDER, openSection, RIGHT, runAction, type } from './testing/manage-helpers.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)
setDefaultTimeout(40_000)

/** The Manage screen on a fake core with the succession run, `Succession` open (the owner by default). */
async function succession(
  options: { columns?: number; stepUp?: boolean; run?: FakeSuccessionOptions } = {},
) {
  const columns = options.columns ?? 120
  const fake = createFakeSuccession(options.run)
  const admin = createFakeAdmin()
  const app = await setupApp({
    admin,
    rpc: fake.rpc,
    start: 'manage',
    columns,
    rows: 36,
    ...(options.stepUp === true ? { stepUp: { required: true, pin: '1234' } } : {}),
  })
  await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
  if (columns < 100) {
    // one pane: right moves to the section, and the content has the keys
    for (let i = 0; i < ORDER.indexOf('Succession'); i++)
      await pressUntil(app.stdin, app.lastFrame, RIGHT, (f) => f.includes(`╭─ ${ORDER[i + 1]} ─`))
    await frameUntil(app.lastFrame, (f) => f.includes('╭─ Succession ─'))
  } else await openSection(app, 'Succession', ORDER)
  return { app, admin, fake }
}

describe('Manage > Succession (owner)', () => {
  test('the owner sees the heir, the window, the state, the pause and the last sign', async () => {
    const { app } = await succession()
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('heir      Bo'))
    expect(frame).toContain('╭─ Succession ─')
    expect(frame).toContain('window    14 days')
    expect(frame).toContain('state     idle')
    expect(frame).toContain('pause     none')
    expect(frame).toContain('last sign 3 days ago')
    expect(frame).not.toContain('Resume')
    app.unmount()
  })

  test('every line fits the pane at 80 and 120 columns', async () => {
    for (const columns of [80, 120]) {
      const { app } = await succession({ columns })
      const frame = await frameUntil(app.lastFrame, (f) => f.includes('window    14 days'))
      for (const line of frame.split('\n')) expect(cells(line)).toBeLessThanOrEqual(columns)
      app.unmount()
    }
  })

  test('a run in grace shows its state with the date; Resume ends a pause', async () => {
    const { app, fake } = await succession({
      run: { state: 'grace', pausedUntil: Date.now() + 86_400_000 * 2 },
    })
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('state     grace since'))
    expect(frame).toContain('pause     until')
    await runAction(app, 'Resume')
    await frameUntil(app.lastFrame, () => fake.inputs('admin/succession/resume').length === 1)
    await frameUntil(app.lastFrame, (f) => f.includes('succession resumed'))
    app.unmount()
  })

  test('set the heir offers the members who can sign in and sends the chosen id', async () => {
    const { app, admin, fake } = await succession()
    await runAction(app, 'Set the heir')
    await frameUntil(app.lastFrame, (f) => f.includes('Heir'))
    const eligible = admin.people.find((p) => p.role === 'member' && p.status === 'active')
    expect(eligible).toBeDefined()
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, () => fake.inputs('admin/succession/setHeir').length === 1)
    expect(fake.inputs('admin/succession/setHeir')[0]).toEqual({ person: eligible?.id })
    await frameUntil(app.lastFrame, (f) => f.includes('heir: '))
    app.unmount()
  })

  test('clear the heir asks first: n cancels, y calls clearHeir', async () => {
    const { app, fake } = await succession()
    await runAction(app, 'Clear the heir')
    await frameUntil(app.lastFrame, (f) => f.includes('Clear Bo as the heir?'))
    app.stdin.write('n')
    await Bun.sleep(60)
    expect(fake.inputs('admin/succession/clearHeir')).toEqual([])
    await runAction(app, 'Clear the heir')
    await frameUntil(app.lastFrame, (f) => f.includes('Clear Bo as the heir?'))
    app.stdin.write('y')
    await frameUntil(app.lastFrame, () => fake.inputs('admin/succession/clearHeir').length === 1)
    await frameUntil(app.lastFrame, (f) => f.includes('heir cleared'))
    app.unmount()
  })

  test('pause for a trip asks the step-up first, then sends an until about the days given', async () => {
    const { app, fake } = await succession({ stepUp: true })
    await runAction(app, 'Pause for a trip')
    await frameUntil(app.lastFrame, (f) => f.includes('Days'))
    await type(app, '3')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes("Confirm it's you"))
    await Bun.sleep(150)
    await type(app, '1234')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, () => fake.inputs('admin/succession/pause').length === 1)
    const [paused] = fake.inputs('admin/succession/pause') as { until: number }[]
    const days = ((paused?.until ?? 0) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(2.9)
    expect(days).toBeLessThan(3.1)
    expect(app.core.stepUps).toEqual([{ pin: '1234' }])
    app.unmount()
  })
})

/** The Home screen as a member who is the heir (`start: home`). */
async function asMember(run: FakeSuccessionOptions | undefined, start: 'home' | 'chat' = 'home') {
  const fake = createFakeSuccession(run)
  const app = await setupApp({
    rpc: fake.rpc,
    start,
    whoami: MEMBER,
    columns: 100,
    rows: 34,
  })
  return { app, fake }
}

describe('the heir on Home and /succession', () => {
  test('the heir sees Claim is open as one caption line when the claim is open', async () => {
    const { app } = await asMember({ role: 'heir', state: 'claimable' })
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('Claim is open'))
    expect(frame).not.toContain('╭─ Succession')
    app.unmount()
  })

  test('the heir in grace sees the caption with the day the claim opens; check-in shows none', async () => {
    const grace = await asMember({ role: 'heir', state: 'grace' })
    // the fake core's grace ends 5 days after its fixed clock (SUCCESSION_NOW): the caption names that day
    const opens = clock(SUCCESSION_NOW + 5 * DAY_MS)
    await frameUntil(grace.app.lastFrame, (f) =>
      f.includes(`You can take over this Keith: the claim opens ${opens}`),
    )
    grace.app.unmount()
    const checking = await asMember({ role: 'heir', state: 'check-in' })
    await Bun.sleep(120)
    expect(checking.app.lastFrame()).not.toContain('take over')
    checking.app.unmount()
  })

  test('a member who is neither the heir nor the owner sees no succession line', async () => {
    const { app } = await asMember({ role: 'none', state: 'claimable' })
    await Bun.sleep(120)
    expect(app.lastFrame()).not.toContain('Claim is open')
    app.unmount()
  })

  test('/succession shows the claim, a wrong word says so, the word claims with the step-up and a toast follows', async () => {
    const { app, fake } = await asMember({ role: 'heir', state: 'claimable' }, 'chat')
    await type(app, '/succession')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Claim is open.'))
    await type(app, 'clai')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('type claim, then enter'))
    expect(fake.inputs('admin/succession/claim')).toEqual([])
    await type(app, 'm')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, () => fake.inputs('admin/succession/claim').length === 1)
    // the core revoked both sessions: this device signs out and Home opens signed out with the notice
    await frameUntil(
      app.lastFrame,
      (f) => f.includes('You are the owner now.') && f.includes('Sign in again to continue.'),
    )
    expect(fake.state).toBe('claimed')
    expect(app.lastFrame()).not.toContain('401')
    expect(app.lastFrame()).not.toContain('session ended')
    app.unmount()
  })

  test('a successful claim removes this device login, so the next start asks who', async () => {
    const fake = createFakeSuccession({ role: 'heir', state: 'claimable' })
    const app = await setupApp({
      rpc: fake.rpc,
      start: 'chat',
      whoami: MEMBER,
      columns: 100,
      rows: 34,
      savedLogin: { token: 'keith_s_heir' },
    })
    await type(app, '/succession')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Claim is open.'))
    await type(app, 'claim')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Sign in again to continue.'))
    expect(existsSync(app.configPath)).toBe(false)
    app.unmount()
  })

  test('a claim the core refuses is an error toast and changes nothing', async () => {
    const { app, fake } = await asMember({ role: 'heir', state: 'claimable' }, 'chat')
    await type(app, '/succession')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Claim is open.'))
    fake.state = 'idle'
    await type(app, 'claim')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, () => fake.inputs('admin/succession/claim').length === 1)
    await frameUntil(app.lastFrame, (f) => f.includes('the claim is not open'))
    app.unmount()
  })

  test('two enters in one burst send one claim', async () => {
    const { app, fake } = await asMember({ role: 'heir', state: 'claimable' }, 'chat')
    await type(app, '/succession')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Claim is open.'))
    await type(app, 'claim')
    app.stdin.write('\r')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Sign in again to continue.'))
    await Bun.sleep(100)
    expect(fake.inputs('admin/succession/claim')).toHaveLength(1)
    app.unmount()
  })

  test('a member who is neither the heir nor the owner is told so by /succession', async () => {
    const neither = await asMember({ role: 'none' }, 'chat')
    await type(neither.app, '/succession')
    neither.app.stdin.write('\r')
    await frameUntil(neither.app.lastFrame, (f) =>
      f.includes('You are not the heir of this Keith.'),
    )
    neither.app.unmount()
  })
})
