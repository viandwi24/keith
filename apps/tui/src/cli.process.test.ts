import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FakeCore, startFakeCore } from './testing/fake-core.ts'

const cli = join(import.meta.dir, 'cli.tsx')
let home: string | undefined
let core: FakeCore | undefined
afterEach(() => {
  core?.stop()
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  core = undefined
  home = undefined
})

/** Run the real entry point (no terminal) with a private KEITH_HOME and no CI markers. */
async function keith(args: string[], stdin?: string) {
  home ??= mkdtempSync(join(tmpdir(), 'keith-proc-'))
  const env = Object.fromEntries(
    Object.entries({ ...process.env, HOME: home, KEITH_HOME: home }).filter(
      ([k]) => !k.startsWith('CI') && k !== 'KEITH_CLIENT_CONFIG' && k !== 'KEITH_DATA_DIR',
    ),
  ) as Record<string, string>
  const proc = Bun.spawn(['bun', cli, ...args], {
    env,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

test('`keith` with no login and no local core says where to look and exits 1', async () => {
  const { err, code } = await keith([])
  expect(code).toBe(1)
  expect(err).toContain('No core found. On the core machine run `keith-core start`')
})

test('`keith login --token`, `whoami` and `logout` work against a core, through the real entry', async () => {
  core = startFakeCore()
  const login = await keith(['login', '--token', '--core', core.url], 'keith_s_demo\n')
  expect(login.code).toBe(0)
  expect(login.out).toContain('Logged in to')
  const who = await keith(['whoami'])
  expect(who.code).toBe(0)
  expect(who.out).toContain('Owner (owner, owner)')
  expect(who.out).toMatch(/credential\s+token/)
  const out = await keith(['logout'])
  expect(out.code).toBe(0)
  expect(core.seen).toContain('POST /rpc/auth/logout')
  expect((await keith(['whoami'])).code).toBe(1)
})

test('--help and --version print and exit 0', async () => {
  const help = await keith(['--help'])
  expect(help.code).toBe(0)
  expect(help.out).toContain('login')
  expect((await keith(['--version'])).out).toContain('keith 0.1.0')
})
