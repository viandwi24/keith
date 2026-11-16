import { describe, expect, test } from 'bun:test'
import { BrainTrace, LIST_ROWS, VOICE_ORB_PALETTE } from '@keith/ui/orb'
import {
  columnAlpha,
  DOT_PITCH,
  type DotCanvas2D,
  dotColumns,
  drawBrainDots,
  gridOf,
  regionRows,
  trailOf,
} from './brain-draw.ts'

const colors = VOICE_ORB_PALETTE.brain

const fakeCtx = () => {
  const calls = { clear: 0, rects: [] as { x: number; y: number }[], styles: [] as string[] }
  const ctx: DotCanvas2D = {
    clearRect: () => void calls.clear++,
    fillRect: (x, y) => void calls.rects.push({ x, y }),
    set fillStyle(v) {
      calls.styles.push(String(v))
    },
    get fillStyle() {
      return ''
    },
  }
  return { ctx, calls }
}

describe('brain dots', () => {
  test('a grid of dots fits the canvas', () => {
    expect(gridOf(300, 60)).toEqual({ cols: 100, rows: 20 })
    expect(gridOf(1, 1)).toEqual({ cols: 1, rows: 2 })
  })

  test('newest samples at the right, a quiet sample lights the two middle rows', () => {
    const cols = dotColumns(
      [
        { level: 0, region: 'ras' },
        { level: 1, region: 'cortex' },
      ],
      30,
      60,
    )
    expect(cols.length).toBe(2)
    expect(cols[1]?.x).toBe(9 * DOT_PITCH)
    expect(cols[0]).toMatchObject({ from: 9, to: 10, region: 'ras' })
    expect(cols[1]).toMatchObject({ from: 0, to: 19, region: 'cortex' })
  })

  test('only the samples that fit are drawn, each column in its region colour', () => {
    const samples = Array.from({ length: 50 }, () => ({ level: 0, region: 'motor' as const }))
    const { ctx, calls } = fakeCtx()
    drawBrainDots(ctx, samples, colors.regions, 30, 60)
    expect(calls.clear).toBe(1)
    expect(calls.styles.length).toBe(10)
    expect(calls.rects.length).toBe(20)
    expect(calls.styles[0]).toContain(`,${columnAlpha(0).toFixed(3)})`)
  })
})

describe('region list and trail', () => {
  test('idle regions are muted, a fired one is lit with a bar', () => {
    const trace = new BrainTrace(() => 0)
    trace.fire('cortex', 1)
    const rows = regionRows(trace, colors)
    expect(rows.length).toBe(LIST_ROWS)
    const all = rows.flat()
    expect(all.length).toBe(12)
    const cortex = all.find((c) => c.region === 'cortex')
    expect(cortex).toMatchObject({ lit: true, bar: '█', label: 'Cortex' })
    const thalamus = all.find((c) => c.region === 'thalamus')
    expect(thalamus).toMatchObject({ lit: false, bar: '' })
    expect(all.find((c) => c.region === 'hypothalamus')?.label).toBe('Hypothal.')
  })

  test('the trail keeps the newest regions that fit', () => {
    const trace = new BrainTrace(() => 0)
    expect(trailOf(trace, colors, 40)).toEqual([])
    trace.fire('thalamus')
    trace.fire('wernicke')
    trace.fire('cortex')
    expect(trailOf(trace, colors, 40).map((t) => t.region)).toEqual([
      'thalamus',
      'wernicke',
      'cortex',
    ])
    expect(trailOf(trace, colors, 8).map((t) => t.region)).toEqual(['cortex'])
  })
})
