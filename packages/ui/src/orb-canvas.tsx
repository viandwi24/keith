import { Box, Text } from 'ink'
import { useMemo, useRef } from 'react'
import { G } from './glyphs.ts'
import { useMotion } from './motion-context.tsx'
import { type ColorEnv, fade, type Rgb } from './orb/color.ts'
import { Orb, type OrbColors, type OrbMode } from './orb/orb.ts'
import { rasterize } from './orb/raster.ts'
import { Txt } from './text.tsx'
import { useFadeLevel } from './theme-context.tsx'
import { type FrameClock, useFrameClock } from './use-frame-clock.ts'
import { useOrbPalette } from './use-orb-palette.ts'

export interface OrbCanvasProps {
  mode: OrbMode
  /** Cells. */
  width: number
  height: number
  /** Cell width over cell height (default 0.5). */
  cellAspect?: number
  /** `false` freezes the orb and stops the timer. */
  running?: boolean
  /** Frames per second of the own timer (default 12, capped at 30). */
  fps?: number
  /** A clock shared with other animations of the screen; the canvas then has no timer of its own. */
  clock?: FrameClock
}

/**
 * The one still frame of the orb (`orbStatic`): frame 0 of a model that never steps, so the shape is
 * fixed and only the colour of `mode` is drawn. The jitter source is constant, so it is the same every
 * time.
 */
function stillRows(
  colors: OrbColors,
  mode: OrbMode,
  width: number,
  height: number,
  shade: (c: Rgb) => Rgb,
  env: ColorEnv,
  cellAspect: number,
): string[] {
  const still = new Orb(colors, () => 0.5)
  still.mode = mode
  // the colour of the state at once (a step would ease it, and a still frame does not ease)
  still.color = [...colors[mode]]
  return rasterize(still.step(0), width, height, shade(still.color), env, cellAspect)
}

/**
 * The voice orb as braille rows. Where colour is off (`none` depth) it does not animate: a static
 * `●` and the mode word. Under `orbStatic` (`--disable-orb`) it is one fixed frame: no timer, no
 * waves, and only its colour follows the mode.
 */
export function OrbCanvas({
  mode,
  width,
  height,
  cellAspect = 0.5,
  running = true,
  fps,
  clock,
}: OrbCanvasProps) {
  const palette = useOrbPalette({ faded: false })
  const level = useFadeLevel()
  const { orbStatic } = useMotion()
  const animated = palette.env.depth !== 'none'
  const own = useFrameClock({
    ...(fps === undefined ? {} : { fps }),
    running: running && animated && !clock && !orbStatic,
  })
  const { tick, dt } = clock ?? own
  const orb = useRef<Orb | null>(null)
  if (orb.current === null || orb.current.colors !== palette.orb) {
    const next = new Orb(palette.orb)
    if (orb.current) {
      next.color = [...orb.current.color]
    }
    orb.current = next
  }
  const rows = useMemo(() => {
    if (!animated) return []
    const fadeTo = (c: Rgb): Rgb => (level >= 1 ? c : fade(c, level, palette.env.background))
    if (orbStatic)
      return stillRows(palette.orb, mode, width, height, fadeTo, palette.env, cellAspect)
    const o = orb.current
    if (!o) return []
    o.mode = mode
    // `tick` is a dependency on purpose: a new frame steps the orb
    void tick
    const particles = o.step(running ? dt : 0)
    return rasterize(particles, width, height, fadeTo(o.color), palette.env, cellAspect)
  }, [
    animated,
    // a still orb ignores the clock: its frame does not change with a tick
    orbStatic ? 0 : tick,
    orbStatic ? 0 : dt,
    running,
    orbStatic,
    mode,
    width,
    height,
    cellAspect,
    palette,
    level,
  ])
  if (!animated) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Txt bold>{`${G.dot} ${mode}`}</Txt>
      </Box>
    )
  }
  return (
    <Box width={width} height={height} flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i} wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
  )
}
