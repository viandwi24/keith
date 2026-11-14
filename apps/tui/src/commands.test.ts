import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '@keith/cli'
import { fakeIo } from '@keith/cli/testing'
import { readClientConfig, writeClientConfig } from '@keith/client'
import { type KeithDeps, keithCommands } from './commands.tsx'
import type { Connection } from './connection.ts'
import { loadConfig } from './platform/config.ts'

const dirs: string[] = []
const servers: Array<{ stop(force?: boolean): unknown }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'keith-cmd-'))
  dirs.push(dir)
  return dir
}

interface FakeOptions {
  /** Poll answers, one per poll call (the last repeats). */
  polls?: Array<{ status: string; credential?: string }>
  /** Every rpc call answers 401. */
  revoked?: boolean
  logoutFails?: boolean
}

/** A core that speaks device login, `auth.whoami` and `auth.logout`. */
function fakeCore(options: FakeOptions = {}) {
  const calls: Array<{ path: string; auth: string | null; body?: unknown }> = []
  const polls = [...(options.polls ?? [{ status: 'approved', credential: 'keith_s_fake' }])]
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body = await req.json().catch(() => undefined)
      calls.push({ path, auth: req.headers.get('authorization'), body })
      if (path === '/auth/login') return Response.json({ credential: 'keith_s_pw' })
      if (path === '/auth/identify')
        return Response.json({
          flowId: 'f1',
          context: 'loopback',
          methods: [
            {
              id: 'password',
              label: 'Password',
              available: true,
              assurance: 2,
              interaction: 'form',
              firstStep: { id: 'password', fields: [] },
            },
          ],
        })
      if (path === '/auth/flow/f1') return Response.json({ credential: 'keith_s_remembered' })
      if (path === '/auth/device/start')
        return Response.json({
          code: 'ABCD-EFGH',
          requestId: 'r1',
          expiresAt: Date.now() + 600_000,
          pollSecret: 'ps',
        })
      if (path === '/auth/device/poll')
        return Response.json(polls.length > 1 ? polls.shift() : polls[0])
      if (options.revoked || req.headers.get('authorization') === null)
        return Response.json(
          { json: { defined: false, code: 'UNAUTHORIZED', status: 401, message: 'no' } },
          { status: 401 },
        )
      if (path === '/rpc/auth/whoami')
        return Response.json({
          json: {
            personId: 'owner',
            name: 'Ana',
            role: 'owner',
            via: 'tcp',
            credentialKind: 'device',
          },
        })
      if (path === '/rpc/auth/logout') {
        if (options.logoutFails) return new Response('boom', { status: 500 })
        return Response.json({ json: { ok: true } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return { url: `http://localhost:${server.port}`, calls }
}

function harness(overrides: Partial<KeithDeps> = {}) {
  const dir = tmp()
  const configPath = join(dir, 'client.json')
  const chats: Connection[] = []
  const deps: KeithDeps = {
    configPath,
    dataDir: dir,
    startChat: async (c) => {
      chats.push(c)
      return 0
    },
    pollMs: 5,
    probe: async () => false,
    ...overrides,
  }
  const run = async (argv: string[], stdin?: string) => {
    const io = fakeIo()
    if (stdin !== undefined) {
      io.send(stdin)
    }
    const code = await runCli({
      program: 'keith',
      version: '0.0.0',
      commands: keithCommands(deps),
      defaultCommand: 'home',
      argv,
      io,
    })
    return { code, out: io.out(), err: io.err() }
  }
  return { run, configPath, chats, dir }
}

describe('keith login (device)', () => {
  test('prints the code and the approve command, then stores the credential 0600', async () => {
    const core = fakeCore({
      polls: [{ status: 'pending' }, { status: 'approved', credential: 'keith_s_x1' }],
    })
    const h = harness()
    const { code, out } = await h.run(['login', '--core', core.url, '--label', 'phone'])
    expect(code).toBe(0)
    expect(out).toContain(`keith login  ·  ${core.url}`)
    expect(out).toContain('On the core machine, approve this device:')
    expect(out).toContain('keith-core devices approve ABCD-EFGH --label <name>')
    expect(out).toContain('A B C D - E F G H')
    expect(out).toContain('waiting for approval · expires in 10 minutes · esc to cancel')
    expect(out).toContain(`✓ Logged in to ${core.url} as Ana (device "phone").`)
    expect(out).toContain('Saved for scripts and `keith whoami`')
    expect(out).not.toContain('Run keith to start.')
    expect(readClientConfig(h.configPath)).toEqual({ core: core.url, token: 'keith_s_x1' })
    expect(statSync(h.configPath).mode & 0o777).toBe(0o600)
    const start = core.calls.find((c) => c.path === '/auth/device/start')
    expect(start?.body).toEqual({ label: 'phone' })
  })

  test('the label defaults to this machine name', async () => {
    const core = fakeCore()
    const h = harness()
    await h.run(['login', '--core', core.url])
    const start = core.calls.find((c) => c.path === '/auth/device/start')
    const label = (start?.body as { label?: string } | undefined)?.label ?? ''
    expect(label.length).toBeGreaterThan(0)
  })

  test('a denied code exits 1 and stores nothing', async () => {
    const core = fakeCore({ polls: [{ status: 'denied' }] })
    const h = harness()
    const { code, err } = await h.run(['login', '--core', core.url])
    expect(code).toBe(1)
    expect(err).toContain('denied')
    expect(existsSync(h.configPath)).toBe(false)
  })

  test('an expired code exits 1 with the next step and stores nothing', async () => {
    const core = fakeCore({ polls: [{ status: 'expired' }] })
    const h = harness()
    const { code, err } = await h.run(['login', '--core', core.url])
    expect(code).toBe(1)
    expect(err).toContain('✕ The code expired. Run `keith login` again.')
    expect(existsSync(h.configPath)).toBe(false)
  })

  test('cancelling (the process signal) exits 130 and stores nothing', async () => {
    const core = fakeCore({ polls: [{ status: 'pending' }] })
    const controller = new AbortController()
    const h = harness({ signal: controller.signal })
    setTimeout(() => controller.abort(), 60)
    const { code, err } = await h.run(['login', '--core', core.url])
    expect(code).toBe(130)
    expect(err).toContain('Cancelled')
    expect(existsSync(h.configPath)).toBe(false)
  })

  test('a unix: core is refused (the socket needs no login)', async () => {
    const h = harness()
    const { code, err } = await h.run(['login', '--core', 'unix:/x.sock'])
    expect(code).toBe(2)
    expect(err).toContain('no login')
  })
})

describe('keith login --token', () => {
  test('a checked token is stored 0600, never echoed, and the line names the person', async () => {
    const h = harness()
    const core = fakeCore()
    const { code, out, err } = await h.run(
      ['login', '--token', '--core', core.url],
      'keith_s_pasted\n',
    )
    expect(code).toBe(0)
    expect(readClientConfig(h.configPath)).toEqual({ core: core.url, token: 'keith_s_pasted' })
    expect(statSync(h.configPath).mode & 0o777).toBe(0o600)
    expect(out + err).not.toContain('keith_s_pasted')
    expect(out).toContain(`✓ Logged in to ${core.url} as Ana.`)
  })

  test('a refused token keeps the previous client.json byte for byte and exits 1', async () => {
    const h = harness()
    const core = fakeCore({ revoked: true })
    writeFileSync(h.configPath, '{"core":"http://old:1","token":"keith_s_old"}\n')
    const before = readFileSync(h.configPath, 'utf8')
    const { code, err } = await h.run(['login', '--token', '--core', core.url], 'keith_s_typo\n')
    expect(code).toBe(1)
    expect(err).toContain('did not accept that credential; nothing was saved')
    expect(readFileSync(h.configPath, 'utf8')).toBe(before)
  })

  test('an unreachable core refuses unless --no-check is given', async () => {
    const h = harness()
    const refused = await h.run(['login', '--token', '--core', 'http://127.0.0.1:1'], 'keith_s_x\n')
    expect(refused.code).toBe(1)
    expect(existsSync(h.configPath)).toBe(false)
    const saved = await h.run(
      ['login', '--token', '--no-check', '--core', 'http://127.0.0.1:1'],
      'keith_s_x\n',
    )
    expect(saved.code).toBe(0)
    expect(readClientConfig(h.configPath)?.token).toBe('keith_s_x')
    expect(saved.out).toContain('✓ Logged in to http://127.0.0.1:1.')
  })

  test('no input is a usage error and writes nothing', async () => {
    const h = harness()
    const io = fakeIo()
    io.end()
    const code = await runCli({
      program: 'keith',
      version: '0',
      commands: keithCommands({
        configPath: h.configPath,
        dataDir: h.dir,
        startChat: async () => 0,
      }),
      argv: ['login', '--token'],
      io,
    })
    expect(code).toBe(2)
    expect(existsSync(h.configPath)).toBe(false)
  })
})

describe('keith login --password', () => {
  test('without --remember the file has no remember flag and the line says it is for scripts', async () => {
    const core = fakeCore()
    const h = harness()
    const { code, out } = await h.run(
      ['login', '--password', '--username', 'ana', '--core', core.url],
      'correct-horse-9\n',
    )
    expect(code).toBe(0)
    expect(readClientConfig(h.configPath)).toEqual({ core: core.url, token: 'keith_s_pw' })
    expect(out).toContain('Saved for scripts and `keith whoami`')
    expect(out).not.toContain('Run keith to start.')
    expect(core.calls.some((c) => c.path === '/auth/flow/f1')).toBe(false)
  })

  test('with --remember the file holds remember: true and the line says to run keith', async () => {
    const core = fakeCore()
    const h = harness()
    const { code, out } = await h.run(
      ['login', '--password', '--remember', '--username', 'ana', '--core', core.url],
      'correct-horse-9\n',
    )
    expect(code).toBe(0)
    expect(readClientConfig(h.configPath)).toEqual({
      core: core.url,
      token: 'keith_s_remembered',
      remember: true,
    })
    expect(out).toContain('Run keith to start.')
    const answer = core.calls.find((c) => c.path === '/auth/flow/f1')
    expect(answer?.body).toMatchObject({ method: 'password', remember: true })
  })

  test('--remember with a device code is a usage error and writes nothing', async () => {
    const core = fakeCore()
    const h = harness()
    const { code, err } = await h.run(['login', '--device', '--remember', '--core', core.url])
    expect(code).toBe(2)
    expect(err).toContain('a device code and a pasted token cannot be remembered')
    expect(existsSync(h.configPath)).toBe(false)
    expect(core.calls).toHaveLength(0)
  })
})

describe('keith login replaces the login it replaces', () => {
  test('a new login revokes the old credential on its core, once', async () => {
    const core = fakeCore()
    const h = harness()
    writeClientConfig({ core: core.url, token: 'keith_s_old' }, h.configPath)
    const { code, err } = await h.run(
      ['login', '--password', '--username', 'ana', '--core', core.url],
      'correct-horse-9\n',
    )
    expect(code).toBe(0)
    expect(err).toBe('')
    expect(readClientConfig(h.configPath)?.token).toBe('keith_s_pw')
    const revokes = core.calls.filter((c) => c.path === '/rpc/auth/logout')
    expect(revokes).toHaveLength(1)
    expect(revokes[0]?.auth).toBe('Bearer keith_s_old')
  })

  test('the same credential written twice revokes nothing', async () => {
    const core = fakeCore()
    const h = harness()
    writeClientConfig({ core: core.url, token: 'keith_s_pw' }, h.configPath)
    expect(
      (
        await h.run(
          ['login', '--password', '--username', 'ana', '--core', core.url],
          'correct-horse-9\n',
        )
      ).code,
    ).toBe(0)
    expect(core.calls.some((c) => c.path === '/rpc/auth/logout')).toBe(false)
  })

  test('an unreachable old core keeps the new login and says how to revoke the old one', async () => {
    const core = fakeCore()
    const h = harness()
    writeClientConfig({ core: 'http://127.0.0.1:1', token: 'keith_s_old' }, h.configPath)
    const { code, err } = await h.run(
      ['login', '--password', '--username', 'ana', '--core', core.url],
      'correct-horse-9\n',
    )
    expect(code).toBe(0)
    expect(err).toContain(
      'could not revoke the previous login on http://127.0.0.1:1: keith-core devices revoke <id>',
    )
    expect(readClientConfig(h.configPath)).toEqual({ core: core.url, token: 'keith_s_pw' })
  })
})

describe('keith (no subcommand)', () => {
  test('opens Home; keith chat opens the chat; without startHome Home falls back to the chat', async () => {
    const homes: Connection[] = []
    const h = harness({
      startHome: async (c) => {
        homes.push(c)
        return 0
      },
    })
    expect((await h.run(['--core', 'http://localhost:9'])).code).toBe(0)
    expect(homes).toHaveLength(1)
    expect(h.chats).toHaveLength(0)
    expect((await h.run(['chat', '--core', 'http://localhost:9'])).code).toBe(0)
    expect(h.chats).toHaveLength(1)
    const plain = harness()
    expect((await plain.run(['--core', 'http://localhost:9'])).code).toBe(0)
    expect(plain.chats).toHaveLength(1)
  })
})

describe('keith logout', () => {
  test('revokes the credential on the core, then deletes the login', async () => {
    const core = fakeCore()
    const h = harness()
    writeClientConfig({ core: core.url, token: 'keith_s_me' }, h.configPath)
    const { code, out } = await h.run(['logout'])
    expect(code).toBe(0)
    expect(out).toContain(`✓ Logged out of ${core.url}. This device's credential is revoked.`)
    const logout = core.calls.find((c) => c.path === '/rpc/auth/logout')
    expect(logout?.auth).toBe('Bearer keith_s_me')
    expect(existsSync(h.configPath)).toBe(false)
  })

  test('an unreachable or failing core still forgets the token locally, with one warning and no "revoked"', async () => {
    const core = fakeCore({ logoutFails: true })
    const h = harness()
    writeClientConfig({ core: core.url, token: 'keith_s_me' }, h.configPath)
    const { code, out, err } = await h.run(['logout'])
    expect(code).toBe(0)
    expect(err).toContain('the core could not be reached, so the credential is still valid there')
    expect(err).toContain('keith-core devices revoke')
    expect(out + err).not.toContain('is revoked')
    expect(existsSync(h.configPath)).toBe(false)
  })

  test('an already revoked credential is fine; with no login it says so', async () => {
    const core = fakeCore({ revoked: true })
    const h = harness()
    writeClientConfig({ core: core.url, token: 'keith_s_me' }, h.configPath)
    expect((await h.run(['logout'])).code).toBe(0)
    expect(existsSync(h.configPath)).toBe(false)
    const again = await h.run(['logout'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('Not logged in.')
  })
})

describe('keith whoami', () => {
  test('prints person, core, via and credential kind', async () => {
    const core = fakeCore()
    const h = harness()
    writeClientConfig({ core: core.url, token: 'keith_s_me' }, h.configPath)
    const { code, out } = await h.run(['whoami'])
    expect(code).toBe(0)
    expect(out).toContain('Ana (owner, owner)')
    expect(out).toContain(core.url)
    expect(out).toMatch(/via\s+tcp/)
    expect(out).toMatch(/credential\s+device/)
  })

  test('a revoked credential says to log in again (exit 1)', async () => {
    const core = fakeCore({ revoked: true })
    const h = harness()
    writeClientConfig({ core: core.url, token: 'keith_s_me' }, h.configPath)
    const { code, err } = await h.run(['whoami'])
    expect(code).toBe(1)
    expect(err).toContain('Logged out or revoked. Run `keith login`.')
  })

  test('with no core at all it prints the guidance (exit 1)', async () => {
    const h = harness()
    const { code, err } = await h.run(['whoami'])
    expect(code).toBe(1)
    expect(err).toContain('No core found. On the core machine run `keith-core start`')
    expect(err).toContain('keith login --core <url>')
  })

  test('over the local socket there is no credential', async () => {
    const dir = tmp()
    const path = join(dir, 'core.sock')
    const server = Bun.serve({
      unix: path,
      fetch: () =>
        Response.json({
          json: {
            personId: 'owner',
            name: 'Owner',
            role: 'owner',
            via: 'local',
            credentialKind: null,
          },
        }),
    })
    servers.push(server)
    const h = harness({ dataDir: dir, probe: async () => true })
    const { code, out } = await h.run(['whoami'])
    expect(code).toBe(0)
    expect(out).toContain(`unix:${path}`)
    expect(out).toMatch(/via\s+local/)
    expect(out).toContain('none (local socket)')
  })
})

describe('keith (chat)', () => {
  test('the bare command and --core open the chat on the resolved connection', async () => {
    const h = harness({ probe: async () => true })
    expect((await h.run([])).code).toBe(0)
    expect(h.chats[0]).toMatchObject({ kind: 'socket', source: 'socket' })
    await h.run(['--core', 'http://other:9'])
    expect(h.chats[1]).toMatchObject({ kind: 'http', url: 'http://other:9', source: 'flag' })
  })

  test('with no core it prints the guidance and does not start', async () => {
    const h = harness()
    const { code, err } = await h.run([])
    expect(code).toBe(1)
    expect(err).toContain('No core found.')
    expect(h.chats).toEqual([])
  })

  test('manage opens the Manage screen on the resolved connection, not the chat', async () => {
    const managed: Connection[] = []
    const h = harness({
      probe: async () => true,
      startManage: async (c) => {
        managed.push(c)
        return 0
      },
    })
    expect((await h.run(['manage'])).code).toBe(0)
    expect(managed[0]).toMatchObject({ kind: 'socket', source: 'socket' })
    await h.run(['manage', '--core', 'http://other:9'])
    expect(managed[1]).toMatchObject({ kind: 'http', url: 'http://other:9', source: 'flag' })
    expect(h.chats).toEqual([])
  })

  test('manage with no core prints the guidance and does not start', async () => {
    const managed: Connection[] = []
    const h = harness({
      startManage: async (c) => {
        managed.push(c)
        return 0
      },
    })
    const { code, err } = await h.run(['manage'])
    expect(code).toBe(1)
    expect(err).toContain('No core found.')
    expect(managed).toEqual([])
  })

  test('--disable-orb is a flag of home and chat (their --help shows it)', async () => {
    const h = harness()
    expect((await h.run(['home', '--help'])).out).toContain('--disable-orb')
    expect((await h.run(['chat', '--help'])).out).toContain('--disable-orb')
  })

  test('--disable-orb reaches the config the app reads; without it the orb moves', async () => {
    const seen: boolean[] = []
    const saved = process.env.KEITH_DISABLE_ORB
    delete process.env.KEITH_DISABLE_ORB
    try {
      const h = harness({
        startHome: async () => {
          seen.push(loadConfig().motion.orbStatic)
          return 0
        },
      })
      expect((await h.run(['--core', 'http://core.test:7420'])).code).toBe(0)
      expect(seen).toEqual([false])
      expect((await h.run(['--disable-orb', '--core', 'http://core.test:7420'])).code).toBe(0)
      expect(seen).toEqual([false, true])
    } finally {
      if (saved === undefined) delete process.env.KEITH_DISABLE_ORB
      else process.env.KEITH_DISABLE_ORB = saved
    }
  })

  test('help lists chat, login, logout and whoami and nothing else', async () => {
    const h = harness()
    const { out } = await h.run(['--help'])
    for (const name of ['manage', 'login', 'logout', 'whoami']) expect(out).toContain(name)
    for (const gone of ['/connect', 'pair', 'provider', 'model']) expect(out).not.toContain(gone)
  })
})
