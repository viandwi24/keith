import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { MEMBER } from './testing/fake-core.ts'
import { frameUntil, pressUntil, typeLine } from './testing/ink.ts'
import { DOWN, ESC, ORDER, openSection } from './testing/manage-helpers.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const MEMBER_ORDER = [
  'Overview',
  'Protocols',
  'Nodes',
  'Providers & models',
  'Budget',
  'Logs',
  'Privacy',
]

const OWNER_SECTIONS = [
  'Overview',
  'People',
  'Groups',
  'Devices & tokens',
  'Nodes',
  'Providers & models',
  'Access',
  'Budget',
  'Logs',
  'Privacy',
  'Audit',
]

describe('the Manage screen by role', () => {
  test('the owner sees every section in the list at 120 columns, and the overview facts', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({ admin, start: 'manage', columns: 120 })
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('people    3'))
    for (const title of OWNER_SECTIONS) expect(frame).toContain(title)
    expect(frame).toContain('Manage')
    expect(frame).toContain('devices   1 login(s) wait for approval')
    expect(frame).toContain('[↑↓] section')
    app.unmount()
  })

  test('a member sees only what the capability table gives: overview, nodes, models, budget, privacy', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({
      admin,
      start: 'manage',
      columns: 120,
      whoami: MEMBER,
      budget: { scope: 'person:ana-id', limitUsd: 5, spentUsd: 1.5 },
    })
    const frame = await frameUntil(
      app.lastFrame,
      (f) => f.includes('Overview') && f.includes('Ana'),
    )
    for (const title of [
      'Overview',
      'Protocols',
      'Nodes',
      'Providers & models',
      'Budget',
      'Logs',
      'Privacy',
    ])
      expect(frame).toContain(title)
    for (const title of ['People', 'Groups', 'Devices & tokens', 'Access', 'Audit'])
      expect(frame).not.toContain(title)
    expect(frame).toContain('╭─ Manage ─╮')
    expect(frame).toContain('╰─ member ─')
    // no call the member may not make was issued
    // two admin calls are open to every signed-in person: the first-login notice check (P23.2.5) and the heir's
    // view of the succession (P29.3.5: a member who is not the heir gets NOT_FOUND, so it says nothing about whether a succession is set); nothing else
    expect(
      app.core.seen.filter(
        (l) =>
          l.includes('/rpc/admin/') &&
          !l.includes('/rpc/admin/audit/notice/') &&
          !l.includes('/rpc/admin/succession/get'),
      ),
    ).toEqual([])
    app.unmount()
  })

  test('a member gets no actions: the models are read only', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({
      admin,
      start: 'manage',
      columns: 120,
      whoami: MEMBER,
      budget: { scope: 'person:ana-id', limitUsd: 5, spentUsd: 1.5 },
    })
    await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
    const frame = await openSection(app, 'Providers & models', MEMBER_ORDER)
    expect(frame).toContain('front')
    expect(frame).not.toContain('Add a connection')
    // reads only: nothing of the admin API was called
    expect(admin.calls.filter((c) => c.name.startsWith('admin/'))).toEqual([])
    app.unmount()
  })

  test('the budget section shows the limit, every person and a cap action for the owner', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({
      admin,
      start: 'manage',
      columns: 120,
      budget: { people: admin.budgetPeople },
    })
    await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
    const frame = await openSection(app, 'Budget')
    expect(frame).toContain('this month: $0.00 spent, limit $20.00')
    expect(frame).toContain('ana')
    expect(frame).toContain('no cap')
    app.unmount()
  })

  test('the audit section lists events, read only', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({ admin, start: 'manage', columns: 120 })
    await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
    const frame = await openSection(app, 'Audit')
    expect(frame).toContain('people.add')
    expect(frame).toContain('2026-10-28 09:41:00')
    expect(admin.inputs('admin/audit/list')).toEqual([{ limit: 100 }])
    app.unmount()
  })
})

describe('the Privacy section', () => {
  const memberApp = async (admin: ReturnType<typeof createFakeAdmin>) =>
    setupApp({
      admin,
      start: 'manage',
      columns: 120,
      whoami: MEMBER,
      budget: { scope: 'person:ana-id', limitUsd: 5, spentUsd: 1.5 },
    })

  test('a member reads who looked at their things: when, who, what; no address, no listener', async () => {
    const admin = createFakeAdmin()
    const app = await memberApp(admin)
    await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
    const frame = await openSection(app, 'Privacy', MEMBER_ORDER)
    expect(frame).toContain('WHEN (UTC)')
    expect(frame).toContain('Vian')
    expect(frame).toContain('looked at 3 of your notes')
    expect(frame).toContain('2026-10-28 09:41:00')
    expect(admin.inputs('admin/audit/mine')).toEqual([{ limit: 100 }])
    // the whole log is the owner's: the member never asked for it
    expect(admin.calls.some((c) => c.name === 'admin/audit/list')).toBe(false)
    app.unmount()
  })

  test('with nothing to show the panel says so', async () => {
    const admin = createFakeAdmin()
    admin.mine.length = 0
    const app = await memberApp(admin)
    await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
    const frame = await openSection(app, 'Privacy', MEMBER_ORDER)
    expect(frame).toContain('Nobody looked at your things.')
    app.unmount()
  })
})

describe('layout', () => {
  test('under 100 columns there is one pane and a switcher; tab goes to the next section', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({ admin, start: 'manage', columns: 80, rows: 30 })
    const first = await frameUntil(app.lastFrame, (f) => f.includes('people    3'))
    expect(first).toContain('╭─ Overview ─')
    expect(first).toContain(`1/${ORDER.length} ─╮`)
    expect(first).toContain('[tab] next section')
    expect(first).not.toContain('Providers & models')
    await pressUntil(app.stdin, app.lastFrame, '\t', (f) => f.includes('╭─ People ─'))
    // the switcher moves before the section's rows load: wait for them
    expect(await frameUntil(app.lastFrame, (f) => f.includes('USERNAME'))).toContain('USERNAME')
    app.unmount()
  })

  test('two panes: down moves the section list, enter hands the keys to the rows, tab hands them back', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({ admin, start: 'manage', columns: 100 })
    await frameUntil(app.lastFrame, (f) => f.includes('▸ Overview'))
    await pressUntil(app.stdin, app.lastFrame, DOWN, (f) => f.includes('▸ People'))
    const rows = await pressUntil(app.stdin, app.lastFrame, '\r', (f) =>
      f.includes('[enter] actions'),
    )
    expect(rows).toContain('▸ People')
    await frameUntil(app.lastFrame, (f) => f.includes('suspended'))
    await pressUntil(app.stdin, app.lastFrame, '\t', (f) => f.includes('▸ People'))
    app.unmount()
  })

  test('? shows the key help', async () => {
    const app = await setupApp({ admin: createFakeAdmin(), start: 'manage', columns: 120 })
    await frameUntil(app.lastFrame, (f) => f.includes('Overview'))
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('[enter] actions'))
    const frame = await pressUntil(app.stdin, app.lastFrame, '?', (f) =>
      f.includes('enter lists what you can do'),
    )
    expect(frame).toContain('esc goes back')
    expect(frame).toContain('[?] help')
    app.unmount()
  })
})

describe('entry from the chat', () => {
  test('/manage opens the screen and esc returns to the chat', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({ admin, columns: 120 })
    await typeLine(app.stdin, '/manage')
    await frameUntil(app.lastFrame, (f) => f.includes('Manage') && f.includes('▸ Overview'))
    await pressUntil(app.stdin, app.lastFrame, ESC, (f) => f.includes('type a message'))
    app.unmount()
  })

  test('/manage is offered by the slash hints and the help', async () => {
    const app = await setupApp({ columns: 120 })
    await pressUntil(app.stdin, app.lastFrame, '/', (f) => f.includes('/manage'))
    await typeLine(app.stdin, 'help')
    const help = await frameUntil(app.lastFrame, (f) => f.includes('Help'))
    expect(help).toContain('/manage')
    app.unmount()
  })
})
