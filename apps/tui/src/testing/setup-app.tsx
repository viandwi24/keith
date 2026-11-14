import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeClientConfig } from '@keith/client'
import { resolveTheme, type Scheduler, type Theme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { AppRoot } from '../app-root.tsx'
import type { SignInTuning } from '../app-session.tsx'
import type { MotionConfig } from '../platform/config.ts'
import { stripAnsi } from './ansi.ts'
import type { FakeAdmin } from './fake-admin.ts'
import { type FakeCore, type FakeCoreOptions, startFakeCore } from './fake-core.ts'

const opened: FakeCore[] = []
const dirs: string[] = []

const plain = (frame: string | undefined): string | undefined =>
  frame === undefined ? undefined : stripAnsi(frame)

/** Stop every fake core a test started (call it from `afterEach`). */
export function stopCores(): void {
  // an App that a test left mounted would keep its timers and, once its core is gone, publish an offline mode
  cleanup()
  for (const core of opened.splice(0)) core.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export interface SetupOptions extends FakeCoreOptions {
  columns?: number
  rows?: number
  /** Default: dark, no colour, no animation (what tests assert on). */
  theme?: Theme
  /** Poll period of the header spend (the app's default is 60 s). */
  budgetPollMs?: number
  /** Poll period of a member's node list (the app's default is 30 s). */
  nodesPollMs?: number
  /** The admin procedures (people, devices, ...) the Manage screen calls; see `createFakeAdmin`. */
  admin?: FakeAdmin
  /** The orb header on the chat (default on); `false` is the compact layout with the Brain panel. */
  header?: boolean
  /** Open on Home (`keith`), the chat (`keith chat`, the default here) or Manage without a chat. */
  start?: 'home' | 'chat' | 'manage'
  /** The credential is refused from the start (the core answers 401 until a sign in). */
  loggedOut?: boolean
  /** A login already saved in this run's `client.json`, for the core of the run (a legacy one has no `remember`). */
  savedLogin?: { token: string; remember?: true }
  /** The core is on a Unix socket (the connection is `kind: 'socket'`); with `loggedOut` its owner needs a session. */
  socket?: boolean
  /** The sign-in panel's guest status check (and guest chat from it) goes to this fake core, whatever port the app derives. */
  guestVia?: boolean
  /** Timings of the Sign in screen (default: quick polls and no wait on `done`). */
  signInTuning?: SignInTuning
  /** Home's intro and idle hide (default: intro off, never hides, so tests see Home at once). */
  motion?: MotionConfig
  /** The time source of the fades (default real time). */
  scheduler?: Scheduler
  /** The presence heartbeat's cadence (default 20 s). */
  presenceHeartbeatMs?: number
}

/** The App on a fake core; resolves once the activity stream is open (the feed has no history). */
export async function setupApp({
  columns = 120,
  rows = 40,
  theme = resolveTheme({ theme: 'dark', depth: 'none' }),
  budgetPollMs,
  nodesPollMs,
  admin,
  start: screen = 'chat',
  loggedOut = false,
  savedLogin,
  signInTuning = { pollMs: 20, doneMs: 30, tickMs: 100 },
  socket = false,
  guestVia = false,
  header,
  motion = { intro: false, idleHideSeconds: 0, reduced: false, orbStatic: false },
  scheduler,
  presenceHeartbeatMs,
  rpc = {},
  ...options
}: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keith-tui-'))
  dirs.push(dir)
  const socketPath = join(dir, 'core.sock')
  const core = startFakeCore({
    ...options,
    ...(socket ? { unix: socketPath } : {}),
    rpc: {
      'health/get': () => ({ status: 'ok', version: '0.0.0', sha: 'abc1234', boot: 'b' }),
      'models/roles/get': () => ({ front: null, cortex: null }),
      'tasks/list': () => [],
      'nodes/list': () => [],
      ...admin?.rpc,
      ...rpc,
    },
  })
  opened.push(core)
  if (loggedOut) core.revoke()
  // the credential file of this run: sign in writes it, sign out removes it (never the real one)
  const configPath = join(dir, 'client.json')
  if (savedLogin !== undefined) writeClientConfig({ core: core.url, ...savedLogin }, configPath)
  const toCore = ((input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input as string, init)
    const at = new URL(request.url)
    return fetch(new Request(new URL(at.pathname + at.search, core.url).href, request))
  }) as typeof fetch
  const view = render(
    <ThemeProvider theme={theme} spinner={false}>
      <AppRoot
        connection={
          socket
            ? { kind: 'socket', path: socketPath, source: 'flag' }
            : { kind: 'http', url: core.url, token: 't', source: 'flag' }
        }
        configPath={configPath}
        motion={motion}
        {...(scheduler === undefined ? {} : { scheduler })}
        signInTuning={signInTuning}
        {...(guestVia ? { guestFetch: toCore } : {})}
        columns={columns}
        rows={rows}
        start={screen}
        {...(header === undefined ? {} : { header })}
        brain={{ fadeMs: 400, tickMs: 20 }}
        {...(budgetPollMs === undefined ? {} : { budgetPollMs })}
        {...(nodesPollMs === undefined ? {} : { nodesPollMs })}
        {...(presenceHeartbeatMs === undefined ? {} : { presenceHeartbeatMs })}
      />
    </ThemeProvider>,
    { columns, rows },
  )
  const start = Date.now()
  while (!loggedOut && core.streams() === 0) {
    if (Date.now() - start > 15_000) throw new Error('the activity stream never opened')
    await Bun.sleep(15)
  }
  // the chat mounts once whoami answered (the session is `front:<personId>`); Manage shows its title
  const mounted = Date.now()
  const ready = screen === 'manage' ? 'Manage' : screen === 'home' ? 'K E I T H' : 'type a message'
  while (
    !(plain(view.lastFrame()) ?? '').includes(ready) &&
    !(plain(view.lastFrame()) ?? '').includes('logged out')
  ) {
    if (Date.now() - mounted > 15_000) throw new Error('the chat never mounted')
    await Bun.sleep(15)
  }
  await Bun.sleep(150) // let Ink attach the input handler (see `chatReady`)
  return {
    ...view,
    lastFrame: () => plain(view.lastFrame()),
    rawFrame: () => view.lastFrame(),
    core,
    configPath,
  }
}
