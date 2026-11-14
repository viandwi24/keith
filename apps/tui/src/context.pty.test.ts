import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pressUntil, until } from './testing/pty.ts'
import { VtScreen } from './testing/vt-screen.ts'

/**
 * The context reset in the real TUI, against a real core. The owner chats three exchanges about one topic (every
 * message carries MARK), then `/new`: the chat shows the divider "new context" and no old message, and the next
 * reply's request holds no MARK (the model starts empty; the flush of the old context runs first, on its own request).
 * Then a turn is held open with the scripted provider, and `/new` during it shows the refusal toast "a turn is still
 * running"; once the turn is released the same `/new` succeeds. The provider is a scripted OpenAI-compatible endpoint
 * in this test process. Keys are sent with `pressUntil` (re-sent until the screen shows the result), matching is on the
 * screen the terminal shows (VtScreen). No sleep-based driving.
 */

const ptySupported = process.platform !== 'win32'
const ROOT = join(import.meta.dir, '..', '..', '..')
const CORE = join(ROOT, 'apps/core/src/cli.ts')
const TUI = join(import.meta.dir, 'cli.tsx')

/** Above bun's 5 s default: a core, a TUI and several turns take a while on a loaded laptop. */
const TEST_TIMEOUT = 150_000

const OWNER_NAME = 'Rin'
const OWNER_PIN = ['48', '29', '15'].join('')

/** Every message of the first context carries this word: it must be absent from the context after a reset. */
const MARK = 'zebra-marker'
/** The reply to every request. */
const REPLY = 'Yes, we can go on with that.'

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

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

/** A streamed text completion of one line (the shape `scripts/smoke/fake-provider.ts` uses). */
function textStream(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'chatcmpl-context',
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

/** A non-streaming chat completion with `text` (OpenAI-compatible). */
function completionOf(text: string) {
  return {
    id: 'chatcmpl-pty',
    object: 'chat.completion',
    created: 0,
    model: 'smoke',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  }
}

/**
 * The scripted provider. It keeps every request body (the model's whole input). `hold()` makes every model call wait
 * until `release()`, so a turn stays open while the test sends `/new`.
 */
function scriptedProvider(): {
  url: string
  hold(): void
  release(): void
  calls(): number
  requests(): string[]
} {
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname.endsWith('/models'))
        return Response.json({ object: 'list', data: [{ id: 'smoke', object: 'model' }] })
      if (pathname === '/api.json') return Response.json(CATALOG)
      if (!pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const raw = await request.text()
      requests.push(raw)
      await gate
      // the memory flush of /new is a non-streaming call (eharness 0.14.1 runs it over the whole history): a plain completion
      if ((JSON.parse(raw) as { stream?: boolean }).stream !== true)
        return Response.json(completionOf(REPLY))
      return new Response(textStream(REPLY), {
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
    calls: () => requests.length,
    requests: () => requests,
  }
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
 * Wait until `check` holds on the screen. The audit notice of a first sign-in covers the screen until
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

describe.skipIf(!ptySupported)('the context reset in the real TUI, against a real core', () => {
  test(
    '/new shows the divider and an empty chat; the next request holds no old message; /new during a turn is refused',
    async () => {
      const provider = scriptedProvider()
      home = realpathSync(mkdtempSync(join(tmpdir(), 'keith-context-pty-')))
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
        KEITH_BUILD_SHA: 'context-pty',
        KEITH_PUBLIC_URL: coreUrl,
        DEEPSEEK_API_KEY: ['sk', 'context', crypto.randomUUID().replaceAll('-', '')].join('-'),
        DEEPSEEK_BASE_URL: provider.url,
        KEITH_MODELS_DEV_URL: `${provider.url}/api.json`,
      })

      // the owner: setup, the local socket trusted in full
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

      const owner = spawnTui(
        'owner',
        childEnv({
          HOME: home,
          KEITH_DATA_DIR: dataDir,
          KEITH_CLIENT_CONFIG: join(home, 'owner-client.json'),
          NO_COLOR: '1',
        }),
        ['chat'],
      )
      await waitFor(owner, (s) => s.includes('type a message, or /help'), 'the owner chat', {
        ack: true,
      })

      // 1. three exchanges about one topic; every reply has come back before the next message
      for (const [n, text] of [
        [1, `${MARK} first note`],
        [2, `${MARK} second note`],
        [3, `${MARK} third note`],
      ] as const) {
        await typeLine(owner, text)
        owner.proc.terminal?.write('\r')
        await waitFor(owner, (s) => s.includes(REPLY) && provider.calls() >= n, `reply ${n}`)
      }

      // 2. /new: the toast says the reset went through; the chat shows the divider and no old message
      await typeLine(owner, '/new')
      await pressUntil(owner, '\r', (s) => s.includes('New context started'), 'the reset toast')
      await waitFor(
        owner,
        (s) => s.includes('new context') && !s.includes(MARK),
        'the divider and an empty chat',
      )
      expect(owner.screen()).toContain('new context')
      expect(owner.screen()).not.toContain(MARK)

      // 3. the next reply's request holds no old message (the request after the reset is the last one)
      const before = provider.calls()
      await typeLine(owner, 'what were we talking about?')
      owner.proc.terminal?.write('\r')
      await waitFor(
        owner,
        (s) => s.includes(REPLY) && provider.calls() > before,
        'the reply after the reset',
      )
      const turn = provider.requests().at(-1) ?? ''
      expect(turn).toContain('what were we talking about?')
      expect(turn).not.toContain(MARK)

      // 4. a turn is held open; /new during it is refused with the toast, and the same /new works once it ends
      provider.hold()
      const held = provider.calls()
      await typeLine(owner, 'a question that takes a while')
      owner.proc.terminal?.write('\r')
      await until(
        () => provider.calls() > held,
        20_000,
        'the held turn reaching the provider',
        () => owner.screen(),
      )
      await typeLine(owner, '/new')
      await pressUntil(
        owner,
        '\r',
        (s) => s.includes('a turn is still running'),
        'the refusal toast',
      )
      provider.release()
      await waitFor(owner, (s) => s.includes(REPLY), 'the held reply')
      await typeLine(owner, '/new')
      await pressUntil(
        owner,
        '\r',
        (s) => s.includes('New context started'),
        'the reset after the turn',
      )
    },
    TEST_TIMEOUT,
  )
})
