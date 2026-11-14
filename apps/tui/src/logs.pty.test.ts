import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pressUntil, until } from './testing/pty.ts'
import { VtScreen } from './testing/vt-screen.ts'

/**
 * Manage > Logs in the real TUI, against a real core (activity-logs.md "TUI", P36.5.4). The owner chats once with the
 * scripted provider; the chat writes a front session with one generation. Then `keith manage` opens Logs: the sessions
 * list shows the session id (`front:`), the model and a cost; Enter drills into its generations, Enter again into the
 * generation (tokens, finish reason, messages sent) and `r` into the raw JSON, where the request holds the `prompt` key.
 * The provider is a scripted OpenAI-compatible endpoint in this test process. Keys are sent with `pressUntil`, matching is
 * on the screen the terminal shows (VtScreen). No sleep-based driving. Every process and directory is closed in `afterAll`.
 */

const ptySupported = process.platform !== 'win32'
const ROOT = join(import.meta.dir, '..', '..', '..')
const CORE = join(ROOT, 'apps/core/src/cli.ts')
const TUI = join(import.meta.dir, 'cli.tsx')

/** Above bun's 5 s default: a core, a chat turn and two TUIs take a while on a loaded laptop. */
const TEST_TIMEOUT = 150_000

const OWNER_NAME = 'Rin'
const OWNER_PIN = ['48', '29', '15'].join('')
/** The reply of the scripted provider: one line, streamed word by word. */
const REPLY = 'Logged reply from the scripted provider.'
const NOTE = 'hello logs'
const DOWN = '\u001b[B'
const PGDN = '\u001b[6~'

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

/** Stops the children (their group first), the scripted provider and the home directory. */
async function cleanup(): Promise<void> {
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
}

afterAll(cleanup)

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

/** A streamed text completion of one reply (the shape the context test uses). */
function textStream(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'chatcmpl-logs',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'smoke',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
  return [
    sse(chunk({ role: 'assistant', content: '' })),
    ...text.split(' ').map((w, i) => sse(chunk({ content: `${i === 0 ? '' : ' '}${w}` }))),
    sse(chunk({}, 'stop')),
    sse({ ...chunk({}), choices: [], usage }),
    'data: [DONE]\n\n',
  ].join('')
}

/** The scripted provider: the catalog, and a streamed reply to every chat completion. */
function scriptedProvider(): string {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname.endsWith('/models'))
        return Response.json({ object: 'list', data: [{ id: 'smoke', object: 'model' }] })
      if (pathname === '/api.json') return Response.json(CATALOG)
      if (!pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      await request.text()
      return new Response(textStream(REPLY), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

/** One command of `keith-core` to the end, with an optional stdin (a PIN). */
async function coreCommand(
  env: Record<string, string>,
  args: string[],
  stdin?: string,
): Promise<string> {
  const proc = Bun.spawn(['bun', CORE, ...args], {
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
  if (code !== 0) throw new Error(`keith-core ${args.join(' ')} exited ${code}:\n${out}${err}`)
  return out + err
}

interface Tui {
  name: string
  proc: ReturnType<typeof Bun.spawn>
  /** What the terminal shows now (the grid, plain text). */
  screen(): string
}

/** The TUI in a real pseudo-terminal; the terminal is drained at once. */
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
 * Wait until `check` holds on the screen. The audit notice of a first sign-in covers the screen until acknowledged:
 * `ack` answers it with Enter, at most every 1.5 s.
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
 * Type a line and wait until it shows on an input row. A key written too early can be dropped: the text is written
 * again until it shows.
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

describe.skipIf(!ptySupported)('manage Logs in the real TUI, against a real core', () => {
  test(
    'the owner chats once; Manage > Logs shows the session, its generation and the raw JSON',
    async () => {
      const providerUrl = scriptedProvider()
      home = realpathSync(mkdtempSync(join(tmpdir(), 'keith-logs-pty-')))
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
        KEITH_BUILD_SHA: 'logs-pty',
        KEITH_PUBLIC_URL: coreUrl,
        DEEPSEEK_API_KEY: ['sk', 'logs', crypto.randomUUID().replaceAll('-', '')].join('-'),
        DEEPSEEK_BASE_URL: providerUrl,
        KEITH_MODELS_DEV_URL: `${providerUrl}/api.json`,
      })

      // the owner: setup, then the local socket trusted in full (the owner TUI needs no login)
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

      const ownerEnv = childEnv({
        HOME: home,
        KEITH_DATA_DIR: dataDir,
        KEITH_CLIENT_CONFIG: join(home, 'owner-client.json'),
        NO_COLOR: '1',
      })

      // 1. one chat turn: the chat writes a front session with one generation
      const chat = spawnTui('owner chat', ownerEnv, ['chat'])
      await waitFor(chat, (s) => s.includes('type a message, or /help'), 'the owner chat', {
        ack: true,
      })
      await typeLine(chat, NOTE)
      chat.proc.terminal?.write('\r')
      await waitFor(chat, (s) => s.includes(REPLY), 'the streamed reply')
      // the chat TUI is done: the Logs screen is a separate run of the app
      chat.proc.kill()
      await chat.proc.exited

      // 2. keith manage: the sections list, then Logs (the owner sees every section; Logs sits after Budget)
      const manage = spawnTui('owner manage', ownerEnv, ['manage'])
      await waitFor(manage, (s) => s.includes('Logs'), 'the Manage sections', {
        ack: true,
      })
      await pressUntil(manage, DOWN, (s) => /▸ Logs/.test(s), 'the Logs section selected', {
        timeoutMs: 60_000,
      })
      await pressUntil(manage, '\r', (s) => s.includes('all kinds · mine'), 'the Logs pane')

      // the session row appears once the activity queue has written it: `r` reads the list again
      await pressUntil(
        manage,
        'r',
        (s) => /front:/.test(s) && s.includes('smoke') && /\$\d/.test(s),
        'the session row with its id, model and cost',
        { timeoutMs: 60_000 },
      )
      expect(manage.screen()).toMatch(/front:/)
      expect(manage.screen()).toContain('smoke')
      expect(manage.screen()).toMatch(/\$\d/)

      // 3. Enter: the session and its generations
      await pressUntil(
        manage,
        '\r',
        (s) => /session front:/.test(s) && s.includes('in → out'),
        'the session with its generations',
      )
      expect(manage.screen()).toContain('in → out')

      // 4. Enter: the generation, its figures and the messages sent
      await pressUntil(
        manage,
        '\r',
        (s) => s.includes('generation ') && s.includes('messages sent'),
        'the generation with its tokens and messages',
      )
      expect(manage.screen()).toMatch(/finish stop/)
      expect(manage.screen()).toContain('tokens')

      // 5. r: the raw request and response JSON. The request starts with the tools, so PgDn scrolls to the prompt
      await pressUntil(manage, 'r', (s) => s.includes('raw JSON · generation'), 'the raw JSON')
      // a page is about 27 lines and the tool schemas come first: PgDn is a scroll, so it is sent again and again
      const scrolled = Date.now()
      while (!manage.screen().includes('"prompt"')) {
        if (Date.now() - scrolled > 60_000)
          throw new Error(`the prompt key never showed:\n${manage.screen()}`)
        manage.proc.terminal?.write(PGDN)
        await Bun.sleep(300)
      }
      expect(manage.screen()).toContain('"prompt"')
    },
    TEST_TIMEOUT,
  )
})
