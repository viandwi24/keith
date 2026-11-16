import { type Particle, POINTS, type Rgb, RINGS } from '@keith/ui/orb'

// Drawing the voice orb as the design does: a soft radial glow that follows the amplitude, then each ring in its own opacity with
// dots that grow toward the outside. The model's units are the design's pixels on a 720 px square, so `scale` is canvas px per unit.
// Nothing here reads the DOM: the context is the part of `CanvasRenderingContext2D` used.

/** The design's square: the orb spans about +-290 units around its centre. */
export const DESIGN_SIZE = 720
/** Radius of the glow behind the rings, in design units. */
export const GLOW_RADIUS = 320

export interface VoiceCanvas2D {
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradient
  fillStyle: string | CanvasGradient | CanvasPattern
}

export const rgbText = (rgb: Rgb): string =>
  `${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])}`

/** Opacity of the glow's centre: faint at rest, a little brighter while the voice swells. */
export const glowAlpha = (amplitude: number): number => 0.06 + amplitude * 0.002

/** Side of one dot of ring `ring` (0 = innermost), in canvas px. */
export const dotSize = (ring: number, scale: number): number =>
  (1.1 + (ring / (RINGS - 1)) * 0.9) * scale

/** Draw one frame into a square canvas of `size` px (already multiplied by the device pixel ratio). */
export function drawVoiceOrb(
  ctx: VoiceCanvas2D,
  particles: readonly Particle[],
  rgb: Rgb,
  amplitude: number,
  size: number,
): void {
  const scale = size / DESIGN_SIZE
  const c = size / 2
  const colour = rgbText(rgb)
  ctx.clearRect(0, 0, size, size)

  const glow = ctx.createRadialGradient(c, c, 0, c, c, GLOW_RADIUS * scale)
  glow.addColorStop(0, `rgba(${colour},${glowAlpha(amplitude).toFixed(3)})`)
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  // the model yields RINGS * POINTS particles, ring by ring; one fill style per ring
  for (let ring = 0; ring < RINGS; ring++) {
    const first = particles[ring * POINTS]
    if (first === undefined) break
    ctx.fillStyle = `rgba(${colour},${first.a.toFixed(3)})`
    const dot = dotSize(ring, scale)
    const half = dot / 2
    const end = Math.min(particles.length, (ring + 1) * POINTS)
    for (let k = ring * POINTS; k < end; k++) {
      const p = particles[k] as Particle
      ctx.fillRect(c + p.x * scale - half, c + p.y * scale - half, dot, dot)
    }
  }
}

/** The orb's side for a viewport: the design's 720 px when it fits, else what the width or 80 % of the height allows. */
export const orbSizeFor = (width: number, height: number, gutter = 16): number =>
  Math.max(160, Math.floor(Math.min(DESIGN_SIZE, width - gutter * 2, height * 0.8)))
