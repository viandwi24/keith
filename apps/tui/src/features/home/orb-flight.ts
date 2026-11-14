import { CHAT_HEADER_LEFT, CHAT_ORB_HEIGHT, CHAT_ORB_WIDTH } from '@keith/ui'
import { homeSize } from './home-state.ts'

/** A rectangle on the screen, in cells. */
export interface OrbBox {
  top: number
  left: number
  width: number
  height: number
}

/** Frames of a flight and the time between them: 4 x 75 ms = 300 ms, 13 frames a second. */
export const FLIGHT_STEPS = 4
export const FLIGHT_STEP_MS = 75

export type FlightDirection = 'in' | 'out'

/** Where the orb sits in the chat header. */
export const CHAT_ORB_BOX: OrbBox = {
  top: 0,
  left: CHAT_HEADER_LEFT,
  width: CHAT_ORB_WIDTH,
  height: CHAT_ORB_HEIGHT,
}

/** Where the orb sits on Home at this terminal size. */
export function homeOrbBox(columns: number, rows: number, cellAspect?: number): OrbBox {
  const s = homeSize(columns, rows, cellAspect)
  return { top: s.orbTop, left: s.orbLeft, width: s.orbWidth, height: s.orbHeight }
}

/** Ease-out: fast at first, settling at the end. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 3

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t)

/** The box at `step` of `steps` (0 is `from`, `steps` is `to`). */
export function flightBox(from: OrbBox, to: OrbBox, step: number, steps = FLIGHT_STEPS): OrbBox {
  const t = easeOut(Math.max(0, Math.min(1, step / steps)))
  return {
    top: lerp(from.top, to.top, t),
    left: lerp(from.left, to.left, t),
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
  }
}

/** The start and end boxes: Home to the header (`in`, entering the chat) or back (`out`). */
export function flightEnds(
  direction: FlightDirection,
  columns: number,
  rows: number,
  cellAspect?: number,
  /** Where the orb sits on the chat: the header by default, or the top of the sidebar in the wide mode. */
  chat: OrbBox = CHAT_ORB_BOX,
): { from: OrbBox; to: OrbBox } {
  const home = homeOrbBox(columns, rows, cellAspect)
  return direction === 'in' ? { from: home, to: chat } : { from: chat, to: home }
}
