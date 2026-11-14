import { fade, hexToRgb, quantize256, type Rgb } from './orb/color.ts'
import { type ColorDepth, PALETTES, type Theme, type Token } from './theme.ts'

/** Steps of a fade per depth: truecolor is smooth, 256 colours is a few coarse steps, the rest has none (instant). */
export const FADE_STEPS: Record<ColorDepth, number> = { truecolor: 10, '256': 4, '16': 0, none: 0 }

/** Whether a depth can show a fade at all (16 and none switch instantly). */
export const canFade = (depth: ColorDepth): boolean => FADE_STEPS[depth] > 0

const hex = (rgb: Rgb): string =>
  `#${rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** `fg` blended toward `bg` as `#rrggbb`: `t` 1 is exactly `fg`, 0 exactly `bg` (clamped to 0..1). */
export function blend(fg: string, bg: string, t: number): string {
  const k = Math.max(0, Math.min(1, t))
  return hex(fade(hexToRgb(fg), k, hexToRgb(bg)))
}

/** `t` snapped to the steps of a depth (`0, 0.1 .. 1` in truecolor, quarters in 256, 0 or 1 elsewhere). */
export function stepOf(t: number, depth: ColorDepth): number {
  const k = Math.max(0, Math.min(1, t))
  const steps = FADE_STEPS[depth]
  return steps === 0 ? (k >= 1 ? 1 : 0) : Math.round(k * steps) / steps
}

/**
 * A theme whose colours are `level` of the way from the background to their own value. Level 1 is
 * the theme itself; depths without a fade (16, none) are returned as they are: they never show a
 * level between 0 and 1. Colours stay tokens: nothing outside this package names one.
 */
export function fadeTheme(theme: Theme, level: number): Theme {
  const k = stepOf(level, theme.depth)
  if (k >= 1 || !canFade(theme.depth)) return theme
  const palette = PALETTES[theme.name]
  const bg = palette.bg
  const color = (token: Token): string | undefined => {
    const swatch = palette[token]
    if (theme.depth === 'truecolor') return blend(swatch.hex, bg.hex, k)
    return `ansi256(${quantize256(fade(hexToRgb(swatch.hex), k, hexToRgb(bg.hex)))})`
  }
  const faded: Theme = {
    name: theme.name,
    depth: theme.depth,
    color,
    fg: (token) => ({ color: color(token) as string }),
    bg: (token) => ({ backgroundColor: color(token) as string }),
    muted: () => faded.fg('text-muted'),
  }
  return faded
}
