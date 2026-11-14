import type { Actor } from '@keith/contracts'
import type { AuditEvent, AuditPort, Clock, SessionFacts } from '../types.ts'

/** A resolved user actor with sensible defaults; override what the test is about. */
export function fakeActor(over: Partial<Actor> = {}): Actor {
  const personId = over.personId === undefined ? 'ana' : over.personId
  return {
    kind: 'user',
    personId,
    principalId: personId ?? 'ana',
    role: 'member',
    sessionId: null,
    methods: ['password'],
    assurance: 2,
    elevated: false,
    zone: 'loopback',
    via: 'local',
    ...over,
  }
}

/** A guest actor (P17): no person, no role. */
export const fakeGuest = (id = 'g1'): Actor =>
  fakeActor({
    kind: 'guest',
    personId: null,
    principalId: id,
    role: null,
    methods: [],
    assurance: 0,
  })

export interface FakeClock extends Clock {
  advance(ms: number): void
  set(ms: number): void
}

/** A clock that moves only when told to. */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    set: (ms) => {
      t = ms
    },
  }
}

export interface RecordingAudit extends AuditPort {
  readonly rows: AuditEvent[]
  kinds(): string[]
}

export function recordingAudit(): RecordingAudit {
  const rows: AuditEvent[] = []
  return {
    rows,
    record: (event) => void rows.push(structuredClone(event)),
    kinds: () => rows.map((r) => r.kind),
  }
}

/** Session facts of a front chat turn. */
export const frontSession = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  id: 'front:ana',
  kind: 'front',
  method: null,
  elevated: false,
  ...over,
})
