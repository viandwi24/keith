import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeClientConfig } from '@keith/client'
import { type FakeCore, type FakeCoreOptions, startFakeCore } from './fake-core.ts'
import { VtScreen } from './vt-screen.ts'

const cli = join(import.meta.dir, '..', 'cli.tsx')

let core: FakeCore | undefined
let home: string | undefined
const procs: Array<{ kill(): void; exited: Promise<number> }> = []
/** Stop every process and fake core a test started (call it from `afterEach`). */
export async function stopPty(): Promise<void> {
  for (const proc of procs.splice(0)) {
    proc.kill()
    await proc.exited
  }
  core?.stop()
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  core = undefined
  home = undefined
}

export async function until(
  check: () => boolean,
  ms: number,
  what: string,
  screen: () => string = () => '',
): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms)
      throw new Error(`timeout waiting for ${what}; screen:\n${screen()}`)
    await Bun.sleep(20)
  }
}

/**
 * Write `key` until `check` holds on the screen. A key written right after a screen renders can
 * be dropped on a slow machine, so it is written again (never faster than `retryMs`, so a toggle
 * key is not sent twice by an impatient loop).
 */
export async function pressUntil(
  app: { proc: ReturnType<typeof Bun.spawn>; screen(): string },
  key: string,
  check: (screen: string) => boolean,
  what: string,
  { timeoutMs = 20_000, retryMs = 2500 } = {},
): Promise<void> {
  const start = Date.now()
  let last = 0
  while (!check(app.screen())) {
    const now = Date.now()
    if (now - start > timeoutMs)
      throw new Error(
        `timeout waiting for ${what} after ${JSON.stringify(key)}; screen:\n${app.screen()}`,
      )
    if (now - last > retryMs) {
      app.proc.terminal?.write(key)
      last = now
    }
    await Bun.sleep(20)
  }
}

/** Rows of the pseudo-terminal: the app is full screen, so this is the height of its frame. */
const ROWS = 30

export interface Cli {
  proc: ReturnType<typeof Bun.spawn>
  /** What a person sees now: the output applied to a screen grid (Ink redraws only what changed). */
  screen(): string
  /** Every byte the terminal received, escape codes included. */
  raw(): string
}

/**
 * Start the CLI in a real pseudo-terminal (Bun.spawn `terminal`, which keeps reading the pty)
 * against a fake core, and wait until it is ready: the input is mounted (placeholder), the health
 * call landed (a re-render after mount, so Ink is past its first effects and raw mode is on) and
 * the `ready` texts are shown.
 *
 * Why not `expect` with `sleep`: a harness that does not read the pty fills its small buffer
 * (about 1 KB on macOS) and the app blocks in `write(2)` on stdout, so timers, fetch and the
 * send itself freeze. That looked like a hang in Ink; it is the harness not draining the tty.
 */
export async function launch(
  options: FakeCoreOptions,
  ready: string[] = [],
  cols = 100,
  extraEnv: Record<string, string | undefined> = { NO_COLOR: '1' },
  /** Arguments of `keith` (default: `chat`; pass `[]` for Home). `$CORE` stands for the fake core's URL. */
  argv: string[] = ['chat'],
  /** Rows of the pseudo-terminal (default 30). */
  rows = ROWS,
): Promise<{ cli: Cli; core: FakeCore }> {
  const started = startFakeCore({
    ...options,
    rpc: { 'health/get': () => ({ version: '0.0.0', sha: 'test' }), ...options.rpc },
  })
  core = started
  home = mkdtempSync(join(tmpdir(), 'keith-tui-'))
  // Ink (is-in-ci) prints only a final frame when it thinks it runs in CI, so hide every CI marker
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: home,
      KEITH_HOME: home,
      KEITH_DATA_DIR: join(home, 'data'),
      ...extraEnv,
    })
      .filter(([, v]) => v !== undefined)
      .filter(([k]) => k !== 'CI' && k !== 'CONTINUOUS_INTEGRATION' && !k.startsWith('CI_')),
  )
  // the login is a remembered credential for the fake core (a saved login that was not remembered is never used
  // by the app); KEITH_HOME keeps the run away from any real core
  writeClientConfig({ core: started.url, token: 't', remember: true }, join(home, 'client.json'))
  const vt = new VtScreen(cols, rows)
  const decoder = new TextDecoder()
  let raw = ''
  const proc = Bun.spawn(['bun', cli, ...argv.map((a) => (a === '$CORE' ? started.url : a))], {
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
  const screen = (): string => vt.text()
  procs.push(proc)
  for (const text of [
    // the connection is the glyph's colour (a word only without colour): wait for the screen itself
    ...(argv[0] === 'chat' ? ['type a message, or /help'] : []),
    // a signed-out Home shows the login panel instead of the menu: the caller names what to wait for
    ...((argv.length === 0 || argv[0] === 'home') && options.revoked !== true
      ? ['[space] menu']
      : []),
    ...ready,
  ]) {
    await until(() => screen().includes(text), 20_000, `"${text}" on screen`, screen)
  }
  return { cli: { proc, screen, raw: () => raw }, core: started }
}
