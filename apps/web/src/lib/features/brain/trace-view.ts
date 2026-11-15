import { BRAIN_REGIONS, type TraceEntry, traceText } from '@keith/app-model'
import type { BrainRegion } from '@keith/contracts'
import { regionLabel } from '../live/view.ts'

// View models of the Brain screen: the trace as rows (`/brain trace`), filtered by region, newest first.

export interface TraceRowView {
  key: string
  /** `09:41:07`, the arrival time in the viewer's zone. */
  time: string
  region: BrainRegion
  label: string
  text: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function clockText(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** The trace as rows, newest first (the state keeps it newest last); `region` keeps one region's events. */
export function traceRowsOf(
  trace: readonly TraceEntry[],
  region: BrainRegion | undefined = undefined,
): TraceRowView[] {
  return trace
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => region === undefined || e.region === region)
    .reverse()
    .map(({ e, i }) => ({
      key: `${i}-${e.at}`,
      time: clockText(e.at),
      region: e.region,
      label: regionLabel(e.region),
      text: traceText(e),
    }))
}

/** `last 12 events` / `3 of the last 12 events` under a filter. */
export function traceHeading(total: number, shown: number): string {
  const events = `${total === 1 ? 'event' : 'events'}`
  return shown === total ? `last ${total} ${events}` : `${shown} of the last ${total} ${events}`
}

/** The regions that have an event in the trace, in the panel's order: the filter offers only those. */
export function regionsInTrace(trace: readonly TraceEntry[]): BrainRegion[] {
  const seen = new Set(trace.map((e) => e.region))
  return BRAIN_REGIONS.filter((r) => seen.has(r))
}

export const NO_TRACE = 'No brain events yet. Send a message and they appear here.'
