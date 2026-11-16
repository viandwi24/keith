import type { BrainEvent, BrainRegion } from '@keith/contracts'
import type { OrbMode } from '@keith/ui/orb'

/** How long the last words stay under the orb after the turn ended. */
export const SUBTITLE_HOLD_MS = 8000

/** The live state the orb mode comes from. */
export interface OrbInput {
  /** Logged out, core down, offline (the web adds an approval waiting). */
  alert: boolean
  /** The front turn runs. */
  busy: boolean
  /** Assistant text is streaming right now. */
  speaking: boolean
  /** The chat draft is not empty. */
  typing: boolean
}

/** alert, speaking, thinking, listening, else idle: real state only. */
export function orbModeOf({ alert, busy, speaking, typing }: OrbInput): OrbMode {
  if (alert) return 'alert'
  if (busy) return speaking ? 'speaking' : 'thinking'
  return typing ? 'listening' : 'idle'
}

/** The region an event belongs to: `brain.<region>.<what>`. */
export const regionOf = (event: BrainEvent): BrainRegion => event.type.split('.')[1] as BrainRegion

const STRENGTH: Partial<Record<BrainEvent['type'], number>> = {
  'brain.cortex.step': 0.25,
  'brain.cortex.start': 0.5,
  'brain.cortex.end': 0.4,
  'brain.broca.start': 0.8,
  'brain.broca.end': 0.4,
  'brain.motor.act': 0.8,
  'brain.amygdala.decide': 0.55,
  'brain.amygdala.wait': 0.4,
  'brain.parietal.presence': 0.4,
  'brain.parietal.deliver': 0.6,
  'brain.parietal.workspace': 0.6,
}

/** How hard an event fires its region on the trace (default 0.5). */
export const strengthOf = (event: BrainEvent): number => STRENGTH[event.type] ?? 0.5

/** Markdown to plain words for the subtitle: fences, code, headings, emphasis, links, list marks. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(\S[^*]*)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
