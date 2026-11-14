import type { BrainEvent, BrainRegion, DreamRunReason, DreamRunStatus } from '@keith/contracts'
import { dreamDividerOf } from '../memory/index.ts'

/** Regions in the order the panel lists them. */
export const REGIONS: readonly BrainRegion[] = [
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
]

/** How long a region stays lit after its last event. */
export const FADE_MS = 1500

/** Most events kept for `/brain trace`. */
export const TRACE_LIMIT = 50

export interface TraceEntry {
  /** Arrival time (epoch ms, local clock). */
  at: number
  region: BrainRegion
  text: string
}

export interface BrainState {
  /** Arrival time of the last event of each region (local clock, so a skewed server is harmless). */
  lastAt: Partial<Record<BrainRegion, number>>
  /** Task ids of the workers that started and have not ended. */
  cortexActive: readonly string[]
  /** The latest event, as one line. */
  last: TraceEntry | undefined
  /** Newest last, at most {@link TRACE_LIMIT}. */
  trace: readonly TraceEntry[]
  /** The dream run between its `start` and `end` brain events (hippocampus), by run id; undefined when none runs. */
  dreaming: string | undefined
}

export const initialBrain: BrainState = {
  lastAt: {},
  cortexActive: [],
  last: undefined,
  trace: [],
  dreaming: undefined,
}

/**
 * One line for a dream event: `dreaming…` at its start (the panel reads no count from it), and at its end the counts that
 * changed, e.g. `dream: 2 promoted, 1 merged`; `dream: nothing to change` when none did. A run that failed, was refused or was
 * skipped says its cause instead (the same words as the chat divider), so a failure never reads as nothing to change.
 */
export function dreamLineOf(payload: {
  phase?: 'start' | 'end' | undefined
  status?: DreamRunStatus | undefined
  reason?: DreamRunReason | null | undefined
  candidates?: number
  promoted: number
  merged: number
  superseded: number
  dropped: number
}): string {
  if (payload.phase === 'start') return 'dreaming…'
  if (payload.status !== undefined && payload.status !== 'applied' && payload.status !== 'staged')
    return dreamDividerOf({
      status: payload.status,
      reason: payload.reason ?? null,
      counts: {
        candidates: payload.candidates ?? 0,
        promoted: payload.promoted,
        merged: payload.merged,
        superseded: payload.superseded,
        dropped: payload.dropped,
      },
    })
  const parts = [
    [payload.promoted, 'promoted'],
    [payload.merged, 'merged'],
    [payload.superseded, 'superseded'],
    [payload.dropped, 'dropped'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}`)
  return parts.length === 0 ? 'dream: nothing to change' : `dream: ${parts.join(', ')}`
}

/** One line for an event, e.g. `cortex.research step 4`. */
export function describeEvent(event: BrainEvent): string {
  switch (event.type) {
    case 'brain.thalamus.routed':
      return `thalamus routed ${event.payload.sessionId}`
    case 'brain.wernicke.start':
      return `wernicke understands (${event.payload.kind})`
    case 'brain.broca.start':
      return `broca answers (${event.payload.kind})`
    case 'brain.broca.end':
      return `broca done (${event.payload.stop})`
    case 'brain.cortex.start':
      return `${event.payload.agent} start`
    case 'brain.cortex.step':
      return `${event.payload.agent} step ${event.payload.stepIndex + 1}`
    case 'brain.cortex.end':
      return `${event.payload.agent} ${event.payload.status}`
    case 'brain.motor.act':
      return `motor ${event.payload.toolName} ${event.payload.ok ? 'ok' : 'failed'}`
    case 'brain.amygdala.decide':
      return `amygdala ${event.payload.approved ? 'approved' : 'denied'} ${event.payload.toolName}`
    case 'brain.amygdala.wait':
      return `amygdala waits for approval: ${event.payload.toolName} (${event.payload.count})`
    case 'brain.amygdala.expired':
      return `amygdala expired an approval for ${event.payload.sessionId}`
    case 'brain.hippocampus.write':
      return `hippocampus ${event.payload.op} ${event.payload.path}`
    case 'brain.hippocampus.recall':
      return `hippocampus recalls ${event.payload.path}`
    case 'brain.ras.deliver':
      return `ras delivered ${event.payload.taskId}`
    case 'brain.parietal.presence':
      return event.payload.previous === null
        ? `parietal presence ${event.payload.state}`
        : `parietal presence ${event.payload.previous} → ${event.payload.state}`
    case 'brain.parietal.deliver':
      return `parietal delivers ${event.payload.capability}: ${event.payload.name}`
    case 'brain.hypothalamus.fire':
      return `hypothalamus starts a ${event.payload.trigger} protocol`
    case 'brain.hypothalamus.step':
      return `hypothalamus ${event.payload.kind} step: ${event.payload.outcome}`
    case 'brain.hypothalamus.wait':
      return 'hypothalamus waits for a time'
    case 'brain.hypothalamus.end':
      return `hypothalamus run ${event.payload.status}`
    case 'brain.corpus-callosum.invite':
      return 'rooms: an invitation arrived'
    case 'brain.corpus-callosum.join':
      return 'rooms: someone joined a room'
    case 'brain.corpus-callosum.turn':
      return event.payload.stop === undefined
        ? 'rooms turn refused'
        : `rooms turn done (${event.payload.stop})`
    case 'brain.corpus-callosum.end':
      return 'rooms ended'
    case 'brain.prefrontal.change':
      return `persona changed (version ${event.payload.version}, ${event.payload.reason})`
    case 'brain.prefrontal.style':
      return `persona style changed: ${event.payload.fields.join(', ')}`
    case 'brain.hippocampus.dream':
      return dreamLineOf(event.payload)
  }
}

/** Fold one event into the state. Pure: `at` is the arrival time. */
export function reduceBrain(state: BrainState, event: BrainEvent, at: number): BrainState {
  const region = event.payload.region
  let cortexActive = state.cortexActive
  if (event.type === 'brain.cortex.start' || event.type === 'brain.cortex.step') {
    const id = event.payload.taskId
    if (!cortexActive.includes(id)) cortexActive = [...cortexActive, id]
  } else if (event.type === 'brain.cortex.end') {
    const id = event.payload.taskId
    cortexActive = cortexActive.filter((t) => t !== id)
  }
  let dreaming = state.dreaming
  if (event.type === 'brain.hippocampus.dream')
    dreaming = event.payload.phase === 'start' ? event.payload.runId : undefined
  const entry: TraceEntry = { at, region, text: describeEvent(event) }
  return {
    lastAt: { ...state.lastAt, [region]: at },
    cortexActive,
    last: entry,
    trace: [...state.trace, entry].slice(-TRACE_LIMIT),
    dreaming,
  }
}

/**
 * After a feed resync: the feed sends no history, so an end event missed while the link was down would leave `dreaming`
 * set forever. The run is forgotten; a later start sets it again. Other state (lamps, trace) stays as it is.
 */
export function resyncBrain(state: BrainState): BrainState {
  return state.dreaming === undefined ? state : { ...state, dreaming: undefined }
}

/** `lit` (event within the fade), `working` (cortex with active workers) or `idle`. */
export type Lamp = 'lit' | 'working' | 'idle'

export function lampOf(state: BrainState, region: BrainRegion, now: number, fadeMs: number): Lamp {
  if (region === 'cortex' && state.cortexActive.length > 0) return 'working'
  if (region === 'hippocampus' && state.dreaming !== undefined) return 'working'
  const at = state.lastAt[region]
  return at !== undefined && now - at < fadeMs ? 'lit' : 'idle'
}

export interface RegionView {
  region: BrainRegion
  lamp: Lamp
  /** Active workers (cortex only). */
  count: number
}

/** What the panel draws at `now`. */
export function viewOf(state: BrainState, now: number, fadeMs: number = FADE_MS): RegionView[] {
  return REGIONS.map((region) => ({
    region,
    lamp: lampOf(state, region, now, fadeMs),
    count: region === 'cortex' ? state.cortexActive.length : 0,
  }))
}

/** A compact key of a view: the panel re-renders only when it changes. */
export function viewKey(view: readonly RegionView[], last: TraceEntry | undefined): string {
  return `${view.map((r) => `${r.lamp}${r.count}`).join('')}|${last?.at ?? ''}${last?.text ?? ''}`
}
