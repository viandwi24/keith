import { describe, expect, test } from 'bun:test'
import { DARK, LIGHT, ORB_COLORS, PLAIN } from './fixtures.ts'
import { MODE_DEFS, MODES, Orb, POINTS, RINGS } from './orb.ts'
import { BRIGHTNESS_STEPS, DOT_BITS, rasterize } from './raster.ts'

describe('orb', () => {
  test('emits rings x points particles within the orb radius', () => {
    const orb = new Orb(ORB_COLORS, () => 0.5)
    const ps = orb.step(0.03)
    expect(ps.length).toBe(RINGS * POINTS)
    expect(RINGS).toBe(46)
    expect(POINTS).toBe(132)
    expect(ps.every((p) => Math.hypot(p.x, p.y) < 330)).toBe(true)
  })

  test('five modes, each with motion parameters', () => {
    expect(MODES).toEqual(['idle', 'listening', 'thinking', 'speaking', 'alert'])
    for (const m of MODES) expect(MODE_DEFS[m].speed).toBeGreaterThan(0)
  })

  test('colour eases toward the colour of the mode, not instantly', () => {
    const orb = new Orb(ORB_COLORS, () => 0.5)
    orb.mode = 'alert'
    orb.step(0.03)
    expect(orb.color[0]).toBeGreaterThan(212)
    expect(orb.color[0]).toBeLessThan(248)
    for (let i = 0; i < 300; i++) orb.step(0.03)
    expect(Math.round(orb.color[0])).toBe(ORB_COLORS.alert[0])
    expect(Math.round(orb.color[2])).toBe(ORB_COLORS.alert[2])
  })

  test('the injected random makes it deterministic', () => {
    const a = new Orb(ORB_COLORS, () => 0.3)
    const b = new Orb(ORB_COLORS, () => 0.3)
    expect(a.step(0.04)).toEqual(b.step(0.04))
  })

  test('a long frame gap is clamped to 50 ms', () => {
    const a = new Orb(ORB_COLORS, () => 0.5)
    const b = new Orb(ORB_COLORS, () => 0.5)
    expect(a.step(5)).toEqual(b.step(0.05))
  })
})

describe('rasterize', () => {
  test('fills the requested grid with braille cells', () => {
    const orb = new Orb(ORB_COLORS, () => 0.5)
    const lines = rasterize(orb.step(0.03), 60, 24, orb.color, DARK)
    expect(lines.length).toBe(24)
    expect(lines.join('')).toMatch(/[⠁-⣿]/)
  })

  test('the 2x4 dot bits cover every braille dot once', () => {
    expect(DOT_BITS.flat().reduce((a, b) => a | b, 0)).toBe(0xff)
    expect(new Set(DOT_BITS.flat()).size).toBe(8)
  })

  test('a single particle lights one dot in the middle', () => {
    const lines = rasterize([{ x: 0, y: 0, a: 1 }], 10, 4, [255, 255, 255], PLAIN)
    const lit = lines.join('').match(/[⠁-⣿]/g) ?? []
    expect(lit.length).toBe(1)
  })

  test('cellAspect changes the horizontal spread', () => {
    const orb = new Orb(ORB_COLORS, () => 0.5)
    const ps = orb.step(0.03)
    const width = (aspect: number) => {
      const rows = rasterize(ps, 80, 20, orb.color, PLAIN, aspect)
      const used = rows
        .flatMap((r) => [...r].map((ch, i) => (ch === ' ' ? -1 : i)))
        .filter((i) => i >= 0)
      return Math.max(...used) - Math.min(...used)
    }
    expect(width(0.5)).not.toBe(width(0.35))
  })

  test('brightness is stepped so a row carries few distinct colours', () => {
    const orb = new Orb(ORB_COLORS, () => 0.5)
    const codes = new Set(
      rasterize(orb.step(0.03), 80, 30, orb.color, DARK)
        .join('')
        .match(/38;2;[0-9;]+m/g),
    )
    expect(codes.size).toBeLessThanOrEqual(BRIGHTNESS_STEPS + 1)
  })

  test('a light background fades toward white, not black', () => {
    const orb = new Orb(ORB_COLORS, () => 0.5)
    const ps = orb.step(0.03)
    const first = (env: typeof DARK) =>
      (
        rasterize(ps, 60, 24, [20, 20, 20], env)
          .join('')
          .match(/38;2;(\d+);/g) ?? []
      ).map((m) => Number.parseInt(m.slice(5), 10))
    const onDark = first(DARK)
    const onLight = first(LIGHT)
    expect(Math.max(...onLight)).toBeGreaterThan(100)
    expect(Math.max(...onDark)).toBeLessThanOrEqual(30)
  })

  test('none depth has no escape codes', () => {
    const orb = new Orb(ORB_COLORS, () => 0.5)
    const lines = rasterize(orb.step(0.03), 40, 16, orb.color, PLAIN)
    expect(lines.join('')).not.toContain(String.fromCharCode(27))
    expect(lines.every((l) => [...l].length === 40)).toBe(true)
  })
})
