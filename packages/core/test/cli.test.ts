import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeLlm, createFakeLlmPlugin } from '@keith/sdk/testing'
import { KEITH_VERSION } from '../src/bootstrap.ts'
import { type CliIo, keithHome, runCli, scriptedPrompter } from '../src/cli/index.ts'
import { defaultPersona, parseConfig } from '../src/config/index.ts'
import { openDb } from '../src/storage/index.ts'
import { createTestHome, quietLogger, testClock } from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function tempHome(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'keith-cli-')), 'home')
  cleanups.push(() => rmSync(join(dir, '..'), { recursive: true, force: true }))
  return dir
}

function io(home: string, answers: string[] = [], asked: string[] = []): CliIo & { lines: string[] } {
  const lines: string[] = []
  return {
    env: { KEITH_HOME: home },
    out: (line) => lines.push(line),
    err: (line) => lines.push(`ERR ${line}`),
    prompter: scriptedPrompter(answers, asked),
    clock: testClock(),
    lines,
  }
}

async function readConfig(home: string, env: Record<string, string>) {
  return parseConfig(Bun.TOML.parse(await Bun.file(join(home, 'config.toml')).text()), { env })
}

async function owners(home: string) {
  const db = openDb(join(home, 'keith.db'))
  try {
    return (await db.repos.persons.list()).filter((p) => p.tier === 'owner')
  } finally {
    db.close()
  }
}

describe('keith setup', () => {
  test('creates config, persona, db and owner in a fresh KEITH_HOME (DeepSeek)', async () => {
    const home = tempHome()
    const asked: string[] = []
    // provider (default 1 = DeepSeek), model (default), web (default y), weather (default y), name,
    // username (default), password twice
    const code = await runCli(
      ['setup'],
      io(home, ['', '', '', '', 'Tony Stark', '', 'jarvis-42', 'jarvis-42'], asked),
    )
    expect(code).toBe(0)
    expect(asked[0]).toContain('DeepSeek')
    expect(asked[0]).toContain('OpenRouter')

    const config = await readConfig(home, { DEEPSEEK_API_KEY: 'sk-test' })
    expect(asked[2]).toContain('@keith/web')
    expect(asked[3]).toContain('@keith/tool-weather')
    expect(config.plugins.enabled).toEqual(['@keith/provider-deepseek', '@keith/web', '@keith/tool-weather'])
    // Only the provider is required: Keith starts without the web app or the weather tool.
    expect(config.plugins.required).toEqual(['@keith/provider-deepseek'])
    expect(config.plugins.sections['@keith/provider-deepseek']).toEqual({ apiKey: 'sk-test' })
    expect(config.models).toEqual({
      foreground: 'deepseek:deepseek-flash',
      background: 'deepseek:deepseek-flash',
      utility: 'deepseek:deepseek-flash',
    })
    // The key stays an env: reference in the file.
    expect(await Bun.file(join(home, 'config.toml')).text()).toContain('apiKey = "env:DEEPSEEK_API_KEY"')

    expect(await Bun.file(join(home, 'persona.md')).text()).toBe(defaultPersona('Keith'))
    for (const dir of ['files', 'plugins', 'logs']) expect(statSync(join(home, dir)).isDirectory()).toBe(true)

    const [owner, ...others] = await owners(home)
    expect(others).toEqual([])
    expect(owner?.name).toBe('Tony Stark')
    expect(owner?.username).toBe('tony-stark')
    expect(await Bun.password.verify('jarvis-42', owner?.passwordHash ?? '')).toBe(true)
  })

  test('OpenRouter with a custom model id maps every role to it', async () => {
    const home = tempHome()
    const code = await runCli(
      ['setup'],
      io(home, [
        'openrouter',
        'acme/model-x',
        'n',
        'n',
        'Pepper',
        'pepper',
        'short',
        'long-enough',
        'long-enough',
      ]),
    )
    expect(code).toBe(0)
    const config = await readConfig(home, { OPENROUTER_API_KEY: 'or-test' })
    expect(config.plugins.enabled).toEqual(['@keith/provider-openrouter'])
    expect(config.plugins.sections['@keith/provider-openrouter']).toEqual({
      apiKey: 'or-test',
      appTitle: 'Keith',
    })
    expect(Object.values(config.models)).toEqual([
      'openrouter:acme/model-x',
      'openrouter:acme/model-x',
      'openrouter:acme/model-x',
    ])
  })

  test('running it again keeps the files, offers a password reset and never duplicates the owner', async () => {
    const home = tempHome()
    expect(
      await runCli(['setup'], io(home, ['1', '', 'n', 'n', 'Tony', 'tony', 'first-pass', 'first-pass'])),
    ).toBe(0)
    const configBefore = await Bun.file(join(home, 'config.toml')).text()
    await Bun.write(join(home, 'persona.md'), 'My own persona')

    // Decline the reset.
    const asked: string[] = []
    const second = io(home, ['n'], asked)
    expect(await runCli(['setup'], second)).toBe(0)
    expect(asked).toEqual(['Reset the password of tony? (y/n)'])
    expect(second.lines.join('\n')).toContain('Keeping the existing')
    // The existing config enables neither optional plugin: setup says how to add them.
    expect(second.lines).toContain(
      'To enable @keith/web, add "@keith/web" to plugins.enabled in config.toml.',
    )
    expect(second.lines.join('\n')).toContain('To enable @keith/tool-weather')

    // Accept it.
    expect(await runCli(['setup'], io(home, ['y', 'second-pass', 'second-pass']))).toBe(0)

    expect(await Bun.file(join(home, 'config.toml')).text()).toBe(configBefore)
    expect(await Bun.file(join(home, 'persona.md')).text()).toBe('My own persona')
    const list = await owners(home)
    expect(list).toHaveLength(1)
    expect(await Bun.password.verify('second-pass', list[0]?.passwordHash ?? '')).toBe(true)
  })

  test('mismatched passwords are asked again', async () => {
    const home = tempHome()
    const asked: string[] = []
    const answers = ['1', '', '', '', 'Tony', 'tony', 'password-a', 'password-b', 'password-c', 'password-c']
    expect(await runCli(['setup'], io(home, answers, asked))).toBe(0)
    expect(asked.filter((q) => q.startsWith('Password'))).toHaveLength(2)
    const [owner] = await owners(home)
    expect(await Bun.password.verify('password-c', owner?.passwordHash ?? '')).toBe(true)
  })

  test('running out of answers fails with exit code 1 and a message', async () => {
    const home = tempHome()
    const cli = io(home, ['1'])
    expect(await runCli(['setup'], cli)).toBe(1)
    expect(cli.lines.at(-1)).toStartWith('ERR ')
  })
})

describe('keith', () => {
  test('--version prints the version', async () => {
    const cli = io(tempHome())
    expect(await runCli(['--version'], cli)).toBe(0)
    expect(cli.lines).toEqual([KEITH_VERSION])
  })

  test('an unknown command exits 2 with usage', async () => {
    const cli = io(tempHome())
    expect(await runCli(['frobnicate'], cli)).toBe(2)
    expect(cli.lines.join('\n')).toContain('Usage: keith')
  })

  test('migrate creates and migrates the database', async () => {
    const home = tempHome()
    const cli = io(home)
    expect(await runCli(['migrate'], cli)).toBe(0)
    expect(await owners(home)).toEqual([])
    expect(await runCli(['migrate'], cli)).toBe(0)
  })

  test('KEITH_HOME defaults to ~/.keith', () => {
    expect(keithHome({})).toEndWith('.keith')
    expect(keithHome({ KEITH_HOME: '/srv/keith' })).toBe('/srv/keith')
  })

  test('start --port 0 listens, serves health, and stops when asked', async () => {
    const home = await createTestHome()
    cleanups.push(() => home.remove())
    const clock = testClock()
    const cli = io(home.dir)
    let health: unknown
    const code = await runCli(['start', '--port', '0', '--host', '127.0.0.1'], {
      ...cli,
      bootstrap: { plugins: [createFakeLlmPlugin(createFakeLlm())], log: quietLogger(clock), clock },
      async waitForStop(keith) {
        health = await (await fetch(`${keith.url}/v1/health`)).json()
      },
    })
    expect(code).toBe(0)
    expect(health).toMatchObject({ ok: true })
    expect(cli.lines[0]).toMatch(/^Keith .* is listening on http:\/\/127\.0\.0\.1:\d+$/)
  })

  test('start rejects an invalid --port', async () => {
    const cli = io(tempHome())
    expect(await runCli(['start', '--port', 'abc'], cli)).toBe(2)
  })
})
