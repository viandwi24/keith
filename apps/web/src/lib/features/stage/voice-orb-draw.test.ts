import { describe, expect, test } from 'bun:test'
import { Orb, POINTS, RINGS, VOICE_ORB_PALETTE } from '@keith/ui/orb'
import {
  DESIGN_SIZE,
  dotSize,
  drawVoiceOrb,
  GLOW_RADIUS,
  glowAlpha,
  orbSizeFor,
  rgbText,
  type VoiceCanvas2D,
} from './voice-orb-draw.ts'

const fakeCtx = () => {
  const calls = {
    clear: 0,
    rects: [] as { x: number; y: number; w: number }[],
    styles: [] as string[],
    gradients: [] as { r1: number; stops: [number, string][] }[],
  }
  const ctx: VoiceCanvas2D = {
    clearRect: () => void calls.clear++,
    fillRect: (x, y, w) => void calls.rects.push({ x, y, w }),
    createRadialGradient: (_x0, _y0, _r0, _x1, _y1, r1) => {
      const g = { r1, stops: [] as [number, string][] }
      calls.gradients.push(g)
      return {
        addColorStop: (o: number, c: string) => void g.stops.push([o, c]),
      } as unknown as CanvasGradient
    },
    set fillStyle(v) {
      calls.styles.push(typeof v === 'string' ? v : 'gradient')
    },
    get fillStyle() {
      return ''
    },
  }
  return { ctx, calls }
}

describe('voice orb drawing', () => {
  const orb = new Orb(VOICE_ORB_PALETTE.orb, () => 0.5)
  const particles = orb.step(0)

  test('clears, paints the glow, then one fill style per ring', () => {
    const { ctx, calls } = fakeCtx()
    drawVoiceOrb(ctx, particles, [212, 212, 212], 5, DESIGN_SIZE)
    expect(calls.clear).toBe(1)
    expect(calls.styles[0]).toBe('gradient')
    expect(calls.styles.length).toBe(1 + RINGS)
    // the glow covers the canvas, then every particle is a dot
    expect(calls.rects.length).toBe(1 + RINGS * POINTS)
    expect(calls.gradients[0]?.r1).toBe(GLOW_RADIUS)
    expect(calls.gradients[0]?.stops[0]?.[1]).toBe(`rgba(212,212,212,${glowAlpha(5).toFixed(3)})`)
  })

  test('each ring keeps the opacity of the design (faint inside and outside, bright between)', () => {
    const { ctx, calls } = fakeCtx()
    drawVoiceOrb(ctx, particles, [255, 255, 255], 5, DESIGN_SIZE)
    const alphas = calls.styles.slice(1).map((s) => Number(s.slice(s.lastIndexOf(',') + 1, -1)))
    const inner = alphas[0] ?? 0
    const outer = alphas[RINGS - 1] ?? 0
    const peak = Math.max(...alphas)
    expect(inner).toBeLessThan(0.5)
    expect(outer).toBeLessThan(0.3)
    expect(peak).toBeGreaterThan(0.85)
  })

  test('dots grow toward the outside and scale with the canvas', () => {
    expect(dotSize(0, 1)).toBeCloseTo(1.1)
    expect(dotSize(RINGS - 1, 1)).toBeCloseTo(2)
    expect(dotSize(RINGS - 1, 2)).toBeCloseTo(4)
  })

  test('the orb sits in the centre of the canvas', () => {
    const { ctx, calls } = fakeCtx()
    drawVoiceOrb(ctx, particles, [255, 255, 255], 5, 1440)
    const dots = calls.rects.slice(1)
    const mx = dots.reduce((s, d) => s + d.x + d.w / 2, 0) / dots.length
    const my = dots.reduce((s, d) => s + d.y + d.w / 2, 0) / dots.length
    expect(Math.abs(mx - 720)).toBeLessThan(4)
    expect(Math.abs(my - 720)).toBeLessThan(4)
  })

  test('colour text and size for a viewport', () => {
    expect(rgbText([74.4, 222.6, 128])).toBe('74,223,128')
    expect(orbSizeFor(1440, 900)).toBe(720)
    expect(orbSizeFor(375, 812)).toBe(343)
    expect(orbSizeFor(1440, 500)).toBe(400)
    expect(orbSizeFor(100, 100)).toBe(160)
  })
})
