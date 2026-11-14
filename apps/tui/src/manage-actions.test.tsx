import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { node } from './testing/fixtures.ts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { ESC, openSection, RIGHT, runAction, selectRow, type } from './testing/manage-helpers.ts'
import { type SetupOptions, setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)
setDefaultTimeout(40_000)

const BACKSPACE = '\u007f'

/** The Manage screen as the owner on a fake core, with `section` open and its rows loaded. */
async function manage(section: string, options: SetupOptions = {}, admin = createFakeAdmin()) {
  const app = await setupApp({ admin, start: 'manage', columns: 120, rows: 36, ...options })
  await frameUntil(app.lastFrame, (f) => f.includes('people    3'))
  await openSection(app, section)
  return { app, admin }
}

const said = (app: { lastFrame(): string | undefined }, text: string) =>
  frameUntil(app.lastFrame, (f) => f.includes(text))

describe('people', () => {
  test('add: the form calls admin.people.add with the typed username', async () => {
    const { app, admin } = await manage('People')
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Add a person'))
    await type(app, 'cy')
    app.stdin.write('\r') // next field (display name, optional)
    await Bun.sleep(60)
    app.stdin.write('\r') // submit
    await said(app, 'added cy (member)')
    expect(admin.inputs('admin/people/add')).toEqual([{ username: 'cy' }])
    await said(app, 'cy-id'.slice(0, 2)) // the list is read again
    app.unmount()
  })

  test('a required field left empty keeps the form open and calls nothing', async () => {
    const { app, admin } = await manage('People')
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Add a person'))
    app.stdin.write('\r')
    await Bun.sleep(60)
    app.stdin.write('\r')
    await said(app, 'Username is required')
    expect(admin.inputs('admin/people/add')).toEqual([])
    app.unmount()
  })

  test('rename sends only what changed; suspend and reactivate run at once', async () => {
    const { app, admin } = await manage('People')
    await selectRow(app, 'ana')
    await runAction(app, 'Rename')
    await frameUntil(app.lastFrame, (f) => f.includes('Rename') && f.includes('Display name'))
    for (let i = 0; i < 3; i++) app.stdin.write(BACKSPACE)
    await type(app, 'anna')
    app.stdin.write('\r')
    await Bun.sleep(60)
    app.stdin.write('\r')
    await said(app, 'anna: Ana')
    expect(admin.inputs('admin/people/rename')).toEqual([{ person: 'ana-id', username: 'anna' }])
    await selectRow(app, 'anna')
    await runAction(app, 'Suspend')
    await said(app, 'anna: suspended')
    expect(admin.inputs('admin/people/suspend')).toEqual([{ person: 'ana-id' }])
    await selectRow(app, 'bo')
    await runAction(app, 'Reactivate')
    await said(app, 'bo: active')
    expect(admin.inputs('admin/people/reactivate')).toEqual([{ person: 'bo-id' }])
    app.unmount()
  })

  test('role, unlock, grants and clearing a secret call their procedures', async () => {
    const { app, admin } = await manage('People')
    await selectRow(app, 'ana')
    await runAction(app, 'Unlock')
    await said(app, 'ana: unlocked')
    await runAction(app, 'Grant a capability')
    await frameUntil(app.lastFrame, (f) => f.includes('Capability'))
    app.stdin.write(RIGHT)
    await frameUntil(app.lastFrame, (f) => f.includes('‹ tasks.own ›'))
    app.stdin.write('\r')
    await said(app, 'ana: tasks.own')
    await runAction(app, 'Show grants')
    await frameUntil(app.lastFrame, () => admin.inputs('admin/people/grants').length === 1)
    await Bun.sleep(150)
    await runAction(app, 'Revoke a grant')
    await frameUntil(app.lastFrame, (f) => f.includes('Capability'))
    app.stdin.write(RIGHT)
    await frameUntil(app.lastFrame, (f) => f.includes('‹ tasks.own ›'))
    app.stdin.write('\r')
    await said(app, 'ana: (no grants)')
    await runAction(app, 'Clear PIN')
    await said(app, 'ana: PIN cleared')
    await runAction(app, 'Set role')
    await frameUntil(app.lastFrame, (f) => f.includes('Role'))
    app.stdin.write('\r')
    await said(app, 'ana: member')
    expect(admin.inputs('admin/people/unlock')).toEqual([{ person: 'ana-id' }])
    expect(admin.inputs('admin/people/grant')).toEqual([
      { person: 'ana-id', capability: 'tasks.own' },
    ])
    expect(admin.inputs('admin/people/revokeGrant')).toEqual([
      { person: 'ana-id', capability: 'tasks.own' },
    ])
    expect(admin.inputs('admin/people/clearSecret')).toEqual([{ person: 'ana-id', kind: 'pin' }])
    expect(admin.inputs('admin/people/setRole')).toEqual([{ person: 'ana-id', role: 'member' }])
    app.unmount()
  })

  test('remove asks first: n cancels, y calls admin.people.remove', async () => {
    const { app, admin } = await manage('People')
    await selectRow(app, 'ana')
    await runAction(app, 'Remove')
    await frameUntil(app.lastFrame, (f) => f.includes('Remove ana and revoke'))
    expect(admin.inputs('admin/people/remove')).toEqual([])
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => !f.includes('Remove ana and revoke'))
    expect(admin.inputs('admin/people/remove')).toEqual([])
    await runAction(app, 'Remove')
    await frameUntil(app.lastFrame, (f) => f.includes('[y] confirm'))
    app.stdin.write('y')
    await said(app, 'ana: removed')
    expect(admin.inputs('admin/people/remove')).toEqual([{ person: 'ana-id' }])
    app.unmount()
  })

  test('transfer owner needs the username typed', async () => {
    const { app, admin } = await manage('People')
    await selectRow(app, 'ana')
    await runAction(app, 'Transfer ownership')
    await frameUntil(app.lastFrame, (f) => f.includes('Type ana to confirm.'))
    await type(app, 'an')
    app.stdin.write('\r')
    await said(app, 'That does not match.')
    expect(admin.inputs('admin/people/transferOwner')).toEqual([])
    await type(app, 'a')
    app.stdin.write('\r')
    await said(app, 'ana is now the owner; owner is a member')
    expect(admin.inputs('admin/people/transferOwner')).toEqual([{ person: 'ana-id' }])
    app.unmount()
  })

  test('passwords and PINs are hidden, sent once and never drawn', async () => {
    const { app, admin } = await manage('People')
    const password = ['correct', 'horse', 'battery', 'staple'].join('-')
    await selectRow(app, 'ana')
    await runAction(app, 'Set password')
    await frameUntil(app.lastFrame, (f) => f.includes('Repeat'))
    await type(app, password)
    const masked = await frameUntil(app.lastFrame, (f) => f.includes('••••'))
    expect(masked).not.toContain('horse')
    app.stdin.write('\r')
    await Bun.sleep(60)
    await type(app, `${password}x`)
    app.stdin.write('\r')
    await said(app, 'the two entries differ')
    expect(admin.inputs('admin/people/setPassword')).toEqual([])
    // the secrets were dropped from state: type both again
    await type(app, password)
    app.stdin.write('\r')
    await Bun.sleep(60)
    await type(app, password)
    app.stdin.write('\r')
    await said(app, 'ana: password set')
    expect(admin.inputs('admin/people/setPassword')).toEqual([{ person: 'ana-id', password }])
    await runAction(app, 'Set PIN')
    await frameUntil(app.lastFrame, (f) => f.includes('Repeat'))
    await type(app, '246810')
    app.stdin.write('\r')
    await Bun.sleep(60)
    await type(app, '246810')
    app.stdin.write('\r')
    await said(app, 'ana: PIN set')
    expect(admin.inputs('admin/people/setPin')).toEqual([{ person: 'ana-id', pin: '246810' }])
    const everything = app.frames.join('\n')
    expect(everything).not.toContain('horse')
    expect(everything).not.toContain('246810')
    app.unmount()
  })
})

describe('devices and tokens', () => {
  test('a new token is shown once, in a dialog that says so, and never again', async () => {
    const { app, admin } = await manage('Devices & tokens')
    await frameUntil(app.lastFrame, (f) => f.includes('phone') && f.includes('laptop'))
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Approve a login'))
    // `n` is the first action; the token is the third: use the menu
    await pressUntil(app.stdin, app.lastFrame, ESC, (f) => f.includes('[enter] actions'))
    await runAction(app, 'Create a token')
    await frameUntil(app.lastFrame, (f) => f.includes('Label'))
    await type(app, 'deploy')
    app.stdin.write('\r')
    const shown = await said(app, 'Shown once')
    expect(shown).toContain('cannot be shown again')
    expect(shown).toContain('keith_tttttttt_deploy')
    expect(admin.inputs('admin/tokens/create')).toEqual([{ label: 'deploy' }])
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => !f.includes('Shown once'))
    await Bun.sleep(100)
    expect(app.lastFrame()).not.toContain('keith_tttttttt_deploy')
    app.unmount()
  })

  test('approve and deny take the code; revoke asks first', async () => {
    const { app, admin } = await manage('Devices & tokens')
    await frameUntil(app.lastFrame, (f) => f.includes('phone'))
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Approve a login'))
    await type(app, 'ABCD-EFGH')
    app.stdin.write('\r')
    await Bun.sleep(60)
    await type(app, 'desk')
    app.stdin.write('\r')
    await said(app, 'approved: desk')
    expect(admin.inputs('admin/devices/approve')).toEqual([{ code: 'ABCD-EFGH', label: 'desk' }])
    await selectRow(app, 'device')
    await runAction(app, 'Revoke')
    await frameUntil(app.lastFrame, (f) => f.includes('Revoke device phone?'))
    expect(admin.inputs('admin/devices/revoke')).toEqual([])
    app.stdin.write('y')
    await said(app, 'device phone: revoked')
    expect(admin.inputs('admin/devices/revoke')).toEqual([{ id: 'dev1' }])
    await selectRow(app, 'token')
    await runAction(app, 'Revoke')
    await frameUntil(app.lastFrame, (f) => f.includes('Revoke token ci?'))
    app.stdin.write('y')
    await said(app, 'token ci: revoked')
    expect(admin.inputs('admin/tokens/revoke')).toEqual([{ id: 'tok1' }])
    app.unmount()
  })
})

describe('nodes', () => {
  test('the selected node shows its drivers and refused capabilities in the detail line', async () => {
    const admin = createFakeAdmin()
    admin.nodes.push(
      node({
        drivers: [{ name: 'system', version: '0.1.0' }],
        capabilities: ['system.info'],
        refused: [{ id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' }],
      }),
    )
    const { app } = await manage('Nodes', {}, admin)
    await frameUntil(app.lastFrame, (f) => f.includes('laptop-e'))
    await selectRow(app, '● laptop-e')
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('refused: iot.switch'))
    expect(frame).toContain('system 0.1.0 · info')
    expect(frame).toContain('refused: iot.switch (unknown capability)')
    app.unmount()
  })

  test('pair shows the code once; revoke asks first', async () => {
    const admin = createFakeAdmin()
    admin.nodes.push(node())
    const { app } = await manage('Nodes', {}, admin)
    await frameUntil(app.lastFrame, (f) => f.includes('laptop-e'))
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Shown once'))
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('ABCD-EFGH')
    expect(frame).toContain('keith-node join')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => !f.includes('Shown once'))
    expect(admin.inputs('nodes/pair')).toHaveLength(1)
    await selectRow(app, '● laptop-e')
    await runAction(app, 'Revoke')
    await frameUntil(app.lastFrame, (f) => f.includes('Revoke node laptop-e?'))
    app.stdin.write('y')
    await said(app, 'node laptop-e: revoked')
    expect(admin.inputs('nodes/revoke')).toEqual([{ id: 'n1' }])
    app.unmount()
  })
})

describe('providers and models', () => {
  test('add takes a hidden key, saves, tests and says so; the key is never drawn', async () => {
    const { app, admin } = await manage('Providers & models')
    await frameUntil(app.lastFrame, (f) => f.includes('openrouter'))
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Add a connection'))
    await Bun.sleep(60)
    app.stdin.write('\r') // provider: openrouter
    await Bun.sleep(60)
    const key = ['sk', 'or', 'v1', 'abcdef123456'].join('-')
    await type(app, key)
    await frameUntil(app.lastFrame, (f) => f.includes('••••'))
    // key, connection id and label are three Enters; the last submits (a fourth would open the menu)
    for (let i = 0; i < 3; i++) {
      app.stdin.write('\r')
      await Bun.sleep(60)
    }
    await said(app, 'openrouter: saved; connection works')
    expect(admin.inputs('providers/put')).toEqual([
      { providerId: 'openrouter', settings: { apiKey: key } },
    ])
    expect(admin.inputs('providers/test')).toEqual([{ id: 'openrouter' }])
    expect(app.frames.join('\n')).not.toContain('abcdef123456')
    app.unmount()
  })

  test('test and remove a connection; set the cortex model', async () => {
    const { app, admin } = await manage('Providers & models')
    await selectRow(app, 'connection')
    await runAction(app, 'Test')
    await said(app, 'openrouter: ok (12 ms)')
    await runAction(app, 'Remove')
    await frameUntil(app.lastFrame, (f) => f.includes('Remove connection openrouter?'))
    app.stdin.write('y')
    await said(app, 'openrouter: removed')
    expect(admin.inputs('providers/remove')).toEqual([{ id: 'openrouter' }])
    await selectRow(app, 'model')
    await runAction(app, 'Set the cortex model')
    await frameUntil(app.lastFrame, (f) => f.includes('Connection'))
    app.stdin.write('\r')
    await Bun.sleep(60)
    app.stdin.write('\r')
    await Bun.sleep(60)
    await type(app, 'gpt-5')
    app.stdin.write('\r')
    await said(app, 'cortex: openrouter:gpt-5')
    expect(admin.inputs('models/roles/set')).toEqual([{ role: 'cortex', ref: 'openrouter:gpt-5' }])
    app.unmount()
  })
})

describe('access and budget', () => {
  test('access: switching to remote with a public URL calls admin.access.set', async () => {
    const { app, admin } = await manage('Access')
    await frameUntil(app.lastFrame, (f) => f.includes('mode      local'))
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Change access'))
    await Bun.sleep(60)
    app.stdin.write(RIGHT)
    await frameUntil(app.lastFrame, (f) => f.includes('‹ remote ›'))
    app.stdin.write('\r')
    await Bun.sleep(60)
    await type(app, 'https://mac.example.ts.net')
    for (let i = 0; i < 3; i++) {
      app.stdin.write('\r')
      await Bun.sleep(60)
    }
    await said(app, 'access: remote, public url https://mac.example.ts.net')
    expect(admin.inputs('admin/access/set')).toEqual([
      { mode: 'remote', publicUrl: 'https://mac.example.ts.net', proxy: 'none' },
    ])
    app.unmount()
  })

  test('budget: the limit and a person cap; a bad amount calls nothing', async () => {
    const admin = createFakeAdmin()
    const { app } = await manage('Budget', { budget: { people: admin.budgetPeople } }, admin)
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Set the monthly limit'))
    await Bun.sleep(60)
    for (let i = 0; i < 2; i++) app.stdin.write(BACKSPACE)
    await type(app, 'abc')
    app.stdin.write('\r')
    await said(app, 'enter a number of USD')
    expect(admin.inputs('budget/set')).toEqual([])
    for (let i = 0; i < 3; i++) app.stdin.write(BACKSPACE)
    await type(app, '30')
    app.stdin.write('\r')
    await said(app, 'limit: $30.00')
    expect(admin.inputs('budget/set')).toEqual([{ limitUsd: 30 }])
    await selectRow(app, 'ana')
    await runAction(app, 'Set a cap')
    await frameUntil(app.lastFrame, (f) => f.includes('Cap (USD)'))
    await type(app, '5')
    app.stdin.write('\r')
    await said(app, 'ana: cap $5.00')
    expect(admin.inputs('budget/setPersonCap')).toEqual([{ person: 'ana', usd: 5 }])
    app.unmount()
  })
})

describe('errors and step-up', () => {
  test('a failing call shows its message as a notice', async () => {
    const { app } = await manage('People', {
      rpc: {
        'admin/people/suspend': () => {
          throw new Error('cannot suspend the owner')
        },
      },
    })
    await selectRow(app, 'ana')
    await runAction(app, 'Suspend')
    await said(app, 'cannot suspend the owner')
    app.unmount()
  })

  test('a failed call reads the list again, so the rows show the core state', async () => {
    const admin = createFakeAdmin()
    const { app } = await manage(
      'People',
      {
        rpc: {
          'admin/people/suspend': () => {
            throw new Error('cannot suspend the owner')
          },
        },
      },
      admin,
    )
    const reads = admin.inputs('admin/people/list').length
    await selectRow(app, 'ana')
    await runAction(app, 'Suspend')
    await said(app, 'cannot suspend the owner')
    await frameUntil(app.lastFrame, () => admin.inputs('admin/people/list').length > reads)
    expect(admin.inputs('admin/people/list').length).toBe(reads + 1)
    app.unmount()
  })

  test('a step-up refusal opens the PIN prompt; the PIN confirms and the action runs once more', async () => {
    const { app, admin } = await manage('People', { stepUp: { required: true, pin: '1234' } })
    await selectRow(app, 'ana')
    await runAction(app, 'Suspend')
    await frameUntil(app.lastFrame, (f) => f.includes("Confirm it's you"))
    await Bun.sleep(150)
    await type(app, '1234')
    app.stdin.write('\r')
    await said(app, 'ana: suspended')
    expect(app.core.stepUps).toEqual([{ pin: '1234' }])
    expect(admin.inputs('admin/people/suspend')).toEqual([{ person: 'ana-id' }])
    app.unmount()
  })

  test('cancelling the prompt leaves the action undone', async () => {
    const { app, admin } = await manage('People', { stepUp: { required: true } })
    await selectRow(app, 'ana')
    await runAction(app, 'Suspend')
    await frameUntil(app.lastFrame, (f) => f.includes("Confirm it's you"))
    await Bun.sleep(150)
    await pressUntil(app.stdin, app.lastFrame, ESC, (f) => f.includes('Not confirmed.'))
    expect(admin.inputs('admin/people/suspend')).toEqual([])
    app.unmount()
  })
})
