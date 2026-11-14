import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '@keith/cli'
import { fakeIo } from '@keith/cli/testing'
import { readClientConfig, writeClientConfig } from '@keith/client'
import { keithCommands } from './commands.tsx'
import type { Connection } from './connection.ts'

const dirs: string[] = []
const servers: Array<{ stop(force?: boolean): unknown }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A core that accepts a password login, a device code and answers whoami. */
function core(): string {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/auth/login') return Response.json({ credential: 'keith_s_pw' })
      if (path === '/auth/device/start')
        return Response.json({
          code: 'ABCD-EFGH',
          requestId: 'r1',
          expiresAt: Date.now() + 600_000,
          pollSecret: 'ps',
        })
      if (path === '/auth/device/poll')
        return Response.json({ status: 'approved', credential: 'keith_s_dev' })
      if (path === '/rpc/auth/whoami')
        return Response.json({
          json: {
            personId: 'ana',
            name: 'Ana',
            username: 'ana',
            role: 'owner',
            via: 'tcp',
            credentialKind: 'device',
            elevated: false,
          },
        })
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return `http://localhost:${server.port}`
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'keith-choice-'))
  dirs.push(dir)
  const configPath = join(dir, 'client.json')
  const screens: Connection[] = []
  const chats: Connection[] = []
  const run = async (
    argv: string[],
    opts: { tty: boolean; input?: string[]; screen?: boolean },
  ) => {
    const io = fakeIo({ tty: opts.tty })
    const pending = runCli({
      program: 'keith',
      version: '0.0.0',
      defaultCommand: 'home',
      argv,
      io,
      commands: keithCommands({
        configPath,
        dataDir: dir,
        pollMs: 5,
        probe: async () => false,
        startManage: async () => 0,
        startChat: async (c: Connection) => {
          chats.push(c)
          return 0
        },
        ...(opts.screen === false
          ? {}
          : {
              startLogin: async (c: Connection) => {
                screens.push(c)
                return 0
              },
            }),
      }),
    })
    for (const line of opts.input ?? []) {
      await Bun.sleep(30)
      io.send(line)
    }
    return { code: await pending, out: io.out(), err: io.err() }
  }
  return { run, screens, chats, configPath }
}

describe('which `keith login` invocations open the Sign in screen', () => {
  test('a terminal and no flag opens it, on the default address', async () => {
    const h = harness()
    const r = await h.run(['login'], { tty: true })
    expect(r.code).toBe(0)
    expect(h.screens).toEqual([{ kind: 'http', url: 'http://localhost:7420', source: 'flag' }])
    expect(r.out).toBe('')
  })

  test('--core alone prefills the address; a saved login of that core is not used (the screen is for signing in)', async () => {
    const h = harness()
    writeClientConfig({ core: 'https://a.example', token: 'keith_s_old' }, h.configPath)
    await h.run(['login', '--core', 'https://a.example/'], { tty: true })
    expect(h.screens).toEqual([{ kind: 'http', url: 'https://a.example', source: 'flag' }])
  })

  test('with no flag the stored core is the address', async () => {
    const h = harness()
    writeClientConfig({ core: 'https://b.example', token: 'keith_s_b' }, h.configPath)
    await h.run(['login'], { tty: true })
    expect(h.screens[0]).toMatchObject({ url: 'https://b.example' })
  })

  test('--core unix:<path> is still a usage error', async () => {
    const h = harness()
    const r = await h.run(['login', '--core', 'unix:/x.sock'], { tty: true })
    expect(r.code).toBe(2)
    expect(h.screens).toEqual([])
  })

  test('without a terminal it stays the text command (device code)', async () => {
    const h = harness()
    const r = await h.run(['login', '--core', core()], { tty: false })
    expect(r.code).toBe(0)
    expect(h.screens).toEqual([])
    expect(r.out).toContain('keith-core devices approve ABCD-EFGH')
    expect(readClientConfig(h.configPath)?.token).toBe('keith_s_dev')
  })

  test('a host with no screen keeps the text command on a terminal too', async () => {
    const h = harness()
    const r = await h.run(['login', '--device', '--core', core()], { tty: true, screen: false })
    expect(r.code).toBe(0)
    expect(r.out).toContain('keith-core devices approve')
  })

  test('--device on a terminal stays text', async () => {
    const h = harness()
    const r = await h.run(['login', '--device', '--core', core()], { tty: true })
    expect(h.screens).toEqual([])
    expect(r.out).toContain('keith-core devices approve ABCD-EFGH')
    expect(r.out).not.toContain('How do you want to log in?')
  })

  test('--token on a terminal stays the hidden prompt', async () => {
    const h = harness()
    const r = await h.run(['login', '--token', '--core', core()], {
      tty: true,
      input: ['keith_s_typed\r'],
    })
    expect(h.screens).toEqual([])
    expect(r.code).toBe(0)
    expect(readClientConfig(h.configPath)?.token).toBe('keith_s_typed')
  })

  test('--password and --username on a terminal stay the text prompts', async () => {
    const a = harness()
    const typed = await a.run(['login', '--password', '--core', core()], {
      tty: true,
      input: ['ana\r', 'pw-pw-pw-pw\r'],
    })
    expect(a.screens).toEqual([])
    expect(typed.code).toBe(0)
    expect(typed.out).toContain('as ana')
    const b = harness()
    const named = await b.run(['login', '--username', 'ana', '--core', core()], {
      tty: true,
      input: ['pw-pw-pw-pw\r'],
    })
    expect(b.screens).toEqual([])
    expect(named.code).toBe(0)
  })

  test('--label (a device name only the text flow uses) keeps the question', async () => {
    const h = harness()
    const r = await h.run(['login', '--label', 'desk', '--core', core()], {
      tty: true,
      input: ['\u001b[B\r'],
    })
    expect(h.screens).toEqual([])
    expect(r.out).toContain('How do you want to log in?')
  })
})

describe('`keith` with no core found', () => {
  for (const argv of [[], ['chat'], ['manage']]) {
    const name = argv.length === 0 ? 'keith' : `keith ${argv[0]}`
    test(`${name} on a terminal opens the Sign in screen on the default address`, async () => {
      const h = harness()
      const r = await h.run(argv, { tty: true })
      expect(r.code).toBe(0)
      expect(h.screens).toEqual([{ kind: 'http', url: 'http://localhost:7420', source: 'flag' }])
      expect(h.chats).toEqual([])
      expect(r.err).toBe('')
    })

    test(`${name} without a terminal prints the guidance (exit 1)`, async () => {
      const h = harness()
      const r = await h.run(argv, { tty: false })
      expect(r.code).toBe(1)
      expect(r.err).toContain('No core found.')
      expect(h.screens).toEqual([])
    })
  }

  test('a remembered login keeps the old path: the app opens signed in', async () => {
    const h = harness()
    writeClientConfig(
      { core: 'https://a.example', token: 'keith_s_old', remember: true },
      h.configPath,
    )
    await h.run([], { tty: true })
    expect(h.screens).toEqual([])
    expect(h.chats[0]).toMatchObject({ url: 'https://a.example', source: 'file' })
  })

  test('a saved login that was not remembered is never used: the app opens signed out on its core, with no token', async () => {
    const h = harness()
    writeClientConfig({ core: 'https://a.example', token: 'keith_s_old' }, h.configPath)
    for (const argv of [[], ['chat'], ['manage'], ['--core', 'https://a.example']]) {
      h.screens.length = 0
      h.chats.length = 0
      await h.run(argv, { tty: true })
      // the app opens on the stored (or named) core, signed out: Home with its sign-in panel, never a bare screen
      expect(h.screens).toEqual([])
      if (argv[0] !== 'manage')
        expect(h.chats[0]).toEqual({ kind: 'http', url: 'https://a.example', source: 'flag' })
    }
  })

  test('without a terminal the same saved login is still used (scripts, pipes)', async () => {
    const h = harness()
    writeClientConfig({ core: 'https://a.example', token: 'keith_s_old' }, h.configPath)
    await h.run([], { tty: false })
    expect(h.chats[0]).toMatchObject({ url: 'https://a.example', token: 'keith_s_old' })
  })

  test('--core keeps the old path', async () => {
    const h = harness()
    await h.run(['chat', '--core', 'https://b.example'], { tty: true })
    expect(h.screens).toEqual([])
    expect(h.chats[0]).toMatchObject({ url: 'https://b.example', source: 'flag' })
  })

  test('a bad --core is still a usage error', async () => {
    const h = harness()
    const r = await h.run(['--core', 'nope'], { tty: true })
    expect(r.code).toBe(2)
    expect(h.screens).toEqual([])
  })
})
