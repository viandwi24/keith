import type { ViewConnection } from '@keith/client/browser'
import { getClient } from '../session/index.ts'
import { PENDING_TIMEOUT_MS, SLOW_LINK_MS } from './end-text.ts'
import type { GridSize } from './grid.ts'
import { INITIAL, reduceView, type ViewEvent, type ViewState } from './phase.ts'

/**
 * One plugin view over the page's client (cookie, same origin): opens it at a size, keeps the newest frame, forwards keys and
 * resizes, and closes it. No reconnect: `reopen()` is the person's action after the view ended or timed out.
 */
export class ViewSession {
  state = $state<ViewState>(INITIAL)
  private connection: ViewConnection | undefined
  private timers: ReturnType<typeof setTimeout>[] = []
  private viewId = ''
  private grid: GridSize | undefined
  /** A late callback of an attempt that is over changes nothing. */
  private attempt = 0

  private apply(event: ViewEvent): void {
    this.state = reduceView(this.state, event)
  }

  /** Called whenever the grid is known or changes: the first call opens the view, later ones resize it. */
  sync(viewId: string, grid: GridSize): void {
    this.viewId = viewId
    const changed = this.grid?.cols !== grid.cols || this.grid?.rows !== grid.rows
    this.grid = grid
    if (this.connection === undefined && this.state.phase === 'connecting' && this.attempt === 0)
      this.start()
    else if (changed) this.connection?.resize(grid.cols, grid.rows)
  }

  reopen(): void {
    this.stop()
    this.apply({ type: 'reset' })
    this.start()
  }

  sendKey(data: string): void {
    this.connection?.sendKey(data)
  }

  close(): void {
    this.stop()
  }

  private start(): void {
    const grid = this.grid
    if (grid === undefined) return
    const attempt = ++this.attempt
    const live = (): boolean => attempt === this.attempt
    this.timers.push(
      setTimeout(() => live() && this.apply({ type: 'slow' }), SLOW_LINK_MS),
      setTimeout(() => {
        if (!live() || this.state.phase !== 'connecting') return
        this.apply({ type: 'timeout' })
        this.connection?.close()
        this.connection = undefined
      }, PENDING_TIMEOUT_MS),
    )
    try {
      this.connection = getClient().openView({
        viewId: this.viewId,
        cols: grid.cols,
        rows: grid.rows,
        colorDepth: 24,
        onFrame: (frame) => live() && this.apply({ type: 'frame', frame }),
        onStatus: (status) => live() && this.apply({ type: 'status', status }),
        onEnd: (reason) => {
          if (!live()) return
          this.clearTimers()
          this.apply({ type: 'end', reason })
        },
      })
    } catch {
      this.apply({ type: 'end', reason: 'unavailable' })
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  private stop(): void {
    this.attempt++
    this.clearTimers()
    const conn = this.connection
    this.connection = undefined
    conn?.close()
  }
}
