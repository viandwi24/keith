import { describe, expect, test } from 'bun:test'
import type { TraceEntry } from '@keith/app-model'
import { clockText, NO_TRACE, regionsInTrace, traceHeading, traceRowsOf } from './trace-view.ts'

const T0 = new Date(2026, 10, 14, 9, 41, 7).getTime()
const trace: TraceEntry[] = [
  { at: T0, region: 'thalamus', text: 'thalamus routed s1' },
  { at: T0 + 1000, region: 'cortex', text: 'cortex.research step 2' },
  { at: T0 + 2000, region: 'corpus-callosum', text: 'rooms ended' },
]

describe('trace rows', () => {
  test('newest first, without the region prefix, with the arrival time', () => {
    const rows = traceRowsOf(trace)
    expect(rows.map((r) => r.text)).toEqual(['rooms ended', 'research step 2', 'routed s1'])
    expect(rows[2]).toMatchObject({ time: '09:41:07', label: 'Thalamus', region: 'thalamus' })
    expect(rows[0]?.label).toBe('Rooms')
  })
  test('a region filter keeps its events', () => {
    expect(traceRowsOf(trace, 'cortex').map((r) => r.text)).toEqual(['research step 2'])
    expect(traceRowsOf(trace, 'broca')).toEqual([])
  })
  test('keys are unique even for events at the same instant', () => {
    const rows = traceRowsOf([trace[0] as TraceEntry, trace[0] as TraceEntry])
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })
  test('the heading counts events and the filtered share', () => {
    expect(traceHeading(1, 1)).toBe('last 1 event')
    expect(traceHeading(12, 12)).toBe('last 12 events')
    expect(traceHeading(12, 3)).toBe('3 of the last 12 events')
  })
  test('the filter offers only regions that occur, in the panel order', () => {
    expect(regionsInTrace(trace)).toEqual(['thalamus', 'cortex', 'corpus-callosum'])
  })
  test('clock and empty text', () => {
    expect(clockText(T0)).toBe('09:41:07')
    expect(NO_TRACE).toContain('No brain events yet')
  })
})
