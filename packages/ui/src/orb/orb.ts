// Voice orb: concentric rings of particles whose radius is displaced by traveling waves.
// Pure model, no I/O. Colours are an argument: the Ink layer resolves them from theme tokens.

import type { Rgb } from './color.ts'

export type OrbMode = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert'

export const MODES: readonly OrbMode[] = ['idle', 'listening', 'thinking', 'speaking', 'alert']

/** The colour of each mode. */
export type OrbColors = Record<OrbMode, Rgb>

interface ModeDef {
  amp: number
  voice: number
  speed: number
  swirl: number
  jitter: number
}

export const MODE_DEFS: Record<OrbMode, ModeDef> = {
  idle: { amp: 5, voice: 0, speed: 0.7, swirl: 0, jitter: 0 },
  listening: { amp: 7, voice: 30, speed: 1.5, swirl: 0, jitter: 0 },
  thinking: { amp: 12, voice: 0, speed: 1.1, swirl: 0.7, jitter: 0 },
  speaking: { amp: 9, voice: 46, speed: 2.1, swirl: 0, jitter: 0 },
  alert: { amp: 14, voice: 0, speed: 3.0, swirl: 0, jitter: 7 },
}

/** A particle in design space: the orb spans about +-290 units around (0, 0). */
export interface Particle {
  x: number
  y: number
  /** 0..1 brightness */
  a: number
}

export const ORB_RADIUS = 300
export const RINGS = 46
export const POINTS = 132

export class Orb {
  mode: OrbMode = 'idle'
  /** The current colour, eased toward the colour of `mode`. */
  color: [number, number, number]
  colors: OrbColors
  private t = 0
  private phase = 0
  private swirlPhase = 0
  private voiceLevel = 0
  private amp = 5
  private p = { speed: 0.7, swirl: 0, jitter: 0, voice: 0, base: 5 }

  constructor(
    colors: OrbColors,
    private readonly random: () => number = Math.random,
  ) {
    this.colors = colors
    this.color = [...colors.idle]
  }

  /** Advance by `dt` seconds (clamped like the design) and return the particles. */
  step(dt: number): Particle[] {
    dt = Math.min(0.05, Math.max(0, dt))
    this.t += dt
    const t = this.t
    const m = MODE_DEFS[this.mode]
    const p = this.p
    const ease = (rate: number) => 1 - Math.exp(-dt * rate)
    const e = ease(2.2)
    p.speed += (m.speed - p.speed) * e
    p.swirl += (m.swirl - p.swirl) * e
    p.jitter += (m.jitter - p.jitter) * e
    p.voice += (m.voice - p.voice) * e
    p.base += (m.amp - p.base) * e
    this.phase += dt * p.speed
    this.swirlPhase += dt * p.swirl

    let raw =
      Math.sin(t * 6.3) * 0.45 +
      Math.sin(t * 11.7 + 1) * 0.3 +
      Math.sin(t * 2.3) * 0.35 +
      (this.random() - 0.5) * 0.2
    raw = Math.max(0, raw)
    if (Math.sin(t * 0.9) > 0.72) raw *= 0.15
    this.voiceLevel += (raw - this.voiceLevel) * ease(10)
    this.amp += (p.base + this.voiceLevel * p.voice - this.amp) * ease(5)
    const ec = ease(2.5)
    const target = this.colors[this.mode]
    for (let k = 0; k < 3; k++) {
      this.color[k] = (this.color[k] ?? 0) + ((target[k] ?? 0) - (this.color[k] ?? 0)) * ec
    }

    const out: Particle[] = []
    const breath = 1 + 0.025 * Math.sin(t * 1.3)
    for (let i = 0; i < RINGS; i++) {
      const f = i / (RINGS - 1)
      const r0 = (80 + f * 196) * breath
      const a = 0.12 + 0.78 * Math.sin(Math.PI * (0.15 + f * 0.85)) ** 1.4
      const swirl = this.swirlPhase * (1.2 - f)
      for (let j = 0; j < POINTS; j++) {
        const th = (j / POINTS) * Math.PI * 2 + swirl + i * 0.035
        const d =
          Math.sin(th * 3 + this.phase + i * 0.2) * 0.55 +
          Math.sin(th * 5 - this.phase * 0.7 + i * 0.13) * 0.3 +
          Math.sin(th * 2 + t * 0.4) * 0.15
        let r = r0 + d * this.amp * (0.3 + f)
        if (p.jitter > 0.05) r += (this.random() - 0.5) * p.jitter
        out.push({ x: Math.cos(th) * r, y: Math.sin(th) * r, a })
      }
    }
    return out
  }
}
