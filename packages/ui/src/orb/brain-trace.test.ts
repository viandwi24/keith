import { describe, expect, test } from 'bun:test'
import { BrainTrace, LIST_ROWS, LIST_WIDTH, MAX_SAMPLES, REGIONS } from './brain-trace.ts'
import { ESC, stripAnsi, visibleWidth } from './color.ts'
import { BRAIN_COLORS, DARK, LIGHT, PLAIN } from './fixtures.ts'

const busy = () => {
  const brain = new BrainTrace(() => 0.5)
  brain.fire('thalamus')
  brain.step(0.5)
  return brain
}

describe('BrainTrace', () => {
  test('firing raises a region and it decays', () => {
    const brain = new BrainTrace(() => 0.5)
    brain.fire('motor', 0.6)
    expect(brain.level('motor')).toBeCloseTo(0.6)
    brain.fire('motor', 0.6)
    expect(brain.level('motor')).toBe(1)
    brain.step(2)
    expect(brain.level('motor')).toBeLessThan(0.01)
  })

  test('samples are kept up to a cap', () => {
    const brain = new BrainTrace(() => 0.5)
    for (let i = 0; i < 100; i++) brain.step(1)
    expect(brain.sampleCount).toBe(MAX_SAMPLES)
  })

  test('render gives rows of exactly cols cells with the active region coloured', () => {
    const rows = busy().render(30, 4, BRAIN_COLORS, DARK)
    expect(rows.length).toBe(4)
    for (const r of rows) expect(visibleWidth(r)).toBe(30)
    expect(rows.join('')).toContain('38;2;')
  })

  test('none depth: the graph, list and legend carry no escape codes', () => {
    const brain = busy()
    const all = [
      ...brain.render(30, 4, BRAIN_COLORS, PLAIN),
      ...brain.renderList(BRAIN_COLORS, PLAIN),
      brain.legend(BRAIN_COLORS, PLAIN),
    ].join('')
    expect(all).not.toContain(ESC)
    expect(all).toContain('thalamus')
  })

  test('the region list has LIST_ROWS rows of LIST_WIDTH cells and lights fired regions', () => {
    const list = busy().renderList(BRAIN_COLORS, LIGHT)
    expect(list.length).toBe(LIST_ROWS)
    for (const row of list) expect(visibleWidth(row)).toBe(LIST_WIDTH)
    const text = stripAnsi(list.join('\n'))
    for (const r of REGIONS) {
      const shown =
        r === 'hypothalamus'
          ? 'Hypothal.'
          : r === 'corpus-callosum'
            ? 'Rooms'
            : r.charAt(0).toUpperCase() + r.slice(1)
      expect(text).toContain(shown)
    }
    expect(text).toContain('● Thalamus')
    expect(text).toContain('○ Cortex')
  })

  test('corpus-callosum (Rooms) has its own row in the list and lights when fired', () => {
    const brain = new BrainTrace(() => 0.5)
    brain.fire('corpus-callosum')
    brain.step(0.5)
    const text = stripAnsi(brain.renderList(BRAIN_COLORS, LIGHT).join('\n'))
    expect(text).toContain('● Rooms')
    expect(text).toContain('○ Cortex')
    expect(brain.trailFit()).toEqual(['corpus-callosum'])
  })

  test('parietal has its own row in the list and lights when fired', () => {
    const brain = new BrainTrace(() => 0.5)
    brain.fire('parietal')
    brain.step(0.5)
    const text = stripAnsi(brain.renderList(BRAIN_COLORS, LIGHT).join('\n'))
    expect(text).toContain('● Parietal')
    expect(text).toContain('○ Ras')
    expect(brain.trailFit()).toEqual(['parietal'])
  })
})

describe('trail fitting', () => {
  const brain = new BrainTrace(() => 0.5)
  for (const r of ['wernicke', 'cortex', 'broca', 'motor', 'ras'] as const) brain.fire(r)

  test('keeps the newest four, oldest first', () => {
    expect(brain.trail).toEqual(['cortex', 'broca', 'motor', 'ras'])
  })

  test('drops the oldest names until the joined trail fits the width', () => {
    expect(brain.trailFit()).toEqual(['cortex', 'broca', 'motor', 'ras'])
    // 'broca › motor › ras' = 5 + 3 + 5 + 3 + 3 = 19
    expect(brain.trailFit(19)).toEqual(['broca', 'motor', 'ras'])
    expect(brain.trailFit(18)).toEqual(['motor', 'ras'])
    expect(brain.trailFit(3)).toEqual(['ras'])
    expect(brain.trailFit(2)).toEqual([])
    expect(brain.trailFit(0)).toEqual([])
  })

  test('the legend never passes maxWidth', () => {
    for (let w = 0; w < 40; w++) {
      expect(visibleWidth(brain.legend(BRAIN_COLORS, DARK, w))).toBeLessThanOrEqual(w)
    }
  })
})
