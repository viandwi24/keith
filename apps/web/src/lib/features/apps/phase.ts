// The phases of one open view (docs/specs/plugin-views.md, "Web"), as a reducer so the component stays thin. There is no
// reconnect: a view lives as long as its socket, and "Open again" is the person's action.
import type { ParsedFrame, ViewEndReason, ViewStatus } from '@keith/client/browser'

export interface ViewState {
  /** `connecting` until the core answers, `open` while frames flow, `ended` with a reason, `timeout` after 10 s of silence. */
  phase: 'connecting' | 'open' | 'ended' | 'timeout'
  /** True while `connecting` for longer than the slow-link wait. */
  slow: boolean
  /** The newest frame; kept after the view ends so its last screen stays visible. */
  frame: ParsedFrame | undefined
  reason: ViewEndReason | undefined
}

export type ViewEvent =
  | { type: 'reset' }
  | { type: 'frame'; frame: ParsedFrame }
  | { type: 'status'; status: ViewStatus }
  | { type: 'end'; reason: ViewEndReason }
  | { type: 'slow' }
  | { type: 'timeout' }

export const INITIAL: ViewState = {
  phase: 'connecting',
  slow: false,
  frame: undefined,
  reason: undefined,
}

export function reduceView(state: ViewState, event: ViewEvent): ViewState {
  switch (event.type) {
    case 'reset':
      return INITIAL
    case 'frame':
      return state.phase === 'ended' || state.phase === 'timeout'
        ? state
        : { ...state, phase: 'open', slow: false, frame: event.frame }
    case 'status':
      return event.status === 'open' && state.phase === 'connecting'
        ? { ...state, phase: 'open', slow: false }
        : state
    case 'slow':
      return state.phase === 'connecting' ? { ...state, slow: true } : state
    case 'timeout':
      return state.phase === 'connecting'
        ? { phase: 'timeout', slow: true, frame: undefined, reason: undefined }
        : state
    case 'end':
      return state.phase === 'timeout'
        ? state
        : { ...state, phase: 'ended', slow: false, reason: event.reason }
  }
}

/** Over for now: ended or timed out (the person may open it again when the reason allows). */
export const isOver = (state: ViewState): boolean =>
  state.phase === 'ended' || state.phase === 'timeout'
