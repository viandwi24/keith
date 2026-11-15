// How far a subtitle has typed out, as two pure steps (the Ink subtitle and the web's draw with the same rule).

/** Behind by more than this many characters: type three times faster. */
export const CATCH_UP = 60
/** Characters typed out per second. */
export const DEFAULT_CPS = 90

/** The progress after the text changed: a text that continues the last one keeps it, any other restarts at 0. */
export const retargetShown = (prevText: string, prevShown: number, text: string): number =>
  text.startsWith(prevText) ? prevShown : 0

/** The progress after `dt` seconds: at least one more character while behind, three times faster far behind. */
export function advanceShown(shown: number, total: number, dt: number, cps = DEFAULT_CPS): number {
  const rate = total - shown > CATCH_UP ? cps * 3 : cps
  return Math.min(total, shown + Math.max(1, Math.ceil(dt * rate)))
}
