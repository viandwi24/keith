import { ORB_RADIUS, type Particle, type Rgb } from '@keith/ui/orb'

// Drawing the orb model on a canvas: particles are grouped by brightness into a few steps, so a frame sets the fill style a handful
// of times instead of once per particle. Nothing here reads the DOM: the context is the part of `CanvasRenderingContext2D` used.

export const ALPHA_STEPS = 8

export interface Canvas2D {
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillStyle: string | CanvasGradient | CanvasPattern
}

/** Brightness 0..1 of a particle as one of `ALPHA_STEPS + 1` opacities (the terminal's brightness curve, as alpha). */
export const alphaOf = (a: number): number =>
  0.25 + (0.75 * Math.round(Math.max(0, Math.min(1, a)) * ALPHA_STEPS)) / ALPHA_STEPS

export const rgba = (rgb: Rgb, alpha: number): string =>
  `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${alpha.toFixed(3)})`

/** Pixels per design unit: the orb spans about +-ORB_RADIUS around the centre of a `size` square. */
export const scaleFor = (size: number): number => size / 2 / ORB_RADIUS

/** Particle positions in canvas pixels, grouped by opacity step (flat `x, y` pairs). */
export function bucketParticles(
  particles: readonly Particle[],
  size: number,
): Map<number, number[]> {
  const scale = scaleFor(size)
  const half = size / 2
  const buckets = new Map<number, number[]>()
  for (const p of particles) {
    const key = alphaOf(p.a)
    let list = buckets.get(key)
    if (list === undefined) {
      list = []
      buckets.set(key, list)
    }
    list.push(half + p.x * scale, half + p.y * scale)
  }
  return buckets
}

/** Draw one frame into a square canvas of `size` pixels (the caller scaled it for the device). */
export function drawOrb(
  ctx: Canvas2D,
  particles: readonly Particle[],
  rgb: Rgb,
  size: number,
  dot: number,
): void {
  ctx.clearRect(0, 0, size, size)
  for (const [alpha, points] of bucketParticles(particles, size)) {
    ctx.fillStyle = rgba(rgb, alpha)
    for (let i = 0; i < points.length; i += 2)
      ctx.fillRect((points[i] ?? 0) - dot / 2, (points[i + 1] ?? 0) - dot / 2, dot, dot)
  }
}
