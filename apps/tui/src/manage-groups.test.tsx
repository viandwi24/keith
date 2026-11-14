import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { openSection, RIGHT, runAction, selectRow, type } from './testing/manage-helpers.ts'
import { type SetupOptions, setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)
setDefaultTimeout(40_000)

async function manage(options: SetupOptions = {}, admin = createFakeAdmin()) {
  const app = await setupApp({ admin, start: 'manage', columns: 120, rows: 36, ...options })
  await frameUntil(app.lastFrame, (f) => f.includes('people    3'))
  const frame = await openSection(app, 'Groups')
  return { app, admin, frame }
}

const said = (app: { lastFrame(): string | undefined }, text: string) =>
  frameUntil(app.lastFrame, (f) => f.includes(text))

describe('groups', () => {
  test('the list has the member count and what uses the group; the legend names n', async () => {
    const { frame } = await manage()
    expect(frame).toContain('GROUP')
    expect(frame).toContain('MEMBERS')
    expect(frame).toContain('family')
    expect(frame).toContain('no members yet')
    expect(frame).toContain('[n] create a group')
  })

  test('create: n opens the form and calls admin.groups.create with the name', async () => {
    const { app, admin } = await manage()
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Create a group'))
    await type(app, 'friends')
    app.stdin.write('\r')
    await said(app, 'group friends created')
    expect(admin.inputs('admin/groups/create')).toEqual([{ name: 'friends' }])
    await said(app, 'friends')
    app.unmount()
  })

  test('add a member: the form picks from the active people; remove takes them out again', async () => {
    const { app, admin } = await manage()
    await selectRow(app, 'family')
    await runAction(app, 'Add a member')
    // owner, ana (bo is suspended and not offered)
    const form = await frameUntil(app.lastFrame, (f) => f.includes('‹ owner ›'))
    expect(form).not.toContain('bo')
    app.stdin.write(RIGHT)
    await frameUntil(app.lastFrame, (f) => f.includes('‹ ana ›'))
    app.stdin.write('\r')
    await said(app, 'ana added to family (1 members)')
    expect(admin.inputs('admin/groups/add')).toEqual([{ group: 'g-fam', person: 'ana' }])
    await said(app, 'members ana')
    await selectRow(app, 'family')
    await runAction(app, 'Remove a member')
    await frameUntil(app.lastFrame, (f) => f.includes('‹ ana ›'))
    app.stdin.write('\r')
    await said(app, 'ana removed from family (0 members)')
    expect(admin.inputs('admin/groups/remove')).toEqual([{ group: 'g-fam', person: 'ana' }])
    app.unmount()
  })

  test('delete asks first; a group in use is refused and the count stays in the dialog', async () => {
    const admin = createFakeAdmin()
    const [group] = admin.groups
    if (group === undefined) throw new Error('no fixture group')
    group.usage = 2
    const { app } = await manage({}, admin)
    await selectRow(app, 'family')
    await runAction(app, 'Delete')
    await frameUntil(app.lastFrame, (f) => f.includes('2 resources use it'))
    await Bun.sleep(80)
    app.stdin.write('y')
    const frame = await said(app, 'family is used by 2 resources')
    expect(frame).toContain('[y] confirm')
    expect(admin.groups).toHaveLength(1)
    app.unmount()
  })

  test('delete of an unused group runs after y', async () => {
    const { app, admin } = await manage()
    await selectRow(app, 'family')
    await runAction(app, 'Delete')
    await frameUntil(app.lastFrame, (f) => f.includes('Delete family?'))
    await Bun.sleep(80)
    app.stdin.write('y')
    await said(app, 'group family deleted')
    expect(admin.inputs('admin/groups/delete')).toEqual([{ group: 'g-fam' }])
    await said(app, 'No groups yet')
    app.unmount()
  })

  test('a step-up refusal opens the PIN prompt and the create runs once more', async () => {
    const { app, admin } = await manage({ stepUp: { required: true, pin: '1234' } })
    await pressUntil(app.stdin, app.lastFrame, 'n', (f) => f.includes('Create a group'))
    await type(app, 'friends')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes("Confirm it's you"))
    await Bun.sleep(150)
    await type(app, '1234')
    app.stdin.write('\r')
    await said(app, 'group friends created')
    expect(app.core.stepUps).toEqual([{ pin: '1234' }])
    expect(admin.inputs('admin/groups/create')).toEqual([{ name: 'friends' }])
    app.unmount()
  })

  test('access shows the audit retention and sets it', async () => {
    const admin = createFakeAdmin()
    const app = await setupApp({ admin, start: 'manage', columns: 120, rows: 36 })
    await frameUntil(app.lastFrame, (f) => f.includes('people    3'))
    const frame = await openSection(app, 'Access')
    expect(frame).toContain('audit     kept 180 days')
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('Actions'))
    await Bun.sleep(80)
    await selectRow(app, 'Audit retention')
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('Days'))
    for (let i = 0; i < 3; i++) app.stdin.write('\u007f')
    await type(app, '30')
    app.stdin.write('\r')
    await said(app, 'audit kept 30 days')
    expect(admin.inputs('admin/audit/retention/set')).toEqual([{ days: 30 }])
    app.unmount()
  })
})
