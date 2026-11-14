import { describe, expect, test } from 'bun:test'
import { defineCommand, runCli } from './command.ts'
import { CliError, PromptCancelled } from './errors.ts'
import { printNextSteps, printTable } from './output.ts'
import { fakeIo } from './testing/fake-io.ts'

const calls: string[] = []

const commands = [
  defineCommand({
    name: 'setup',
    summary: 'Run the setup wizard',
    flags: {
      'owner-name': { type: 'string', placeholder: 'name', description: 'Owner display name' },
      budget: { type: 'string', default: '20', description: 'Monthly budget in USD' },
      'non-interactive': { type: 'boolean', short: 'n', description: 'Never prompt' },
    },
    examples: ['keith-core setup --owner-name Vian'],
    run: (ctx) => {
      calls.push(
        `setup ${ctx.require('owner-name')} ${ctx.string('budget')} ${ctx.bool('non-interactive')}`,
      )
    },
  }),
  defineCommand({
    name: 'provider',
    summary: 'Manage AI providers',
    subcommands: [
      defineCommand({
        name: 'add',
        summary: 'Add a provider',
        flags: { 'api-key-stdin': { type: 'boolean', description: 'Read the key from stdin' } },
        positionals: true,
        usage: '<id> [flags]',
        run: (ctx) => {
          calls.push(`provider add ${ctx.positionals.join(',')}`)
        },
      }),
      defineCommand({ name: 'list', summary: 'List providers', run: () => 3 }),
    ],
  }),
  defineCommand({
    name: 'boom',
    summary: 'Fails',
    run: () => {
      throw new CliError('core is not running; `keith-core start`')
    },
  }),
  defineCommand({
    name: 'cancel',
    summary: 'Cancels',
    run: () => {
      throw new PromptCancelled()
    },
  }),
]

async function run(argv: string[]) {
  const io = fakeIo()
  const code = await runCli({
    program: 'keith-core',
    version: '1.2.3',
    summary: 'The core',
    commands,
    argv,
    io,
  })
  return { code, out: io.out(), err: io.err() }
}

describe('runCli', () => {
  test('--version', async () => {
    expect(await run(['--version'])).toMatchObject({ code: 0, out: 'keith-core 1.2.3\n' })
  })

  test('program help lists commands with aligned summaries', async () => {
    const { code, out } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('keith-core 1.2.3 - The core')
    expect(out).toContain('Usage:\n  keith-core <command> [flags]')
    expect(out).toContain('  setup     Run the setup wizard')
    expect(out).toContain('  provider  Manage AI providers')
    expect(out).toContain('--version')
  })

  test('no arguments prints help and exits 0', async () => {
    expect((await run([])).code).toBe(0)
  })

  test('command help: usage, flags with defaults, examples', async () => {
    const { code, out } = await run(['setup', '--help'])
    expect(code).toBe(0)
    expect(out).toContain('keith-core setup [flags]')
    expect(out).toContain('--owner-name <name>')
    expect(out).toContain('Monthly budget in USD (default: 20)')
    expect(out).toContain('-n, --non-interactive')
    expect(out).toContain('Examples:\n  keith-core setup --owner-name Vian')
  })

  test('`help <command>` equals `<command> --help`', async () => {
    const a = await run(['help', 'setup'])
    const b = await run(['setup', '--help'])
    expect(a.out).toBe(b.out)
  })

  test('runs a command with parsed flags and defaults', async () => {
    calls.length = 0
    expect((await run(['setup', '--owner-name', 'Vian', '-n'])).code).toBe(0)
    expect(calls).toEqual(['setup Vian 20 true'])
  })

  test('missing required flag is a usage error naming it', async () => {
    const { code, err } = await run(['setup'])
    expect(code).toBe(2)
    expect(err).toContain('missing --owner-name')
    expect(err).toContain("Try 'keith-core setup --help'")
  })

  test('unknown flag is a usage error', async () => {
    const { code, err } = await run(['setup', '--nope'])
    expect(code).toBe(2)
    expect(err).toContain('--nope')
  })

  test('unknown command suggests the closest one', async () => {
    const { code, err } = await run(['setpu'])
    expect(code).toBe(2)
    expect(err).toContain('unknown command setpu. Did you mean setup?')
  })

  test('unknown command without a close match has no suggestion', async () => {
    const { err } = await run(['zzzzzzzz'])
    expect(err).toContain('unknown command zzzzzzzz.')
    expect(err).not.toContain('Did you mean')
  })

  test('nested subcommand routing, positionals and exit code', async () => {
    calls.length = 0
    expect((await run(['provider', 'add', 'openrouter', '--api-key-stdin'])).code).toBe(0)
    expect(calls).toEqual(['provider add openrouter'])
    expect((await run(['provider', 'list'])).code).toBe(3)
  })

  test('unknown subcommand suggests within the group', async () => {
    const { code, err } = await run(['provider', 'ad'])
    expect(code).toBe(2)
    expect(err).toContain('unknown command provider ad. Did you mean provider add?')
    expect(err).toContain("Try 'keith-core provider --help'")
  })

  test('group help lists subcommands; group without run prints help', async () => {
    const help = await run(['provider', '--help'])
    expect(help.out).toContain('  add   Add a provider')
    expect(help.out).toContain('keith-core provider <command>')
    expect((await run(['provider'])).out).toBe(help.out)
  })

  test('subcommand help uses the custom usage', async () => {
    expect((await run(['provider', 'add', '--help'])).out).toContain(
      'keith-core provider add <id> [flags]',
    )
  })

  test('positionals are refused when a command takes none', async () => {
    expect((await run(['setup', 'extra', '--owner-name', 'x'])).code).toBe(2)
  })

  test('runtime error: one line, exit 1', async () => {
    const { code, err } = await run(['boom'])
    expect(code).toBe(1)
    expect(err).toBe('keith-core: core is not running; `keith-core start`\n')
  })

  test('cancelled prompt: exit 130', async () => {
    expect((await run(['cancel'])).code).toBe(130)
  })

  test('default command runs when argv starts with a flag', async () => {
    const io = fakeIo()
    calls.length = 0
    const code = await runCli({
      program: 'keith',
      version: '1',
      commands: [
        defineCommand({
          name: 'chat',
          summary: 'Chat',
          flags: { core: { type: 'string', description: 'Core URL' } },
          run: (ctx) => {
            calls.push(`chat ${ctx.string('core')}`)
          },
        }),
      ],
      defaultCommand: 'chat',
      argv: ['--core', 'http://x'],
      io,
    })
    expect(code).toBe(0)
    expect(calls).toEqual(['chat http://x'])
  })
})

describe('output helpers', () => {
  test('printTable aligns columns', () => {
    const io = fakeIo()
    printTable(
      io,
      [
        ['openrouter', 'ok'],
        ['x', 'failed'],
      ],
      { header: ['ID', 'STATE'] },
    )
    expect(io.out()).toBe('ID          STATE\nopenrouter  ok\nx           failed\n')
  })

  test('printNextSteps numbers the steps', () => {
    const io = fakeIo()
    printNextSteps(io, ['keith-core start', 'keith'])
    expect(io.out()).toBe('\nNext steps\n  1. keith-core start\n  2. keith\n')
  })

  test('colour is off for a non-terminal and when NO_COLOR is set', async () => {
    const { style } = await import('./output.ts')
    expect(style(fakeIo(), 'red', 'x')).toBe('x')
    expect(style(fakeIo({ tty: true, env: { NO_COLOR: '1' } }), 'red', 'x')).toBe('x')
    expect(style(fakeIo({ tty: true }), 'red', 'x')).toBe('\u001b[31mx\u001b[39m')
  })
})
