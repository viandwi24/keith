import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, settingsRepo, tokensRepo } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { LOCK_FILE, openOfflineAdmin } from '../modules/admin/index.ts'
import { silentLogger } from '../platform/logger.ts'
import { generateSecretKey } from '../platform/vault.ts'
import { type RunningCore, runCore } from '../run-core.ts'
import { type TestIo, testIo } from '../testing/cli-io.ts'
import { type CliDeps, configOf } from './context.ts'
import { runCoreCli } from './program.ts'

const dirs: string[] = []
const running: RunningCore[] = []
afterAll(async () => {
  for (const r of running) await r.stop().catch(() => undefined)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const scripted = () => [
  scriptedProvider({ models: { a: [{ text: 'from a' }], b: [{ text: 'from b' }] } }),
]

function newDeps(): CliDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'keith-cli-'))
  dirs.push(dir)
  return {
    dir,
    env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'cli' },
    offline: { definitions: scripted(), catalogs: { offline: true } },
  }
}

async function run(
  argv: string[],
  deps: CliDeps,
  stdin?: string,
): Promise<{ code: number; io: TestIo }> {
  const io = testIo()
  // the owner PIN of a headless setup comes from stdin
  if (stdin !== undefined) io.send(stdin)
  else if (argv.includes('--owner-pin-stdin')) io.send('482915\n')
  io.end()
  return { code: await runCoreCli(argv, io, deps), io }
}

const SETUP = [
  'setup',
  '--non-interactive',
  '--owner-name',
  'Vian',
  '--provider',
  'scripted',
  '--front-model',
  'a',
  '--cortex-model',
  'b',
  '--budget',
  '30',
  '--owner-pin-stdin',
]

async function boot(deps: ReturnType<typeof newDeps>): Promise<RunningCore> {
  expect((await run(SETUP, deps)).code).toBe(0)
  const config = configOf(deps)
  const r = await runCore({
    config,
    logger: { ...silentLogger, flush: async () => {}, secretOnce() {} },
    core: { definitions: scripted(), catalogs: { offline: true }, localTrust: 'full' },
    port: 0,
  })
  running.push(r)
  return r
}

describe('keith-core setup', () => {
  test('non-interactive happy path stores everything and mints no token', async () => {
    const deps = newDeps()
    const { code, io } = await run(SETUP, deps)
    expect(code).toBe(0)
    expect(io.out()).toContain('Saved for Vian')
    expect(io.out()).toContain('keith-core start')
    const sqlite = openDatabase(configOf(deps).dbFile)
    const settings = settingsRepo(sqlite)
    expect(settings.get('setup.done')).toBe(true)
    expect(settings.get('model.front')).toBe('scripted:a')
    expect(settings.get('model.cortex')).toBe('scripted:b')
    expect(settings.get('access.mode')).toBe('local')
    expect(settings.get('access.host')).toBe('127.0.0.1')
    const repo = tokensRepo(sqlite)
    expect(repo.owner()?.name).toBe('Vian')
    expect(repo.list('owner')).toEqual([])
    sqlite.close()
    expect(existsSync(join(deps.dir, LOCK_FILE))).toBe(false) // lock released
  })

  test('a missing answer is a usage error (exit 2) naming the flag', async () => {
    const deps = newDeps()
    const { code, io } = await run(['setup', '--non-interactive', '--provider', 'skip'], deps)
    expect(code).toBe(2)
    expect(io.err()).toContain('missing --owner-name')
  })

  test('re-running keeps the current values as defaults', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    const again = await run(['setup', '--non-interactive'], deps)
    expect(again.code).toBe(0)
    expect(again.io.out()).toContain('Saved for Vian')
    expect(again.io.out()).toContain('scripted:a')
  })

  test('an API key comes from stdin and is tested before it is saved', async () => {
    const deps = newDeps()
    deps.env = { ...deps.env }
    const bad = await run(
      [
        'setup',
        '--non-interactive',
        '--owner-name',
        'Vian',
        '--provider',
        'openrouter',
        '--api-key-stdin',
      ],
      {
        ...deps,
        offline: {
          ...deps.offline,
          fetch: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
        },
      },
      'not-a-key\n',
    )
    expect(bad.code).toBe(1)
    expect(bad.io.err()).toContain('connection test')
    const sqlite = openDatabase(configOf(deps).dbFile)
    const rows = sqlite.query('SELECT id FROM config_profiles').all()
    sqlite.close()
    expect(rows).toEqual([]) // nothing saved, not even the probe
  })

  test('start without a terminal on an unconfigured folder exits 2', async () => {
    const deps = newDeps()
    const { code, io } = await run(['start'], deps)
    expect(code).toBe(2)
    expect(io.err()).toContain('keith-core setup')
  })
})

describe('online commands over the local socket', () => {
  test('status, config, access, budget, models and tokens', async () => {
    const deps = newDeps()
    const core = await boot(deps)
    expect(existsSync(join(deps.dir, LOCK_FILE))).toBe(true) // core holds the lock

    const status = await run(['status'], deps)
    expect(status.code).toBe(0)
    expect(status.io.out()).toContain('up (keith')
    expect(status.io.out()).toContain('scripted:a')
    expect(status.io.out()).toContain('0 / 30 USD')
    expect(status.io.out()).toContain(core.socketPath)

    const config = await run(['config', 'show'], deps)
    expect(config.io.out()).toContain('(env)') // data dir
    expect(config.io.out()).toContain('Vian')

    const access = await run(
      ['access', 'remote', '--public-url', 'https://mac.example.ts.net'],
      deps,
    )
    expect(access.code).toBe(0)
    expect(access.io.out()).toContain('bind 127.0.0.1') // https proxy keeps loopback
    expect(access.io.out()).not.toContain('restart needed')
    const wider = await run(['access', 'remote', '--bind', '0.0.0.0'], deps)
    expect(wider.io.out()).toContain('restart needed') // the bind address changed

    expect((await run(['budget', 'set', '12'], deps)).io.out()).toContain('limit 12 USD')
    expect((await run(['model', 'set', 'front', 'b'], deps)).io.out()).toContain('scripted:b')
    expect((await run(['provider', 'list'], deps)).io.out()).toContain('scripted')

    const created = await run(['token', 'create', '--label', 'tui'], deps)
    expect(created.code).toBe(0)
    const token = created.io.out().split('\n')[1]
    expect(token).toStartWith('keith_')
    const list = await run(['token', 'list'], deps)
    expect(list.io.out()).toContain('tui')
    const id = created.io.out().split(' ')[1] ?? ''
    expect((await run(['token', 'revoke', id], deps)).code).toBe(0)
    expect((await run(['token', 'list'], deps)).io.out()).toContain('revoked')

    const pair = await run(['pair'], deps)
    expect(pair.io.out()).toMatch(/pairing code [A-Z0-9]{4}-[A-Z0-9]{4}/)
  })

  test('offline-only commands refuse while the socket answers; online ones refuse when it does not', async () => {
    const deps = newDeps()
    const core = await boot(deps)
    for (const argv of [
      ['setup', '--non-interactive'],
      ['db', 'migrate'],
      ['token', 'recover'],
    ]) {
      const r = await run(argv, deps)
      expect(r.code).toBe(1)
      expect(r.io.err()).toContain('core is running')
    }
    await core.stop()
    running.splice(running.indexOf(core), 1)
    expect(existsSync(join(deps.dir, LOCK_FILE))).toBe(false)
    expect(existsSync(core.socketPath)).toBe(false)

    const down = await run(['budget', 'show'], deps)
    expect(down.code).toBe(1)
    expect(down.io.err()).toContain('core is not running')
    expect((await run(['status'], deps)).code).toBe(1)

    const recover = await run(['token', 'recover'], deps)
    expect(recover.code).toBe(0)
    expect(recover.io.out()).toContain('keith_')
  })

  test('a second start refuses: core already running', async () => {
    const deps = newDeps()
    await boot(deps)
    await expect(
      runCore({
        config: configOf(deps),
        logger: { ...silentLogger, flush: async () => {}, secretOnce() {} },
        port: 0,
      }),
    ).rejects.toThrow('already running')
  })
})

describe('keith-core db migrate (P26.1.3)', () => {
  test('takes core.lock: a lock held by a live pid refuses it, and nothing is migrated', async () => {
    const deps = newDeps()
    await run(SETUP, deps)
    writeFileSync(join(deps.dir, LOCK_FILE), `${process.pid}\n`)
    try {
      const { code, io } = await run(['db', 'migrate'], deps)
      expect(code).toBe(1)
      expect(io.err()).toContain('another keith-core process')
    } finally {
      rmSync(join(deps.dir, LOCK_FILE), { force: true })
    }
  })
})

describe('doctor', () => {
  test('a good setup passes; a broken one names the fix', async () => {
    const deps = newDeps()
    const empty = await run(['doctor', '--offline'], deps)
    expect(empty.code).toBe(1)
    expect(empty.io.out()).toContain('✗ database')
    await run(SETUP, deps)
    const good = await run(['doctor', '--offline'], deps)
    expect(good.io.out()).toContain('✓ database')
    expect(good.io.out()).toContain('✓ setup')
    expect(good.io.out()).toContain('✓ front model')
    expect(good.io.out()).toContain('! socket')
    expect(good.code).toBe(0)
  })

  test('doctor never prompts: piped input is not read and a socket that needs a session is a note', async () => {
    const deps = newDeps()
    expect((await run(SETUP, deps)).code).toBe(0)
    let asked = 0
    const quiet = {
      ...deps,
      askPin: async () => {
        asked += 1
        return '482915'
      },
    }
    // `local trust: none` (the default posture): the socket answers 401 until a PIN buys a session
    const r = await runCore({
      config: configOf(deps),
      logger: { ...silentLogger, flush: async () => {}, secretOnce() {} },
      core: { definitions: scripted(), catalogs: { offline: true }, localTrust: 'none' },
      port: 0,
    })
    running.push(r)
    const { io } = await run(['doctor', '--offline'], quiet, '482915\n')
    expect(asked).toBe(0)
    expect(io.out()).not.toContain('Owner PIN')
    // a note, never a failure: the views line is `!` and no `✗` names it
    expect(io.out()).toContain('! plugin views — needs an admin session, run keith-core login')
    expect(io.out()).not.toContain('✗ plugin views')
  })

  test('doctor writes nothing: a key it cannot read is a note, exit 0, no audit row, no secret.key', async () => {
    // built at runtime: a key-shaped literal would trip gitleaks
    const KEY = ['sk', 'or', crypto.randomUUID().replaceAll('-', '')].join('-')
    const deps = newDeps()
    const withKey = (key: string | undefined): CliDeps => ({
      ...deps,
      env: { ...deps.env, ...(key === undefined ? {} : { KEITH_SECRET_KEY: key }) },
    })
    const keyA = generateSecretKey()
    const keyB = generateSecretKey()
    expect((await run(SETUP, withKey(keyA))).code).toBe(0)
    const admin = await openOfflineAdmin(configOf(withKey(keyA)), { catalogs: { offline: true } })
    await admin.providers.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
    admin.close()

    const unreadableRows = (): number => {
      const sqlite = openDatabase(configOf(deps).dbFile)
      try {
        return (
          sqlite
            .query<{ n: number }, []>(
              "SELECT count(*) AS n FROM audit_events WHERE kind = 'settings.unreadable'",
            )
            .get()?.n ?? 0
        )
      } finally {
        sqlite.close()
      }
    }

    const wrongKey = await run(['doctor', '--offline'], withKey(keyB))
    expect(wrongKey.io.out()).toContain(
      '! provider openrouter — doctor cannot read the key the core uses: run it with the same KEITH_SECRET_KEY',
    )
    expect(wrongKey.io.out()).not.toContain('✗ provider')
    expect(wrongKey.code).toBe(0)

    // no key at all in this shell: still a note, and no dev key file is created in the folder
    const noKey = await run(['doctor', '--offline'], withKey(undefined))
    expect(noKey.io.out()).toContain('! provider openrouter')
    expect(noKey.code).toBe(0)
    expect(existsSync(join(deps.dir, 'secret.key'))).toBe(false)

    expect(unreadableRows()).toBe(0)
  })
})

describe('budget amounts (P24.4.6, FD10-04)', () => {
  test('an empty or unparsable amount is a usage error before core is reached; none is a usage error that names none', async () => {
    const deps = newDeps()
    const empty = await run(['budget', 'set', ''], deps)
    expect(empty.code).toBe(2)
    expect(empty.io.err()).toContain('--budget must be')
    for (const bad of ['0x10', '1e3', 'unlimited']) {
      const r = await run(['budget', 'set', bad], deps)
      expect(r.code).toBe(2)
    }
    expect((await run(['setup', '--non-interactive', '--budget', ''], deps)).code).toBe(2)
  })
})
