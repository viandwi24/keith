import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '@keith/cli'
import { fakeIo } from '@keith/cli/testing'
import { lockCommands } from './lock-commands.ts'

const dirs: string[] = []
const servers: Array<{ stop(force?: boolean): unknown }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
// built at runtime: fake secrets, never literals
const PIN = ['4', '8', '1', '5', '9', '2'].join('')

/** A core on a Unix socket that knows only the lock routes. */
function fakeSocket(options: { hasPin?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keith-lock-'))
  dirs.push(dir)
  const path = join(dir, 'core.sock')
  const state = { locked: false, unlocks: 0 }
  const server = Bun.serve({
    unix: path,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/health') return Response.json({ status: 'ok' })
      if (url.pathname === '/auth/local/lock') {
        if (options.hasPin === false)
          return Response.json({ error: 'no_pin', hint: 'set a PIN' }, { status: 409 })
        state.locked = true
        return Response.json({ locked: true })
      }
      if (url.pathname === '/auth/local/unlock') {
        const body = (await request.json()) as { pin?: string }
        if (body.pin !== PIN)
          return Response.json({ error: 'invalid_credentials' }, { status: 401 })
        state.locked = false
        state.unlocks += 1
        return Response.json({ locked: false })
      }
      return new Response('nope', { status: 404 })
    },
  })
  servers.push(server)
  return { path, state, dir }
}

async function run(argv: string[], socketPath: string, stdin?: string) {
  const io = fakeIo()
  if (stdin !== undefined) io.send(stdin)
  const code = await runCli({
    program: 'keith',
    version: '0.0.0',
    commands: lockCommands({ dataDir: dirs[0] ?? '', socketPath }),
    argv,
    io,
  })
  return { code, out: io.out(), err: io.err() }
}

describe('keith lock and keith unlock', () => {
  test('lock locks the socket; unlock asks for the PIN (hidden) and opens it', async () => {
    const core = fakeSocket()
    const locked = await run(['lock'], core.path)
    expect(locked.code).toBe(0)
    expect(core.state.locked).toBe(true)
    const wrong = await run(['unlock'], core.path, '000000\n')
    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain('Wrong PIN')
    const opened = await run(['unlock'], core.path, `${PIN}\n`)
    expect(opened.code).toBe(0)
    expect(opened.out).toContain('Unlocked')
    expect(opened.out + opened.err).not.toContain(PIN)
    expect(core.state.locked).toBe(false)
  })

  test('without a PIN lock says to set one; with no core it says to start it', async () => {
    const core = fakeSocket({ hasPin: false })
    const refused = await run(['lock'], core.path)
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('keith-core people pin')
    const none = await run(['lock'], join(core.dir, 'missing.sock'))
    expect(none.code).toBe(1)
    expect(none.err).toContain('keith-core start')
  })
})
