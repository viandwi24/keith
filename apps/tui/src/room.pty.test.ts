import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeClientConfig } from '@keith/client'
import { until } from './testing/pty.ts'
import { VtScreen } from './testing/vt-screen.ts'

/**
 * A room with Keith in the real TUI, against a real core. The core is the `keith-core` command
 * as a process (setup, start, people, auth), the provider is a scripted OpenAI-compatible endpoint
 * in this test process (every model call answers one fixed line, and can be held until released),
 * and two TUIs run in a pseudo-terminal: the owner over the local socket (full trust), and a
 * member logged in with its own `KEITH_CLIENT_CONFIG`. Matching is on the screen the terminal
 * shows (VtScreen) and on the stripped output for the moments that pass by (the indicator).
 */

const ptySupported = process.platform !== 'win32'
const ROOT = join(import.meta.dir, '..', '..', '..')
const CORE = join(ROOT, 'apps/core/src/cli.ts')
const TUI = join(import.meta.dir, 'cli.tsx')

/** Above bun's 5 s default: a core, two TUIs and a room turn take a while on a loaded laptop. */
const TEST_TIMEOUT = 150_000

/** The one line the scripted model answers to every call. */
const KEITH_LINE = 'Noted, the room is open.'
const OWNER_NAME = 'Rin'
const MEMBER = { username: 'ana', name: 'Ana', password: ['quartz', 'harbor', '7741'].join('-') }
const OWNER_PIN = ['48', '29', '15'].join('')

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

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
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

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

/** A streamed text completion of one fixed line (the shape `scripts/smoke/fake-provider.ts` uses). */
function textStream(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'chatcmpl-room',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'smoke',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
  return [
    sse(chunk({ role: 'assistant', content: '' })),
    ...text.split(' ').map((w, i) => sse(chunk({ content: `${i === 0 ? '' : ' '}${w}` }))),
    sse(chunk({}, 'stop')),
    sse({ ...chunk({}), choices: [], usage }),
    'data: [DONE]\n\n',
  ].join('')
}

/**
 * The scripted provider. `hold()` makes every model call wait until `release()`: the test sees
 * the indicator ("Keith is thinking") while the turn is open, then lets the answer through.
 */
function scriptedProvider(): { url: string; hold(): void; release(): void; calls(): number } {
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  let calls = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname.endsWith('/models'))
        return Response.json({ object: 'list', data: [{ id: 'smoke', object: 'model' }] })
      if (pathname === '/api.json') return Response.json(CATALOG)
      if (!pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      calls++
      await gate
      return new Response(textStream(KEITH_LINE), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  servers.push(server)
  return {
    url: `http://127.0.0.1:${server.port}`,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
    },
    release() {
      open?.()
      gate = undefined
    },
    calls: () => calls,
  }
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
  assert(code === 0, `${script} ${args.join(' ')} exited ${code}:\n${out}${err}`)
  return out + err
}

interface Tui {
  name: string
  proc: ReturnType<typeof Bun.spawn>
  /** What the terminal shows now (the grid, plain text). */
  screen(): string
  /** Every byte the terminal received, stripped of escape codes: moments that pass by stay visible. */
  seen(): string
}

/** The TUI in a real pseudo-terminal; the terminal is drained at once (see `launch` in `pty.ts`). */
function spawnTui(name: string, env: Record<string, string>, args: string[]): Tui {
  const cols = 100
  const rows = 30
  const vt = new VtScreen(cols, rows)
  const decoder = new TextDecoder()
  let raw = ''
  const proc = Bun.spawn(['bun', TUI, ...args], {
    env,
    terminal: {
      cols,
      rows,
      data: (_t, data) => {
        raw += decoder.decode(data, { stream: true })
        vt.feed(data)
      },
    },
  })
  procs.push(proc)
  return { name, proc, screen: () => vt.text(), seen: () => Bun.stripANSI(raw) }
}

/**
 * Wait until `check` holds on the screen. The audit notice of a first sign-in (P23 §6) covers
 * the screen until acknowledged: `ack` answers it with Enter, at most every 1.5 s.
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
 * Type a line and wait until it shows on an input row (the row starts with the prompt mark or nothing, so the banner's
 * `· /room` does not count). A key written too early can be dropped: the text is written again until it shows.
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

/**
 * Press `key` until `check` holds. A privacy or audit notice on the way covers the screen until it is acknowledged with Enter,
 * so Enter answers it first (at most every 1.5 s, like `typeLine`).
 */
async function pressThrough(
  tui: Tui,
  key: string,
  check: (screen: string) => boolean,
  what: string,
): Promise<void> {
  let last = 0
  await until(
    () => {
      const screen = tui.screen()
      if (check(screen)) return true
      if (Date.now() - last > 1500) {
        tui.proc.terminal?.write(screen.includes('[enter] got it') ? '\r' : key)
        last = Date.now()
      }
      return false
    },
    20_000,
    `${tui.name}: ${what}`,
    () => tui.screen(),
  )
}

/** Count the Keith lines on a screen. */
const keithLines = (screen: string): number => screen.split(KEITH_LINE).length - 1

describe.skipIf(!ptySupported)('a room in the real TUI, against a real core', () => {
  test(
    'the owner starts a room, a member accepts, both talk to Keith and see its answer',
    async () => {
      const provider = scriptedProvider()
      home = realpathSync(mkdtempSync(join(tmpdir(), 'keith-room-pty-')))
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
        KEITH_BUILD_SHA: 'room-pty',
        KEITH_PUBLIC_URL: coreUrl,
        DEEPSEEK_API_KEY: ['sk', 'room', crypto.randomUUID().replaceAll('-', '')].join('-'),
        DEEPSEEK_BASE_URL: provider.url,
        KEITH_MODELS_DEV_URL: `${provider.url}/api.json`,
      })

      // the owner: setup, the socket trusted in full (the owner needs no login), a member
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

      const ownerEnv = childEnv({
        HOME: home,
        KEITH_DATA_DIR: dataDir,
        KEITH_CLIENT_CONFIG: join(home, 'owner-client.json'),
        NO_COLOR: '1',
      })
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
      // the interactive app uses only a saved login marked "remember this device" (`keith login` does not mark it): the test
      // marks the member's credential as `pty.ts` does for the fake core
      const saved = JSON.parse(readFileSync(memberFile, 'utf8')) as { token?: string }
      assert(
        saved.token?.startsWith('keith_s_') === true,
        'the member client.json holds no credential',
      )
      writeClientConfig({ core: coreUrl, token: saved.token, remember: true }, memberFile)

      const owner = spawnTui('owner', ownerEnv, ['chat'])
      const member = spawnTui('member', memberEnv, [])
      await waitFor(owner, (s) => s.includes('type a message, or /help'), 'the owner chat', {
        ack: true,
      })

      // 1. the owner starts the room with Ana: the room view opens with Ana invited
      await typeLine(owner, '/room start ana')
      await pressThrough(
        owner,
        '\r',
        (s) => s.includes('Ana (invited)'),
        'the room view with Ana invited',
      )
      // the room's privacy notice (once per person) covers the screen until acknowledged
      await waitFor(owner, (s) => !s.includes('[enter] got it'), 'the privacy notice', {
        ack: true,
      })

      // 2. the owner leaves the room view for Home: the banner says the invitation is out
      await pressThrough(owner, '\u001b', (s) => s.includes('waiting for Ana'), 'the banner')
      expect(owner.screen()).toMatch(/Room "[^"]+" · waiting for Ana · \/room/)

      // 3. Ana sees the invitation on Home and accepts it with Enter: the room view opens
      await waitFor(
        member,
        (s) => s.includes('invites you to a room with Keith.'),
        'the invitation notice',
        { ack: true },
      )
      await pressThrough(
        member,
        '\r',
        (s) => s.includes('message the room'),
        'the room view of Ana',
      )

      // 4. the owner's banner turns active with Ana and Keith
      await waitFor(
        owner,
        (s) => /● Room "[^"]+" · .*Ana.*Keith · \/room/.test(s),
        'the active banner',
      )

      // 5. the owner opens the room and addresses Keith: the indicator shows on both screens while
      // the model is held, then the scripted answer reaches both
      // esc left the room view for Home (the view's origin): Enter opens the chat, where the command is typed
      await pressThrough(owner, '\r', (s) => s.includes('type a message'), 'the owner chat')
      await typeLine(owner, '/room')
      await pressThrough(owner, '\r', (s) => s.includes('message the room'), 'the owner room view')
      provider.hold()
      await typeLine(owner, '@keith who is in this room?')
      owner.proc.terminal?.write('\r')
      await waitFor(owner, (s) => s.includes('Keith is thinking'), 'the thinking indicator')
      await waitFor(member, (s) => s.includes('Keith is thinking'), 'the indicator for Ana')
      expect(owner.seen()).toContain('Keith is thinking')
      provider.release()
      await waitFor(owner, (s) => keithLines(s) >= 1, 'the answer on the owner screen')
      await waitFor(member, (s) => keithLines(s) >= 1, 'the answer on the member screen')

      // 6. Ana addresses Keith too: both see the second answer
      await typeLine(member, '@keith and what did I just miss?')
      member.proc.terminal?.write('\r')
      await waitFor(owner, (s) => keithLines(s) >= 2, 'the second answer on the owner screen')
      await waitFor(member, (s) => keithLines(s) >= 2, 'the second answer on the member screen')

      expect(provider.calls()).toBeGreaterThanOrEqual(2)
    },
    TEST_TIMEOUT,
  )
})
