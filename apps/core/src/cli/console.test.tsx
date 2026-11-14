import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { CommandContext } from '@keith/cli'
import { cleanup, render } from '@keith/ui/testing'
import { socketPathFor } from '../modules/local-socket/index.ts'
import { loadConfig } from '../platform/config.ts'
import { type TestIo, testIo } from '../testing/cli-io.ts'
import { ConsoleHome } from './console-home.tsx'
import type { ConsoleDeps, HomeChoice, WizardOutcome } from './console-types.ts'
import type { CliDeps } from './context.ts'
import type { Check } from './doctor.ts'
import { runCoreCli } from './program.ts'
import { wizardWanted } from './setup-wizard-run.tsx'

afterEach(cleanup)

const DIR = join('/tmp', 'keith-console-test')
const SOCKET = socketPathFor(loadConfig({ KEITH_DATA_DIR: DIR }).dataDir)
const SAVED: WizardOutcome = {
  status: 'saved',
  summary: { owner: 'Vian', connection: undefined, models: undefined, budget: 20, access: 'local' },
}

interface Spy {
  calls: string[]
  spawned: string[][]
  deps: CliDeps
}

function spy(options: {
  running?: boolean
  configured?: boolean
  wizard?: WizardOutcome[]
  home?: HomeChoice[]
  which?: string | null
}): Spy {
  const calls: string[] = []
  const spawned: string[][] = []
  const wizard = [...(options.wizard ?? [])]
  const home = [...(options.home ?? [])]
  let configured = options.configured ?? false
  const console: ConsoleDeps = {
    probe: async () => options.running ?? false,
    configured: () => configured,
    which: () => (options.which === undefined ? '/usr/local/bin/keith' : options.which),
    spawn: async (command) => {
      spawned.push(command)
      return 3
    },
    ownerSignIn: async () => {
      calls.push('sign-in offer')
    },
    start: async () => {
      calls.push('start')
      return 7
    },
    ui: {
      wizard: async () => {
        calls.push('wizard')
        const outcome = wizard.shift() ?? { status: 'cancelled' as const }
        if (outcome.status === 'saved') configured = true
        return outcome
      },
      home: async (props) => {
        calls.push(props.notice === undefined ? 'home' : `home:${props.notice}`)
        return home.shift() ?? 'quit'
      },
    },
  }
  return { calls, spawned, deps: { env: { KEITH_DATA_DIR: DIR }, console } }
}

const tty = (): TestIo & { isTTY: true } => ({ ...testIo(), isTTY: true })

async function launch(argv: string[], s: Spy, io: TestIo = tty()) {
  const code = await runCoreCli(argv, io, s.deps)
  return { code, io }
}

describe('keith-core with no arguments', () => {
  test('without a terminal, or with --help, it prints the help as before', async () => {
    const piped = spy({})
    const a = await launch([], piped, testIo())
    expect(a.code).toBe(0)
    expect(a.io.out()).toContain('keith-core')
    expect(a.io.out()).toContain('setup')
    const helped = spy({})
    const b = await launch(['--help'], helped)
    expect(b.io.out()).toContain('Commands')
    expect(piped.calls).toEqual([])
    expect(helped.calls).toEqual([])
  })

  test('not set up: the wizard, then the home screen with a notice', async () => {
    const s = spy({ configured: false, wizard: [SAVED], home: ['quit'] })
    const { code } = await launch([], s)
    expect(code).toBe(0)
    expect(s.calls).toEqual(['wizard', 'home:Setup saved.'])
  })

  test('cancelling the wizard leaves without a home screen and says nothing was saved', async () => {
    const s = spy({ configured: false, wizard: [{ status: 'cancelled' }] })
    const { code, io } = await launch([], s)
    expect(code).toBe(0)
    expect(s.calls).toEqual(['wizard'])
    expect(io.out()).toContain('nothing was saved')
  })

  test('set up and stopped: the home screen; Start runs core in this process', async () => {
    const s = spy({ configured: true, home: ['start'] })
    const { code } = await launch([], s)
    // the owner sign-in offer comes before core starts, as in `keith-core start`
    expect(s.calls).toEqual(['home', 'sign-in offer', 'start'])
    expect(code).toBe(7)
  })

  test('Run setup again opens the wizard and returns to the home screen', async () => {
    const s = spy({ configured: true, home: ['setup', 'quit'], wizard: [SAVED] })
    const { code } = await launch([], s)
    expect(code).toBe(0)
    expect(s.calls).toEqual(['home', 'wizard', 'home:Setup saved.'])
  })

  test('core running: hands the terminal to `keith manage` over the socket', async () => {
    const s = spy({ running: true, configured: true })
    const { code } = await launch([], s)
    expect(code).toBe(3) // the exit code of the spawned manager
    expect(s.spawned).toEqual([['/usr/local/bin/keith', 'manage', '--core', `unix:${SOCKET}`]])
    expect(s.calls).toEqual([]) // no wizard, no home
  })

  test('core running but `keith` is not on PATH: prints the command and how to link it', async () => {
    const s = spy({ running: true, which: null })
    const { code, io } = await launch([], s)
    expect(code).toBe(0)
    expect(s.spawned).toEqual([])
    expect(io.out()).toContain(`keith manage --core unix:${SOCKET}`)
    expect(io.out()).toContain('bun run link')
  })
})

describe('keith-core setup', () => {
  test('on a terminal without answer flags it opens the wizard', async () => {
    const s = spy({ wizard: [SAVED] })
    const { code, io } = await launch(['setup'], s)
    expect(code).toBe(0)
    expect(s.calls).toEqual(['wizard'])
    expect(io.out()).toContain('Saved for Vian')
    expect(io.out()).toContain('keith-core start')
  })

  test('a cancelled wizard saves nothing and says so', async () => {
    const s = spy({ wizard: [{ status: 'cancelled' }] })
    const { io } = await launch(['setup'], s)
    expect(io.out()).toContain('Setup cancelled; nothing was saved.')
  })

  test('--non-interactive on a terminal keeps the prompt flow', async () => {
    const s = spy({})
    const { code, io } = await launch(['setup', '--non-interactive', '--provider', 'skip'], s)
    expect(s.calls).toEqual([]) // no wizard
    expect(code).toBe(2)
    expect(io.err()).toContain('missing --owner-name')
  })

  test('without a terminal the wizard is never wanted either', async () => {
    const s = spy({})
    const { code } = await launch(['setup', '--provider', 'skip'], s, testIo())
    expect(s.calls).toEqual([])
    expect(code).toBe(2)
  })

  test('any answer flag turns the wizard off', () => {
    const ctx = (flags: Record<string, string | boolean>): CommandContext =>
      ({
        string: (n: string) => (typeof flags[n] === 'string' ? flags[n] : undefined),
        bool: (n: string) => flags[n] === true,
      }) as unknown as CommandContext
    expect(wizardWanted(ctx({}))).toBe(true)
    expect(wizardWanted(ctx({ 'owner-name': 'Vian' }))).toBe(false)
    expect(wizardWanted(ctx({ 'api-key-stdin': true }))).toBe(false)
    expect(wizardWanted(ctx({ budget: '5' }))).toBe(false)
  })
})

describe('home screen', () => {
  const checks: Check[] = [
    { level: 'ok', name: 'database', hint: 'migrated' },
    { level: 'warn', name: 'socket', hint: 'core is not running' },
    { level: 'fail', name: 'provider', hint: 'none configured' },
  ]

  test('lists the actions, runs the doctor on the screen and reports the choice', async () => {
    const choices: HomeChoice[] = []
    let ran = 0
    const view = render(
      <ConsoleHome
        notice="Setup saved."
        doctor={async () => {
          ran++
          return checks
        }}
        onChoose={(c) => choices.push(c)}
      />,
      { columns: 80, rows: 24 },
    )
    const frame = () => view.lastFrame() ?? ''
    await Bun.sleep(40)
    for (const text of ['Setup saved.', 'Start core', 'Doctor', 'Run setup again', 'Quit']) {
      expect(frame()).toContain(text)
    }
    view.stdin.write('d')
    await Bun.sleep(80)
    expect(ran).toBe(1)
    expect(frame()).toContain('✓ database')
    expect(frame()).toContain('! socket')
    expect(frame()).toContain('✕ provider')
    expect(choices).toEqual([]) // the doctor does not leave the screen
    view.stdin.write('\u001b[B\u001b[B') // the doctor row was selected: down twice to Quit
    await Bun.sleep(40)
    view.stdin.write('\r')
    await Bun.sleep(40)
    view.stdin.write('s')
    await Bun.sleep(40)
    expect(choices).toEqual(['quit', 'start'])
  })

  test('the home offers the machine owner actions only: no manager section, no audit view', async () => {
    const view = render(<ConsoleHome doctor={async () => []} onChoose={() => undefined} />, {
      columns: 80,
      rows: 24,
    })
    await Bun.sleep(40)
    const frame = view.lastFrame() ?? ''
    // the Manage sections of a signed-in person live in the TUI; this console never draws one
    for (const title of [
      'People',
      'Groups',
      'Plugins',
      'Reviews',
      'Devices & tokens',
      'Access',
      'Privacy',
      'Audit',
    ])
      expect(frame).not.toContain(title)
    for (const text of ['Start core', 'Doctor', 'Run setup again', 'Quit'])
      expect(frame).toContain(text)
  })
})
