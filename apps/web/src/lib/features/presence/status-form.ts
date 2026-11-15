import { BUSY_MAX_MINUTES, BUSY_NOTE_MAX } from '@keith/app-model'
import type { PresenceStatusKind, PresenceStatusSet } from '@keith/contracts'

// The stated-status form (ADR-0034 §5, P37): busy or out, a note, when it starts and when it ends. Pure: the draft in, a
// `presence.setStatus` input (or the sentence that says what is wrong) out.

export type StartMode = 'now' | 'at'
export type EndMode = 'after' | 'at' | 'open'

export interface StatusDraft {
  kind: PresenceStatusKind
  note: string
  start: StartMode
  /** A `datetime-local` value (`2026-11-14T15:00`, the viewer's zone). */
  startAt: string
  end: EndMode
  /** Minutes after the start (or now), 1 to 1440. */
  minutes: string
  endAt: string
}

export const DURATIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: BUSY_MAX_MINUTES, label: '24 hours' },
]

export const KIND_LABEL: Record<PresenceStatusKind, string> = {
  busy: 'Busy (do not disturb)',
  out: 'Out (away from the desk, reachable elsewhere)',
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** A `datetime-local` value of an instant, in the viewer's zone. */
export function toLocalInput(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The instant of a `datetime-local` value, or undefined when it is empty or not a date. */
export function fromLocalInput(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined
  const at = new Date(value).getTime()
  return Number.isNaN(at) ? undefined : at
}

export function initialDraft(now: number): StatusDraft {
  return {
    kind: 'busy',
    note: '',
    start: 'now',
    startAt: toLocalInput(now),
    end: 'after',
    minutes: '30',
    endAt: toLocalInput(now + 60 * 60_000),
  }
}

export type StatusParse = { ok: true; value: PresenceStatusSet } | { ok: false; reason: string }

export function statusSetOf(draft: StatusDraft, now: number): StatusParse {
  const note = draft.note.trim()
  if (Array.from(note).length > BUSY_NOTE_MAX)
    return { ok: false, reason: `The note is at most ${BUSY_NOTE_MAX} characters.` }
  let from: number | undefined
  if (draft.start === 'at') {
    from = fromLocalInput(draft.startAt)
    if (from === undefined) return { ok: false, reason: 'Choose a start time.' }
    if (from <= now) from = undefined // a start in the past is now
  }
  const base = from ?? now
  const value: PresenceStatusSet = {
    busy: true,
    kind: draft.kind,
    ...(note === '' ? {} : { note }),
    ...(from === undefined ? {} : { from }),
  }
  if (draft.end === 'after') {
    const minutes = Number(draft.minutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > BUSY_MAX_MINUTES)
      return { ok: false, reason: `Minutes: a whole number from 1 to ${BUSY_MAX_MINUTES}.` }
    return { ok: true, value: { ...value, minutes } }
  }
  if (draft.end === 'at') {
    const until = fromLocalInput(draft.endAt)
    if (until === undefined) return { ok: false, reason: 'Choose an end time.' }
    if (until <= base) return { ok: false, reason: 'The end must be after the start.' }
    return { ok: true, value: { ...value, until } }
  }
  return { ok: true, value }
}

/** The input that clears the stated status. */
export const CLEAR_STATUS: PresenceStatusSet = { busy: false }
