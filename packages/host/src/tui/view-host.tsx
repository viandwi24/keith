import { RESERVED_VIEW_KEYS, VIEW_LIMITS, type ViewCloseReason } from '@keith/contracts'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import chalk from 'chalk'
import { render } from 'ink'
import { Component, type ReactNode } from 'react'
import type { ViewProps } from '../types.ts'
import type { Keith } from './context.tsx'
import { KeithProvider } from './context.tsx'
import type { ViewAccess } from './view-access.ts'
import type { Viewer } from './view-keith.ts'
import { VirtualStdin, VirtualStdout } from './virtual-streams.ts'

export interface ViewHostLimits {
  perActor: number
  global: number
  idleMs: number
  framesPerSecond: number
  frameMaxBytes: number
  keysPerSecond: number
  /** A view module that does not load in this time is an `error`. */
  loadTimeoutMs: number
}

const DEFAULT_LIMITS: ViewHostLimits = {
  perActor: VIEW_LIMITS.perActor,
  global: VIEW_LIMITS.global,
  idleMs: VIEW_LIMITS.idleMs,
  framesPerSecond: VIEW_LIMITS.framesPerSecond,
  frameMaxBytes: VIEW_LIMITS.frameMaxBytes,
  keysPerSecond: VIEW_LIMITS.keysPerSecond,
  loadTimeoutMs: 5_000,
}

export interface OpenViewRequest {
  viewer: Viewer
  viewId: string
  cols: number
  rows: number
  colorDepth: 1 | 4 | 8 | 24
  params?: Readonly<Record<string, string>> | undefined
}

/** What the host calls back: frames in order of `seq`, and exactly one `closed` at the end. */
export interface ViewListeners {
  frame(frame: { seq: number; text: string }): void
  closed(reason: ViewCloseReason): void
}

export interface ViewHandle {
  readonly id: string
  readonly viewId: string
  readonly principalId: string
  /** Terminal input bytes. The reserved keys are dropped, input beyond the rate cap too. */
  key(data: string): void
  resize(cols: number, rows: number): void
  /** Tear the view down; `closed` is called with the reason (default `view`). A second call does nothing. */
  close(reason?: ViewCloseReason): void
  readonly closed: boolean
}

export type OpenViewResult =
  | { ok: true; view: ViewHandle }
  | { ok: false; reason: 'limit' | 'refused' | 'error' }

export interface ViewHost {
  open(request: OpenViewRequest, listeners: ViewListeners): Promise<OpenViewResult>
  /** Close every view of one person (their session was revoked, they were suspended). Returns how many. */
  closeFor(principalId: string, reason: ViewCloseReason): number
  /** Close every view (the core stops). */
  closeAll(reason: ViewCloseReason): void
  /** The open views, for `keith-core doctor`. */
  snapshot(): Array<{ id: string; viewId: string; principalId: string; openedAt: number }>
}

export interface ViewHostDeps {
  access: Pick<ViewAccess, 'find'>
  /** Builds the `Keith` handle of one view for its viewer (`createViewKeith`). */
  keith: (viewer: Viewer, viewId: string, signal: AbortSignal) => Keith
  limits?: Partial<ViewHostLimits>
  log?: { warn(message: string): void }
  /** Clock for idle and frame pacing (default `Date.now`). */
  now?: () => number
}

// what Ink writes next to frames: private mode toggles (bracketed paste, cursor); an empty write comes at clear and unmount
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const PRIVATE_MODE = /^\u001b\[\?[0-9;]+[hl]$/

class Boundary extends Component<
  { onError(error: unknown): void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(error: unknown): void {
    this.props.onError(error)
  }
  // the viewer never sees the error text: the view just ends with `error`
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

// chalk's level is process-global: truecolor is forced while at least one view is mounted and put back after the last
// one closes, so nothing else in the process (a test run, the core console) keeps the changed level
let mounted = 0
let savedLevel: typeof chalk.level = 0
const acquireColor = (): void => {
  if (mounted++ === 0) {
    savedLevel = chalk.level
    chalk.level = 3
  }
}
const releaseColor = (): void => {
  if (--mounted === 0) chalk.level = savedLevel
}

const reasonText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)

/**
 * Runs plugin views in this process on virtual streams (docs/specs/plugin-views.md, "ViewHost"). It owns the
 * caps, the frame pacing, the idle timeout and the teardown; it knows nothing of sockets. `chalk.level` is forced to
 * truecolor while a view is mounted (process-global, so views belong in the daemon) and restored after the last one closes.
 */
export function createViewHost(deps: ViewHostDeps): ViewHost {
  const limits: ViewHostLimits = { ...DEFAULT_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const open = new Map<string, ViewHandle & { openedAt: number }>()
  const perActor = new Map<string, number>()
  let reserved = 0
  let seq = 0
  let shut = false

  const release = (principalId: string): void => {
    reserved--
    const left = (perActor.get(principalId) ?? 1) - 1
    if (left <= 0) perActor.delete(principalId)
    else perActor.set(principalId, left)
  }

  async function start(
    request: OpenViewRequest,
    listeners: ViewListeners,
  ): Promise<OpenViewResult> {
    const { viewer } = request
    const entry = await deps.access.find(viewer.principalId, request.viewId)
    if (entry === undefined) return { ok: false, reason: 'refused' }
    let component: (props: ViewProps) => unknown
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const loaded = await Promise.race([
        entry.load(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('the view did not load')),
            limits.loadTimeoutMs,
          )
        }),
      ])
      if (typeof loaded?.default !== 'function')
        throw new Error('the view has no default component')
      component = loaded.default
    } catch (error) {
      deps.log?.warn(`view ${request.viewId}: could not load: ${reasonText(error)}`)
      return { ok: false, reason: 'error' }
    } finally {
      clearTimeout(timeout)
    }

    const id = crypto.randomUUID()
    const abort = new AbortController()
    const stdout = new VirtualStdout(request.cols, request.rows)
    const stderr = new VirtualStdout(request.cols, request.rows) // discarded: nothing is read from it
    const stdin = new VirtualStdin()
    const frameInterval = Math.ceil(1000 / limits.framesPerSecond)
    let closed = false
    let colorHeld = false
    let instance: ReturnType<typeof render> | undefined
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let pending: string | undefined
    let lastText: string | undefined
    let lastSentAt = Number.NEGATIVE_INFINITY
    let lastActive = now()
    let keyWindowStart = 0
    let keyCount = 0
    let size = { cols: request.cols, rows: request.rows }

    const close = (reason: ViewCloseReason): void => {
      if (closed) return
      closed = true
      clearTimeout(frameTimer)
      clearTimeout(idleTimer)
      pending = undefined
      abort.abort()
      try {
        instance?.unmount()
      } catch (error) {
        deps.log?.warn(`view ${request.viewId}: unmount failed: ${reasonText(error)}`)
      }
      stdout.dispose()
      stderr.dispose()
      stdin.dispose()
      if (colorHeld) releaseColor()
      open.delete(id)
      release(viewer.principalId)
      listeners.closed(reason)
    }
    // from inside Ink's own callbacks: close after they return
    const closeSoon = (reason: ViewCloseReason): void => {
      queueMicrotask(() => close(reason))
    }

    const flush = (): void => {
      frameTimer = undefined
      if (closed || pending === undefined) return
      const text = pending
      pending = undefined
      if (text === lastText) return
      lastText = text
      lastSentAt = now()
      listeners.frame({ seq: seq++, text })
    }
    stdout.onWrite = (chunk) => {
      if (closed || chunk === '' || PRIVATE_MODE.test(chunk)) return
      if (Buffer.byteLength(chunk) > limits.frameMaxBytes) {
        pending = undefined
        closeSoon('limit')
        return
      }
      pending = chunk
      if (frameTimer !== undefined) return
      const wait = lastSentAt + frameInterval - now()
      if (wait <= 0) flush()
      else frameTimer = setTimeout(flush, wait)
    }
    stdin.onError = (error) => {
      deps.log?.warn(`view ${request.viewId}: input handler threw: ${reasonText(error)}`)
      closeSoon('error')
    }

    const armIdle = (ms: number): void => {
      idleTimer = setTimeout(() => {
        const left = lastActive + limits.idleMs - now()
        if (left > 0) armIdle(left)
        else close('idle')
      }, ms)
    }
    armIdle(limits.idleMs)

    const keith = deps.keith(viewer, request.viewId, abort.signal)
    const theme = resolveTheme({ theme: 'dark', depth: 'truecolor' })
    const params = Object.freeze({ ...(request.params ?? {}) })
    const View = component as (props: ViewProps) => ReactNode
    acquireColor()
    colorHeld = true
    try {
      instance = render(
        <ThemeProvider theme={theme}>
          <KeithProvider keith={keith} colorDepth={request.colorDepth}>
            <Boundary
              onError={(error) => {
                deps.log?.warn(`view ${request.viewId}: failed: ${reasonText(error)}`)
                closeSoon('error')
              }}
            >
              <View viewId={request.viewId} params={params} />
            </Boundary>
          </KeithProvider>
        </ThemeProvider>,
        {
          stdout: stdout as never,
          stderr: stderr as never,
          stdin: stdin as never,
          debug: true,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      )
    } catch (error) {
      // nothing was mounted: undo what was set up, then let `open` report it
      closed = true
      clearTimeout(idleTimer)
      abort.abort()
      stdout.dispose()
      stderr.dispose()
      stdin.dispose()
      releaseColor()
      throw error
    }
    instance.waitUntilExit().then(
      () => close('view'),
      () => close('error'),
    )
    // an error that closed the view while it rendered the first time
    if (closed) instance.unmount()

    const handle: ViewHandle & { openedAt: number } = {
      id,
      viewId: request.viewId,
      principalId: viewer.principalId,
      openedAt: now(),
      get closed() {
        return closed
      },
      key(data) {
        if (closed || data === '' || data.length > VIEW_LIMITS.keyMaxChars) return
        if (data === RESERVED_VIEW_KEYS.leave || data === RESERVED_VIEW_KEYS.home) return
        const t = now()
        if (t - keyWindowStart >= 1000) {
          keyWindowStart = t
          keyCount = 0
        }
        if (++keyCount > limits.keysPerSecond) return
        lastActive = t
        stdin.feed(data)
      },
      resize(cols, rows) {
        if (closed) return
        const next = {
          cols: Math.min(VIEW_LIMITS.cols.max, Math.max(VIEW_LIMITS.cols.min, Math.trunc(cols))),
          rows: Math.min(VIEW_LIMITS.rows.max, Math.max(VIEW_LIMITS.rows.min, Math.trunc(rows))),
        }
        lastActive = now()
        if (next.cols === size.cols && next.rows === size.rows) return
        size = next
        stdout.resize(next.cols, next.rows)
      },
      close(reason = 'view') {
        close(reason)
      },
    }
    open.set(id, handle)
    return { ok: true, view: handle }
  }

  return {
    async open(request, listeners) {
      const principalId = request.viewer.principalId
      if (shut) return { ok: false, reason: 'refused' }
      // a slot is taken before the first await, so concurrent opens cannot pass the caps together
      if (reserved >= limits.global || (perActor.get(principalId) ?? 0) >= limits.perActor)
        return { ok: false, reason: 'limit' }
      reserved++
      perActor.set(principalId, (perActor.get(principalId) ?? 0) + 1)
      let result: OpenViewResult
      try {
        result = await start(request, listeners)
      } catch (error) {
        deps.log?.warn(`view ${request.viewId}: could not start: ${reasonText(error)}`)
        result = { ok: false, reason: 'error' }
      }
      // a started view keeps its slot until it closes (`close` releases it)
      if (!result.ok) release(principalId)
      return result
    },
    closeFor(principalId, reason) {
      const mine = [...open.values()].filter((v) => v.principalId === principalId)
      for (const view of mine) view.close(reason)
      return mine.length
    },
    closeAll(reason) {
      shut = true
      for (const view of [...open.values()]) view.close(reason)
    },
    snapshot: () =>
      [...open.values()].map((v) => ({
        id: v.id,
        viewId: v.viewId,
        principalId: v.principalId,
        openedAt: v.openedAt,
      })),
  }
}
