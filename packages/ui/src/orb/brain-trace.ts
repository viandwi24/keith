import { type ColorEnv, fade, paint, type Rgb } from './color.ts'
import { DOT_BITS } from './raster.ts'

// Brain-region activity drawn as a scrolling EKG-style trace. The caller fires regions (the real
// feed comes from the brain events); colours come in as arguments.

export const REGIONS = [
  'thalamus',
  'wernicke',
  'broca',
  'cortex',
  'motor',
  'amygdala',
  'ras',
  'hippocampus',
  'parietal',
  'hypothalamus',
  'corpus-callosum',
  'prefrontal',
] as const
export type Region = (typeof REGIONS)[number]

/** Colours the trace paints with: one per region, a muted one for idle regions. */
export interface BrainColors {
  regions: Record<Region, Rgb>
  muted: Rgb
}

// Two columns, read top to bottom, like the Brain panel in the TUI.
const LIST_ORDER: readonly (readonly Region[])[] = [
  ['thalamus', 'broca', 'motor', 'ras', 'parietal', 'corpus-callosum'],
  ['wernicke', 'cortex', 'amygdala', 'hippocampus', 'hypothalamus', 'prefrontal'],
]
const NAME_WIDTH = 11
/** Names longer than the column are shortened, so the list keeps its width (Home and the header depend on it). */
const SHORT_NAME: Partial<Record<Region, string>> = {
  hypothalamus: 'Hypothal.',
  'corpus-callosum': 'Rooms',
}
const COLUMN_WIDTH = 2 + NAME_WIDTH + 1 + 1
const COLUMN_GAP = 2
export const LIST_WIDTH = COLUMN_WIDTH * 2 + COLUMN_GAP
export const LIST_ROWS = 6 // twelve regions in two columns
const BARS = '▁▂▃▄▅▆▇█'
const SEPARATOR = ' › '

interface Sample {
  level: number
  region: Region
}

const SAMPLE_HZ = 40
export const MAX_SAMPLES = 600
const MAX_TRAIL = 4

const titled = (r: Region): string => r.charAt(0).toUpperCase() + r.slice(1)

export class BrainTrace {
  private energy = Object.fromEntries(REGIONS.map((r) => [r, 0])) as Record<Region, number>
  private samples: Sample[] = []
  private acc = 0
  private recent: Region[] = []

  constructor(private readonly random: () => number = Math.random) {}

  fire(region: Region, strength = 1) {
    this.energy[region] = Math.min(1, this.energy[region] + strength)
    if (this.recent[this.recent.length - 1] !== region) this.recent.push(region)
    if (this.recent.length > MAX_TRAIL) this.recent.shift()
  }

  /** The energy of a region, 0..1. */
  level(region: Region): number {
    return this.energy[region]
  }

  step(dt: number) {
    const decay = Math.exp(-dt * 4)
    for (const r of REGIONS) this.energy[r] *= decay
    this.acc += dt
    while (this.acc >= 1 / SAMPLE_HZ) {
      this.acc -= 1 / SAMPLE_HZ
      let best: Region = 'ras'
      let max = 0
      let sum = 0
      for (const r of REGIONS) {
        sum += this.energy[r]
        if (this.energy[r] > max) {
          max = this.energy[r]
          best = r
        }
      }
      // faint resting tremor so the line never looks dead
      const level = Math.min(1, max * 0.8 + (sum - max) * 0.2 + 0.03 + this.random() * 0.03)
      this.samples.push({ level, region: best })
      if (this.samples.length > MAX_SAMPLES) this.samples.shift()
    }
  }

  /** Number of samples kept (the trace scrolls: oldest dropped past MAX_SAMPLES). */
  get sampleCount(): number {
    return this.samples.length
  }

  /** Names of the last fired regions, oldest first. */
  get trail(): readonly Region[] {
    return this.recent
  }

  /** The newest regions of the trail whose names joined with ` › ` fit in `maxWidth` cells. */
  trailFit(maxWidth = Number.POSITIVE_INFINITY): Region[] {
    const shown: Region[] = []
    let width = 0
    for (const r of [...this.recent].reverse()) {
      const next = width + r.length + (shown.length ? SEPARATOR.length : 0)
      if (next > maxWidth) break
      shown.unshift(r)
      width = next
    }
    return shown
  }

  /** Render the newest samples as braille, mirrored around the middle line: `rows` strings of `cols` cells. */
  render(cols: number, rows: number, colors: BrainColors, env: ColorEnv): string[] {
    const dotsW = cols * 2
    const dotsH = rows * 4
    const mid = dotsH / 2
    const bits = new Uint8Array(cols * rows)
    const peak = new Float32Array(cols * rows)
    const owner: Region[] = Array.from({ length: cols * rows }, () => 'ras')
    const visible = this.samples.slice(-dotsW)
    const offset = dotsW - visible.length
    visible.forEach((s, i) => {
      const x = offset + i
      const half = Math.round(s.level * mid)
      for (let y = Math.max(0, mid - 1 - half); y < Math.min(dotsH, mid + 1 + half); y++) {
        const cell = (y >> 2) * cols + (x >> 1)
        bits[cell] = (bits[cell] ?? 0) | (DOT_BITS[y & 3]?.[x & 1] ?? 0)
        if (s.level >= (peak[cell] ?? 0)) {
          peak[cell] = s.level
          owner[cell] = s.region
        }
      }
    })
    const lines: string[] = []
    for (let y = 0; y < rows; y++) {
      let line = ''
      for (let x = 0; x < cols; x++) {
        const b = bits[y * cols + x] ?? 0
        if (b === 0) {
          line += ' '
          continue
        }
        const ch = String.fromCharCode(0x2800 + b)
        const c = colors.regions[owner[y * cols + x] ?? 'ras']
        line += paint(
          ch,
          fade(c, 0.35 + 0.65 * (peak[y * cols + x] ?? 0), env.background),
          env.depth,
        )
      }
      lines.push(line)
    }
    return lines
  }

  /** Per-region indicator, `LIST_ROWS` rows of `LIST_WIDTH` cells: a dot that lights up and a one-char level bar. */
  renderList(colors: BrainColors, env: ColorEnv): string[] {
    const cell = (r: Region) => {
      const e = this.energy[r]
      const name = (SHORT_NAME[r] ?? titled(r)).padEnd(NAME_WIDTH)
      if (e < 0.08) return paint(`○ ${name}  `, colors.muted, env.depth)
      const bar = BARS[Math.min(BARS.length - 1, Math.floor(e * BARS.length))] ?? ' '
      return paint(`● ${name} ${bar}`, colors.regions[r], env.depth)
    }
    const [left = [], right = []] = LIST_ORDER
    return left.map((r, i) => {
      const other = right[i]
      return `${cell(r)}${' '.repeat(COLUMN_GAP)}${other ? cell(other) : ' '.repeat(COLUMN_WIDTH)}`
    })
  }

  /** Coloured names of the newest regions that fit in `maxWidth` cells, e.g. `wernicke › cortex`. */
  legend(colors: BrainColors, env: ColorEnv, maxWidth = Number.POSITIVE_INFINITY): string {
    const sep = paint('›', colors.muted, env.depth)
    return this.trailFit(maxWidth)
      .map((r) => paint(r, colors.regions[r], env.depth))
      .join(` ${sep} `)
  }
}
