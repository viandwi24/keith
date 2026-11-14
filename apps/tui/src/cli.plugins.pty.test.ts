import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { launch, pressUntil, stopPty } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'
const TEST_TIMEOUT = 90_000
const DOWN = '\u001b[B'

afterEach(stopPty)

describe.skipIf(!ptySupported)(
  'keith manage, Plugins and Reviews, in a real pseudo-terminal',
  () => {
    test(
      'the owner disables a plugin and approves a held reminder from the keyboard',
      async () => {
        const admin = createFakeAdmin()
        const { cli: app } = await launch(
          { rpc: admin.rpc },
          ['Manage', 'Plugins'],
          120,
          undefined,
          ['manage'],
        )
        // the section list: Overview, People, Groups, Plugins
        for (const next of ['People', 'Groups', 'Plugins'])
          await pressUntil(app, DOWN, (s) => s.includes(`▸ ${next}`), `${next} selected`)
        await pressUntil(
          app,
          '\r',
          (s) => s.includes('● enabled') && s.includes('[enter] actions'),
          'the Plugins list',
        )
        // notes is the first row: the menu is Show details, Disable
        await pressUntil(app, '\r', (s) => s.includes('Show details'), 'the actions menu')
        await pressUntil(app, DOWN, (s) => s.includes('▸ Disable'), 'Disable selected')
        await pressUntil(app, '\r', (s) => s.includes('Disable notes?'), 'the confirm')
        await pressUntil(
          app,
          'y',
          (s) => s.includes('takes effect when the core restarts'),
          'disabled, with the restart note',
        )
        expect(admin.inputs('admin/plugins/disable')).toEqual([{ id: 'notes' }])

        // back to the list, down to Reviews
        await pressUntil(app, '\t', (s) => s.includes('[enter] open'), 'the section list')
        await pressUntil(app, DOWN, (s) => s.includes('▸ Reviews'), 'Reviews selected')
        await pressUntil(
          app,
          '\r',
          (s) => s.includes('reminders.create') && s.includes('[enter] actions'),
          'the Reviews list',
        )
        expect(app.screen()).toContain('call the dentist')
        await pressUntil(app, '\r', (s) => s.includes('Show the request'), 'the actions menu')
        await pressUntil(app, DOWN, (s) => s.includes('▸ Approve'), 'Approve selected')
        await pressUntil(
          app,
          '\r',
          (s) => s.includes('Run reminders.create as ana?'),
          'the confirm',
        )
        await pressUntil(
          app,
          'y',
          (s) => s.includes('approved: reminders.create ran as ana'),
          'approved',
        )
        expect(admin.inputs('admin/reviews/approve')).toEqual([{ id: 'rev-1' }])
      },
      TEST_TIMEOUT,
    )
  },
)
