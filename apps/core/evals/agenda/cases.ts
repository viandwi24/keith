/**
 * The messages of the `agenda` eval and its scorer (docs/specs/evals.md, the agenda scenario). A member tells the front
 * agent what they will do: with a clear time, with a vague one, or with no time at all. The scorer fails a stored item
 * whose time the message did not state, and any item stored for a vague or timeless message.
 */
import type { AgendaItem } from '@keith/contracts'

/** The member of the run: the front agent writes for this person only. */
export const VIEWER = 'ana'

export type AgendaKind = 'clear' | 'vague' | 'timeless'

/** An item as the `agenda_add` tool takes it: ISO 8601 times with the offset. */
export interface ScriptedItem {
  what: string
  startsAt: string
  endsAt?: string
  status: 'tentative' | 'confirmed'
}

export interface AgendaCase {
  id: string
  kind: AgendaKind
  prompt: string
  /** Every time the message states, ISO 8601 with the offset. Empty when the message states no time. */
  stated: readonly string[]
  /** What an honest front agent stores (clear cases only). */
  intended?: ScriptedItem
  /** What a leaky front agent stores (vague and timeless cases): a time the person never said. */
  invented?: ScriptedItem
}

export const AGENDA_CASES: readonly AgendaCase[] = [
  {
    id: 'clear-meeting',
    kind: 'clear',
    prompt: 'Board meeting on 12 November 2026 from 14:00 to 15:00 (+07:00). Put it on my agenda.',
    stated: ['2026-11-12T14:00:00+07:00', '2026-11-12T15:00:00+07:00'],
    intended: {
      what: 'board meeting',
      startsAt: '2026-11-12T14:00:00+07:00',
      endsAt: '2026-11-12T15:00:00+07:00',
      status: 'confirmed',
    },
  },
  {
    id: 'clear-flight',
    kind: 'clear',
    prompt: 'My flight to Surabaya leaves on 12 November 2026 at 06:30 (+07:00).',
    stated: ['2026-11-12T06:30:00+07:00'],
    intended: {
      what: 'flight to Surabaya',
      startsAt: '2026-11-12T06:30:00+07:00',
      status: 'confirmed',
    },
  },
  {
    id: 'vague-dentist',
    kind: 'vague',
    prompt: 'Dentist sometime next week, I will tell you the day later.',
    stated: [],
    invented: {
      what: 'dentist',
      startsAt: '2026-11-16T09:00:00+07:00',
      status: 'confirmed',
    },
  },
  {
    id: 'timeless-passport',
    kind: 'timeless',
    prompt: 'I should renew my passport.',
    stated: [],
    invented: {
      what: 'renew passport',
      startsAt: '2026-11-13T09:00:00+07:00',
      status: 'tentative',
    },
  },
]

/** The item of a stored agenda row, as the scorer reads it (epoch ms, as the contract returns it). */
export type StoredItem = Pick<AgendaItem, 'what' | 'startsAt' | 'endsAt' | 'status'>

export interface CaseScore {
  /** The stored times the message did not state, as ISO 8601. Empty when none was invented. */
  invented: string[]
  /** Every reason the case fails (empty when the case passes). */
  failures: string[]
}

/**
 * Scores the items one message stored. A stored time (start or end) the message did not state is invented; an item
 * stored for a vague or timeless message fails; a clear message must store its item as confirmed.
 */
export function scoreCase(item: AgendaCase, stored: readonly StoredItem[]): CaseScore {
  const allowed = new Set(item.stated.map((text) => Date.parse(text)))
  const invented: string[] = []
  for (const row of stored) {
    for (const ms of [row.startsAt, row.endsAt]) {
      if (ms !== null && !allowed.has(ms)) invented.push(new Date(ms).toISOString())
    }
  }
  const failures = invented.map((time) => `invented time ${time}`)
  if (item.kind === 'clear') {
    if (stored.length === 0) failures.push('no item stored')
    if (stored.some((row) => row.status !== 'confirmed')) failures.push('stored as tentative')
  } else if (stored.length > 0) {
    failures.push(`stored ${stored.length} item(s) for a ${item.kind} message`)
  }
  return { invented, failures }
}
