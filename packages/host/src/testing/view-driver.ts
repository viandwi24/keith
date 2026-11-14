import { createViewAccess } from '../tui/view-access.ts'
import { createViewHost, type ViewHandle, type ViewHostLimits } from '../tui/view-host.tsx'
import { createViewKeith } from '../tui/view-keith.ts'
import type { KeithPlugin } from '../types.ts'
import type { MemoryHost } from './memory-host.ts'

/** One plugin view mounted on virtual streams for a test: what its viewer sees and the keys the viewer types. */
export interface TestView {
  /** Every frame the view emitted, as text with its SGR (what the client would receive). */
  frames: string[]
  /** The newest frame without styling: the screen as a person reads it. Empty until the first frame. */
  screen(): string
  /** Send terminal bytes as the client's `key` message would. */
  key(data: string): void
  /** Type text one key at a time. */
  type(text: string): Promise<void>
  /** Wait until the screen passes `check` (a text it must contain, or a predicate); rejects with the screen on timeout. */
  until(check: string | RegExp | ((screen: string) => boolean), timeoutMs?: number): Promise<string>
  resize(cols: number, rows: number): void
  /** Why the view ended, or `undefined` while it is open. */
  ended(): string | undefined
  close(): void
}

export interface OpenTestViewOptions {
  /** `<plugin>.<view key>`; the view must have a menu entry the viewer may open. */
  viewId: string
  /** The viewer: a person known to the host (`host.add`). */
  as: string
  cols?: number
  rows?: number
  params?: Record<string, string>
  limits?: Partial<ViewHostLimits>
}

/**
 * Open a plugin's terminal view as one viewer over a `memoryHost`, the same way the core does (`ViewHost` over the host's
 * guard, the viewer as principal, never elevated): the way a plugin tests that its view shows a person only what they may see
 * (docs/specs/plugin-views.md). Frames are paced fast (the real 8 fps is a client concern).
 */
export async function openTestView(
  host: MemoryHost,
  plugins: readonly KeithPlugin[],
  options: OpenTestViewOptions,
): Promise<TestView> {
  const list = () => plugins
  const views = createViewHost({
    access: createViewAccess({ directory: host.directory, plugins: list }),
    keith: createViewKeith({ guard: host.guard, plugins: list }),
    limits: { framesPerSecond: 60, idleMs: 600_000, ...options.limits },
  })
  const frames: string[] = []
  let reason: string | undefined
  const result = await views.open(
    {
      viewer: { principalId: options.as, method: 'password' },
      viewId: options.viewId,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      colorDepth: 24,
      ...(options.params === undefined ? {} : { params: options.params }),
    },
    {
      frame: (f) => frames.push(f.text),
      closed: (r) => {
        reason = r
      },
    },
  )
  if (!result.ok) throw new Error(`the view did not open: ${result.reason}`)
  const handle: ViewHandle = result.view
  const screen = (): string => Bun.stripANSI(frames.at(-1) ?? '')
  return {
    frames,
    screen,
    key: (data) => handle.key(data),
    async type(text) {
      for (const ch of text) {
        handle.key(ch)
        await Bun.sleep(4)
      }
    },
    async until(check, timeoutMs = 3000) {
      const ok = (s: string): boolean =>
        typeof check === 'string'
          ? s.includes(check)
          : check instanceof RegExp
            ? check.test(s)
            : check(s)
      const deadline = Date.now() + timeoutMs
      while (!ok(screen())) {
        if (Date.now() > deadline)
          throw new Error(
            `the view never showed it (ended: ${reason ?? 'no'}); screen:\n${screen()}`,
          )
        await Bun.sleep(10)
      }
      // Ink attaches a component's input handler in an effect, a moment after the frame that shows it:
      // a key sent in that gap is dropped (a person is never that fast), so a test settles before it types
      await Bun.sleep(30)
      return screen()
    },
    resize: (cols, rows) => handle.resize(cols, rows),
    ended: () => reason,
    close() {
      handle.close()
      views.closeAll('view')
    },
  }
}
