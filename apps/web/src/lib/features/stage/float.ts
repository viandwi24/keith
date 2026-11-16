// How the workspace comes in over the orb: it rises a little and grows from 94 % to full size while it fades in, and leaves the same
// way. Instant under reduced motion. A Svelte transition (`in:`/`out:`), pure so it is tested.
import { cubicOut } from 'svelte/easing'

export const FLOAT_MS = 280

/** The CSS of the floating workspace at progress `t` (0 hidden, 1 in place). */
export function floatCss(t: number): string {
  const rise = Math.round((1 - t) * 24)
  const scale = (0.94 + 0.06 * t).toFixed(4)
  return `opacity: ${t.toFixed(4)}; transform: translateY(${rise}px) scale(${scale})`
}

/** The transition: `transition:float={{ reduced }}`. */
export function float(_node: Element, options: { reduced: boolean }) {
  return { duration: options.reduced ? 0 : FLOAT_MS, easing: cubicOut, css: floatCss }
}

/** The backdrop over the orb: a plain fade, shorter than the workspace. */
export function backdrop(_node: Element, options: { reduced: boolean }) {
  return {
    duration: options.reduced ? 0 : 200,
    css: (t: number) => `opacity: ${t.toFixed(4)}`,
  }
}
