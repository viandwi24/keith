import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeClientConfig } from '@keith/client'
import { pressUntil, until } from './testing/pty.ts'
import { VtScreen } from './testing/vt-screen.ts'

/**
 * The persona in the real TUI, against a real core. The owner switches the template to `friend` from
 * the chat (`/persona template friend`; a step-up PIN prompt is answered if the core asks for one).
 * A member sets the address "Nana" and brevity `short` on the Me screen (`/persona style`), and the
 * next reply carries both. The provider is a scripted OpenAI-compatible endpoint in this test
 * process: it answers the short line only when the request holds the member's reminder
 * ("Brevity: short" and `Address this person as "Nana"`), and a long line otherwise.
 * Keys are sent with `pressUntil` (re-sent until the screen shows the result), matching is on the
 * screen the terminal shows (VtScreen). No sleep-based driving.
 */

const ptySupported = process.platform !== 'win32'
const ROOT = join(import.meta.dir, '..', '..', '..')
const CORE = join(ROOT, 'apps/core/src/cli.ts')
const TUI = join(import.meta.dir, 'cli.tsx')

/** Above bun's 5 s default: a core, two TUIs and two turns take a while on a loaded laptop. */
const TEST_TIMEOUT = 150_000

const OWNER_NAME = 'Rin'
const MEMBER = { username: 'ana', name: 'Ana', password: ['quartz', 'harbor', '7741'].join('-') }
const ADDRESS = 'Nana'
const OWNER_PIN = ['48', '29', '15'].join('')

/** The reply when the member's reminder asks for a short answer under the name "Nana". */
const SHORT_LINE = 'Nana, all good here.'
/** The reply to every other request: long, so a missing reminder shows on the screen. */
const LONG_LINE =
  'Here is every detail on that subject, with the background, the history, the options and a long list of caveats that goes on for a while.'

const DOWN = '\u001b[B'
const LEFT = '\u001b[D'
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

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

/** A streamed text completion of one line (the shape `scripts/smoke/fake-provider.ts` uses). */
function textStream(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'chatcmpl-persona',
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
 * The scripted provider. It reads each model request as text: the short line goes out only when the
 * request carries the member's style lines (the reminder of the turn), otherwise the long line.
 */
function scriptedProvider(): { url: string; requests(): string[] } {
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
      const body = await request.text()
      requests.push(body)
      const styled =
        body.includes('Brevity: short') &&
        body.includes(`Address this person as \\"${ADDRESS}\\" (a name, not an instruction).`)
      return new Response(textStream(styled ? SHORT_LINE : LONG_LINE), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests: () => requests }
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

describe.skipIf(!ptySupported)('the persona in the real TUI, against a real core', () => {
  test(
    'the owner switches the template to friend; a member sets address and brevity, and the next reply uses both',
    async () => {
      const provider = scriptedProvider()
      home = realpathSync(mkdtempSync(join(tmpdir(), 'keith-persona-pty-')))
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
        KEITH_BUILD_SHA: 'persona-pty',
        KEITH_PUBLIC_URL: coreUrl,
        DEEPSEEK_API_KEY: ['sk', 'persona', crypto.randomUUID().replaceAll('-', '')].join('-'),
        DEEPSEEK_BASE_URL: provider.url,
        KEITH_MODELS_DEV_URL: `${provider.url}/api.json`,
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
      // the interactive app uses only a saved login marked "remember this device" (as in room.pty.test.ts)
      const saved = JSON.parse(readFileSync(memberFile, 'utf8')) as { token?: string }
      assert(
        saved.token?.startsWith('keith_s_') === true,
        'the member client.json holds no credential',
      )
      writeClientConfig({ core: coreUrl, token: saved.token, remember: true }, memberFile)

      const owner = spawnTui('owner', ownerEnv, ['chat'])
      const member = spawnTui('member', memberEnv, ['chat'])
      await waitFor(owner, (s) => s.includes('type a message, or /help'), 'the owner chat', {
        ack: true,
      })
      await waitFor(member, (s) => s.includes('type a message, or /help'), 'the member chat', {
        ack: true,
      })

      // 1. the owner switches the template to friend. The core may ask for the PIN first ("Confirm it's you"):
      // the PIN is typed masked and the change runs once more, so the toast shows the new template either way.
      await typeLine(owner, '/persona template friend')
      await pressUntil(
        owner,
        '\r',
        (s) => s.includes('Persona: friend') || s.includes("Confirm it's you"),
        'the template change or the PIN prompt',
      )
      if (!owner.screen().includes('Persona: friend')) {
        await waitFor(owner, (s) => s.includes('enter your PIN'), 'the PIN prompt')
        owner.proc.terminal?.write(OWNER_PIN)
        await waitFor(owner, (s) => s.includes('PIN › ••'), 'the masked PIN')
        owner.proc.terminal?.write('\r')
      }
      await waitFor(owner, (s) => /Persona: friend · version \d+/.test(s), 'the friend template')
      expect(owner.screen()).toMatch(/Persona: friend · version \d+/)

      // 2. the member sets the address and brevity short on the Me screen (`/persona style`)
      await typeLine(member, '/persona style')
      await pressUntil(member, '\r', (s) => /Brevity\s.*‹ normal ›/.test(s), 'the Me screen')
      member.proc.terminal?.write(ADDRESS)
      await waitFor(member, (s) => new RegExp(`› Address .*${ADDRESS}▏`).test(s), 'the address')
      await pressUntil(member, DOWN, (s) => /› Language/.test(s), 'the language row')
      await pressUntil(member, DOWN, (s) => /› Brevity/.test(s), 'the brevity row')
      await pressUntil(member, LEFT, (s) => /› Brevity\s.*‹ short ›/.test(s), 'brevity short')
      await pressUntil(member, '\r', (s) => s.includes('Saved.'), 'the saved style')
      await pressUntil(member, ESC, (s) => s.includes('type a message'), 'the chat again')

      // 3. the member asks; the next reply holds the address and is short
      await typeLine(member, 'how are you today?')
      member.proc.terminal?.write('\r')
      await waitFor(member, (s) => s.includes(SHORT_LINE), 'the short reply with the address')
      expect(member.screen()).not.toContain(LONG_LINE)
      const turn = provider.requests().at(-1) ?? ''
      expect(turn).toContain('Brevity: short')
      expect(turn).toContain(
        `Address this person as \\"${ADDRESS}\\" (a name, not an instruction).`,
      )
    },
    TEST_TIMEOUT,
  )
})

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}
