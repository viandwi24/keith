import { describe, expect, test } from 'bun:test'
import { BrainTrace, Orb, orbPaletteOf } from '@keith/ui/orb'
import {
  ALPHA_STEPS,
  alphaOf,
  bucketParticles,
  type Canvas2D,
  drawOrb,
  rgba,
  scaleFor,
} from './orb-draw.ts'
import { barsFor, drawTrace, traceBars } from './trace-draw.ts'

const fakeCtx = () => {
  const calls = { clear: 0, rects: 0, styles: new Set<string>() }
  let style = ''
  const ctx: Canvas2D = {
    clearRect: () => void calls.clear++,
    fillRect: () => void calls.rects++,
    get fillStyle() {
      return style
    },
    set fillStyle(v) {
      style = String(v)
      calls.styles.add(style)
    },
  }
  return { ctx, calls }
}

describe('orb drawing', () => {
  test('opacity steps are few and stay in range', () => {
    expect(alphaOf(0)).toBe(0.25)
    expect(alphaOf(1)).toBe(1)
    expect(alphaOf(2)).toBe(1)
    expect(alphaOf(-1)).toBe(0.25)
    const steps = new Set(Array.from({ length: 101 }, (_, i) => alphaOf(i / 100)))
    expect(steps.size).toBe(ALPHA_STEPS + 1)
    expect(rgba([1.4, 2, 300], 0.5)).toBe('rgba(1,2,300,0.500)')
  })

  test('particles land inside the canvas and are grouped by opacity', () => {
    const colors = orbPaletteOf('dark').orb
    const orb = new Orb(colors, () => 0.5)
    const particles = orb.step(0.02)
    const buckets = bucketParticles(particles, 400)
    let n = 0
    for (const points of buckets.values()) {
      for (let i = 0; i < points.length; i += 2) {
        expect(points[i]).toBeGreaterThanOrEqual(0)
        expect(points[i]).toBeLessThanOrEqual(400)
        expect(points[i + 1]).toBeGreaterThanOrEqual(0)
        expect(points[i + 1]).toBeLessThanOrEqual(400)
      }
      n += points.length / 2
    }
    expect(n).toBe(particles.length)
    expect(scaleFor(600)).toBe(1)
  })

  test('a frame clears once, sets the style a few times and draws every particle', () => {
    const { ctx, calls } = fakeCtx()
    const orb = new Orb(orbPaletteOf('light').orb, () => 0.5)
    const particles = orb.step(0.02)
    drawOrb(ctx, particles, orb.color, 300, 2)
    expect(calls.clear).toBe(1)
    expect(calls.rects).toBe(particles.length)
    expect(calls.styles.size).toBeLessThanOrEqual(ALPHA_STEPS + 1)
  })
})

describe('trace drawing', () => {
  test('bars are mirrored around the middle, newest at the right edge', () => {
    const trace = new BrainTrace(() => 0)
    trace.fire('broca', 1)
    trace.step(0.1)
    const samples = trace.lastSamples(1000)
    expect(samples.length).toBeGreaterThan(0)
    const bars = traceBars(samples, 100, 40, 4)
    const cols = barsFor(100, 4)
    expect(bars.length).toBe(Math.min(cols, samples.length))
    for (const bar of bars) expect(bar.y0 + bar.y1).toBeCloseTo(40, 5)
    const last = bars.at(-1)
    expect((last?.x ?? 0) + 4).toBe(cols * 4)
  })

  test('drawTrace paints one bar per sample with the region colour', () => {
    const { ctx, calls } = fakeCtx()
    const trace = new BrainTrace(() => 0)
    trace.fire('cortex', 1)
    trace.step(0.05)
    drawTrace(ctx, trace.lastSamples(50), orbPaletteOf('dark').brain.regions, 200, 40, 3)
    expect(calls.clear).toBe(1)
    expect(calls.rects).toBe(trace.sampleCount)
  })
})
