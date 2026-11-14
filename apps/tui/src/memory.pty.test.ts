import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeClientConfig } from '@keith/client'
import { pressUntil, until } from './testing/pty.ts'
import { VtScreen } from './testing/vt-screen.ts'

/**
 * Memory dreaming in the real TUI, against a real core (docs/specs/dreaming.md "TUI", P35.6.6). A member starts with the
 * default mode `off`: `/dream` shows it. `/dream mode propose` changes the person's own mode (a toast names it), and `/dream`
 * then shows `propose`. Me > Memory (the Memory row of `/persona style`) shows the same mode and nothing else of the memory.
 * No model call is made: the provider answers the model catalog only. Keys are sent with `pressUntil` (re-sent until the
 * screen shows the result), matching is on the screen the terminal shows (VtScreen). No sleep-based driving.
 */

const ptySupported = process.platform !== 'win32'
const ROOT = join(import.meta.dir, '..', '..', '..')
const CORE = join(ROOT, 'apps/core/src/cli.ts')
const TUI = join(import.meta.dir, 'cli.tsx')

/** Above bun's 5 s default: a core and a TUI start and answer a few screens. */
const TEST_TIMEOUT = 150_000

const OWNER_NAME = 'Rin'
const MEMBER = { username: 'nila', name: 'Nila', password: ['copper', 'harbor', '5520'].join('-') }
const OWNER_PIN = ['48', '29', '15'].join('')

const DOWN = '\u001b[B'
const ESC = '\u001b'

const CATALOG = {
  deepseek: {
    models: {
      smoke: {
        cost: { input: 0.27, output: 1.1 },
        limit: { context: 64_000, output: 8_000 },
      },
    },
  },
}

const procs: Array<{ kill(signal?: number): void; exited: Promise<number>; pid: number }> = []
const servers: Array<{ stop(force?: boolean): void }> = []
let home: string | undefined

afterEach(async () => {
  for (const proc of procs.splice(0)) {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      proc.kill()
    }
    await Promise.race([proc.exited, Bun.sleep(3000)])
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const server of servers.splice(0)) server.stop(true)
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/** The environment of a child: no CI markers (Ink prints only a last frame when it thinks it is in CI). */
function childEnv(extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...extra })) {
    if (v === undefined || k === 'CI' || k === 'CONTINUOUS_INTEGRATION' || k.startsWith('CI_'))
      continue
    env[k] = v
  }
  return env
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = server.port as number
  server.stop(true)
  return port
}

/** A catalog-only endpoint: the core reads the model list and the priced catalog, and no chat call is made here. */
function catalogServer(): string {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname.endsWith('/models'))
        return Response.json({ object: 'list', data: [{ id: 'smoke', object: 'model' }] })
      if (pathname === '/api.json') return Response.json(CATALOG)
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

/** One command of `keith-core` (or of the TUI binary) to the end, with an optional stdin (a PIN or a passphrase). */
async function coreCommand(
  env: Record<string, string>,
  args: string[],
  stdin?: string,
  script = CORE,
): Promise<string> {
  const proc = Bun.spawn(['bun', script, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin === undefined ? 'ignore' : new Blob([`${stdin}\n`]),
    timeout: 60_000,
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${script} ${args.join(' ')} exited ${code}:\n${out}${err}`)
  return out + err
}

interface Tui {
  name: string
  proc: ReturnType<typeof Bun.spawn>
  /** What the terminal shows now (the grid, plain text). */
  screen(): string
}

/** The TUI in a real pseudo-terminal; the terminal is drained at once (see `launch` in `pty.ts`). */
function spawnTui(name: string, env: Record<string, string>, args: string[]): Tui {
  const cols = 100
  const rows = 30
  const vt = new VtScreen(cols, rows)
  const proc = Bun.spawn(['bun', TUI, ...args], {
    env,
    terminal: {
      cols,
      rows,
      data: (_t, data) => vt.feed(data),
    },
  })
  procs.push(proc)
  return { name, proc, screen: () => vt.text() }
}

/**
 * Wait until `check` holds on the screen. The audit notice of a first sign-in (P23 §6) covers the screen until
 * acknowledged: `ack` answers it with Enter, at most every 1.5 s.
 */
async function waitFor(
  tui: Tui,
  check: (screen: string) => boolean,
  what: string,
  { ack = false, ms = 25_000 } = {},
): Promise<void> {
  let last = 0
  await until(
    () => {
      if (ack && tui.screen().includes('[enter] got it') && Date.now() - last > 1500) {
        tui.proc.terminal?.write('\r')
        last = Date.now()
      }
      return check(tui.screen())
    },
    ms,
    `${tui.name}: ${what}`,
    () => tui.screen(),
  )
}

/**
 * Type a line and wait until it shows on an input row (the row starts with the prompt mark or nothing). A key written
 * too early can be dropped: the text is written again until it shows.
 */
async function typeLine(tui: Tui, text: string): Promise<void> {
  const row = new RegExp(`^[ ›]*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(│.*)?$`, 'm')
  let last = 0
  await until(
    () => {
      if (Date.now() - last > 1500 && !row.test(tui.screen())) {
        tui.proc.terminal?.write(text)
        last = Date.now()
      }
      return row.test(tui.screen())
    },
    20_000,
    `${tui.name}: typed "${text}"`,
    () => tui.screen(),
  )
}

describe.skipIf(!ptySupported)('memory dreaming in the real TUI, against a real core', () => {
  test(
    '/dream shows the mode; /dream mode propose changes it; the Me > Memory screen shows the same mode',
    async () => {
      const providerUrl = catalogServer()
      home = realpathSync(mkdtempSync(join(tmpdir(), 'keith-memory-pty-')))
      const dataDir = join(home, 'data')
      mkdirSync(dataDir)
      const port = await freePort()
      const coreUrl = `http://127.0.0.1:${port}`
      const base = childEnv({
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        LANG: process.env.LANG ?? 'C.UTF-8',
        KEITH_DATA_DIR: dataDir,
        KEITH_PORT: String(port),
        KEITH_BUILD_SHA: 'memory-pty',
        KEITH_PUBLIC_URL: coreUrl,
        DEEPSEEK_API_KEY: ['sk', 'memory', crypto.randomUUID().replaceAll('-', '')].join('-'),
        DEEPSEEK_BASE_URL: providerUrl,
        KEITH_MODELS_DEV_URL: `${providerUrl}/api.json`,
      })

      // the owner: setup, the local socket trusted in full, a member with a password
      await coreCommand(
        base,
        [
          'setup',
          '--non-interactive',
          '--owner-name',
          OWNER_NAME,
          '--provider',
          'deepseek',
          '--front-model',
          'smoke',
          '--cortex-model',
          'smoke',
          '--budget',
          '5',
          '--access',
          'local',
          '--owner-pin-stdin',
        ],
        OWNER_PIN,
      )
      // the core's output is drained: a full pipe would block the core in the middle of a write
      let coreOut = ''
      const core = Bun.spawn(['bun', CORE, 'start'], {
        env: base,
        detached: true,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
      procs.push(core)
      for (const stream of [core.stdout, core.stderr]) {
        void (async () => {
          const decoder = new TextDecoder()
          for await (const part of stream as ReadableStream<Uint8Array>)
            coreOut += decoder.decode(part)
        })()
      }
      const healthy = (): Promise<boolean> =>
        fetch(`${coreUrl}/health`)
          .then((r) => r.ok)
          .catch(() => false)
      const up = Date.now()
      while (!(await healthy())) {
        if (Date.now() - up > 25_000) throw new Error(`the core never came up:\n${coreOut}`)
        if (core.exitCode !== null) throw new Error(`the core exited ${core.exitCode}:\n${coreOut}`)
        await Bun.sleep(50)
      }
      await coreCommand(base, ['auth', 'local', 'set', '--trust', 'full', '--yes'], OWNER_PIN)
      await coreCommand(base, ['people', 'add', MEMBER.username, '--name', MEMBER.name])
      await coreCommand(
        base,
        ['people', 'passwd', MEMBER.username, '--password-stdin'],
        MEMBER.password,
      )

      const memberFile = join(home, 'member-client.json')
      const memberEnv = childEnv({
        HOME: home,
        KEITH_CLIENT_CONFIG: memberFile,
        NO_COLOR: '1',
      })
      await coreCommand(
        memberEnv,
        ['login', '--password-stdin', '--username', MEMBER.username, '--core', coreUrl],
        MEMBER.password,
        TUI,
      )
      assert((statSync(memberFile).mode & 0o777) === 0o600, 'the member client.json is not 0600')
      // the interactive app uses only a saved login marked "remember this device" (as in persona.pty.test.ts)
      const saved = JSON.parse(readFileSync(memberFile, 'utf8')) as { token?: string }
      assert(
        saved.token?.startsWith('keith_s_') === true,
        'the member client.json holds no credential',
      )
      writeClientConfig({ core: coreUrl, token: saved.token, remember: true }, memberFile)

      const member = spawnTui('member', memberEnv, ['chat'])
      await waitFor(member, (s) => s.includes('type a message, or /help'), 'the member chat', {
        ack: true,
      })

      // 1. the default mode of a member is off
      await typeLine(member, '/dream')
      member.proc.terminal?.write('\r')
      await waitFor(member, (s) => s.includes('Dreaming: off'), 'the status shows off')

      // 2. the member sets propose; the toast names it, and /dream shows it
      await typeLine(member, '/dream mode propose')
      await pressUntil(member, '\r', (s) => s.includes('Dreaming mode: propose.'), 'the mode toast')
      expect(member.screen()).toContain('Dreaming mode: propose.')
      await typeLine(member, '/dream')
      member.proc.terminal?.write('\r')
      await waitFor(member, (s) => s.includes('Dreaming: propose'), 'the status shows propose')
      expect(member.screen()).toContain('Dreaming: propose')

      // 3. Me > Memory: the Memory row of the style screen opens the memory screen, which shows the same mode
      await typeLine(member, '/persona style')
      await pressUntil(member, '\r', (s) => /› Address/.test(s), 'the Me screen')
      // nine rows down; pressUntil repeats a key every 2.5 s, so this call needs more than its default 20 s
      await pressUntil(member, DOWN, (s) => /› Memory:/.test(s), 'the Memory row', {
        timeoutMs: 60_000,
      })
      await pressUntil(member, '\r', (s) => s.includes('Mode: propose'), 'the Memory screen')
      expect(member.screen()).toContain('Mode: propose')
      await pressUntil(member, ESC, (s) => s.includes('type a message'), 'the chat again')
    },
    TEST_TIMEOUT,
  )
})

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}
