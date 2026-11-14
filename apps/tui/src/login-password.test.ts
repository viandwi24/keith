import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '@keith/cli'
import { fakeIo } from '@keith/cli/testing'
import { readClientConfig } from '@keith/client'
import { keithCommands } from './commands.tsx'

const dirs: string[] = []
const servers: Array<{ stop(force?: boolean): unknown }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Mode = 'ok' | 'invalid' | 'throttled' | 'not_allowed'

/** A core with `/auth/login`, `/auth/device/*` and whoami for a member. */
function core(mode: Mode) {
  const calls: Array<{ path: string; body?: unknown }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body = await req.json().catch(() => undefined)
      calls.push({ path, body })
      if (path === '/auth/login') {
        if (mode === 'invalid') return Response.json({ error: 'invalid' }, { status: 401 })
        if (mode === 'throttled')
          return Response.json({}, { status: 429, headers: { 'retry-after': '37' } })
        if (mode === 'not_allowed')
          return Response.json({ error: 'login_not_allowed_here' }, { status: 403 })
        return Response.json({ credential: 'keith_s_pw1' })
      }
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
            personId: 'ana-id',
            name: 'Ana',
            username: 'ana',
            role: 'member',
            via: 'tcp',
            credentialKind: 'device',
            elevated: false,
          },
        })
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return { url: `http://localhost:${server.port}`, calls }
}

function run(argv: string[], io = fakeIo(), stdin?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'keith-login-'))
  dirs.push(dir)
  const configPath = join(dir, 'client.json')
  if (stdin !== undefined) io.send(stdin)
  return runCli({
    program: 'keith',
    version: '0.0.0',
    commands: keithCommands({
      configPath,
      dataDir: dir,
      startChat: async () => 0,
      pollMs: 5,
      probe: async () => false,
    }),
    defaultCommand: 'chat',
    argv,
    io,
  }).then((code) => ({ code, out: io.out(), err: io.err(), configPath }))
}

describe('keith login --password', () => {
  test('--username and a piped password: stores the credential and prints person and role', async () => {
    const c = core('ok')
    const { code, out, err, configPath } = await run(
      ['login', '--password', '--username', 'ana', '--core', c.url],
      fakeIo(),
      'correct horse battery\n',
    )
    expect(code).toBe(0)
    expect(out).toContain(`✓ Logged in to ${c.url} as ana (member).`)
    expect(out + err).not.toContain('correct horse')
    expect(readClientConfig(configPath)).toEqual({ core: c.url, token: 'keith_s_pw1' })
    const login = c.calls.find((x) => x.path === '/auth/login')
    expect(login?.body).toMatchObject({ username: 'ana', password: 'correct horse battery' })
  })

  test('asks for the username when it is not given (username, then password on piped stdin)', async () => {
    const c = core('ok')
    const { code, out } = await run(
      ['login', '--password-stdin', '--core', c.url],
      fakeIo(),
      'ana\nsecret-secret\n',
    )
    expect(code).toBe(0)
    expect(out).toContain('as ana (member)')
  })

  test('a wrong username or password is one uniform line and stores nothing', async () => {
    const c = core('invalid')
    const { code, err, configPath } = await run(
      ['login', '--password', '--username', 'ana', '--core', c.url],
      fakeIo(),
      'nope\n',
    )
    expect(code).toBe(1)
    expect(err).toContain('✕ Wrong username or password.')
    expect(existsSync(configPath)).toBe(false)
  })

  test('throttled says how long to wait', async () => {
    const c = core('throttled')
    const { code, err } = await run(
      ['login', '--password', '--username', 'ana', '--core', c.url],
      fakeIo(),
      'nope\n',
    )
    expect(code).toBe(1)
    expect(err).toContain('Too many attempts. Try again in 37 s.')
  })

  test('from a network the core does not accept, it points to the device code', async () => {
    const c = core('not_allowed')
    const { code, err } = await run(
      ['login', '--password', '--username', 'ana', '--core', c.url],
      fakeIo(),
      'nope\n',
    )
    expect(code).toBe(1)
    expect(err).toContain(
      'Password login is only allowed from this machine, Tailscale, or tailscale serve. Use a device code instead.',
    )
    expect(err).toContain('Use a device code instead.')
  })

  test('--password with --device or --token is a usage error', async () => {
    expect((await run(['login', '--password', '--device', '--core', 'http://x:1'])).code).toBe(2)
    expect((await run(['login', '--password', '--token', '--core', 'http://x:1'])).code).toBe(2)
  })
})

describe('keith login method selection', () => {
  test('on a terminal without a flag it asks Password or Device code (password picked)', async () => {
    const c = core('ok')
    const io = fakeIo({ tty: true })
    const pending = run(['login', '--core', c.url], io)
    await Bun.sleep(30)
    expect(io.out()).toContain('How do you want to log in?')
    expect(io.out()).toContain('Password')
    expect(io.out()).toContain('Device code')
    io.send('\r') // Password is the default
    await Bun.sleep(30)
    io.send('ana\r')
    await Bun.sleep(30)
    io.send('pw-pw-pw-pw\r')
    const { code, out } = await pending
    expect(code).toBe(0)
    expect(out).toContain('as ana (member)')
  })

  test('picking Device code runs the device flow', async () => {
    const c = core('ok')
    const io = fakeIo({ tty: true })
    const pending = run(['login', '--core', c.url], io)
    await Bun.sleep(30)
    io.send('\u001b[B\r') // down, enter
    const { code, out } = await pending
    expect(code).toBe(0)
    expect(out).toContain('keith-core devices approve ABCD-EFGH')
  })

  test('--device skips the question, and without a terminal the device code is the default', async () => {
    const c = core('ok')
    const flagged = await run(['login', '--device', '--core', c.url], fakeIo({ tty: true }))
    expect(flagged.code).toBe(0)
    expect(flagged.out).not.toContain('How do you want to log in?')
    const piped = await run(['login', '--core', c.url])
    expect(piped.out).toContain('keith-core devices approve')
  })
})
