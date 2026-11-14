import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { launch, pressUntil, stopPty } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

describe.skipIf(!ptySupported)('keith manage, Groups, in a real pseudo-terminal', () => {
  test(
    'the owner creates a group and adds a member from the keyboard',
    async () => {
      const admin = createFakeAdmin()
      admin.groups.length = 0
      const { cli: app } = await launch({ rpc: admin.rpc }, ['Manage', 'Groups'], 120, undefined, [
        'manage',
      ])
      // the section list: Overview, People, Groups
      await pressUntil(app, '\u001b[B', (s) => s.includes('▸ People'), 'People selected')
      await pressUntil(app, '\u001b[B', (s) => s.includes('▸ Groups'), 'Groups selected')
      await pressUntil(
        app,
        '\r',
        (s) => s.includes('No groups yet') && s.includes('[n] create a group'),
        'the empty Groups list',
      )
      await pressUntil(app, 'n', (s) => s.includes('Create a group'), 'the create form')
      for (const ch of 'friends') {
        app.proc.terminal?.write(ch)
        await Bun.sleep(20)
      }
      await pressUntil(app, '\r', (s) => s.includes('group friends created'), 'the group created')
      expect(admin.inputs('admin/groups/create')).toEqual([{ name: 'friends' }])

      // the row is selected: its first action is the member picker
      await pressUntil(app, '\r', (s) => s.includes('Add a member'), 'the actions menu')
      await pressUntil(app, '\r', (s) => s.includes('‹ owner ›'), 'the person picker')
      await pressUntil(app, '\u001b[C', (s) => s.includes('‹ ana ›'), 'ana picked')
      await pressUntil(app, '\r', (s) => s.includes('ana added to friends'), 'ana added')
      expect(admin.inputs('admin/groups/add')).toEqual([{ group: 'g-friends', person: 'ana' }])
    },
    TEST_TIMEOUT,
  )
})
