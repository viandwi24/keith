import { describe, expect, test } from 'bun:test'
import { parseBrainEvent } from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  protocolRunsRepo,
  protocolsRepo,
  sqliteActivityStore,
} from '@keith/db'
import type { ActivityRecord } from 'eharness/activity'
import { APPROVAL_PING_BEFORE_MS } from './builtins.ts'
import { createEngine } from './engine.ts'
import { HOUR, MINUTE, NOW, notify, protocol, wait } from './engine-harness.ts'
import { createJournal } from './journal.ts'
import type { FlatDetail, StepRunInput } from './ports.ts'

// The journal of the engine (docs/specs/hypothalamus.md, "Audit" and "Events"): every run writes its audit rows with the
// person as `subject`, and its `brain.hypothalamus.*` records on the front session of that person (the owner's for a
// `keith`-owned run). Payloads parse with the brain contracts; no message text anywhere.

const TEXT = 'Text of tell, do not log.'

async function records(
  store: ReturnType<typeof sqliteActivityStore>,
  n: number,
): Promise<ActivityRecord[]> {
  for (let i = 0; i < 100; i++) {
    const rows = await store.read({ after: 0, limit: 100 })
    if (rows.length >= n) return rows
    await Bun.sleep(5)
  }
  return store.read({ after: 0, limit: 100 })
}

function setup() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const protocols = protocolsRepo(sqlite)
  const runs = protocolRunsRepo(sqlite)
  const store = sqliteActivityStore(sqlite)
  const audits: Array<{ kind: string; detail: FlatDetail }> = []
  let at = NOW
  const engine = createEngine({
    pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
    clock: { now: () => at, timeZone: 'UTC' },
    conditions: {
      clock: { now: () => at, timeZone: 'UTC' },
      presence: async () => null,
      agenda: { confirmedNow: async () => false },
      lastSign: async () => null,
      budget: { remaining: async () => 1 },
      approvals: { pending: async () => null },
    },
    protocols,
    runs,
    steps: {
      async run(input: StepRunInput) {
        return input.step.kind === 'wait'
          ? { kind: 'done', outcome: 'ok' }
          : { kind: 'done', outcome: 'ok' }
      },
      async tell() {},
    },
    journal: createJournal({
      generations: { current: () => 0 },
      audit: (kind, detail) => audits.push({ kind, detail: detail as FlatDetail }),
      store,
      warn: () => {},
    }),
    transaction: (fn) => sqlite.transaction(fn).immediate(),
    ownerOf: async () => 'vian',
  })
  return {
    engine,
    protocols,
    runs,
    store,
    audits,
    advance: (ms: number) => {
      at += ms
    },
    setAt: (value: number) => {
      at = value
    },
  }
}

describe('audit rows of a run', () => {
  test('a person-owned run writes start, step and end rows with the person as subject; a keith run has the owner as subject', async () => {
    const h = setup()
    h.protocols.create(
      {
        id: 'p1',
        owner: 'ana',
        name: 'ladder',
        definition: JSON.stringify(
          protocol([notify('tell', { next: 'pause' }), wait('pause', HOUR)]),
        ),
        savedBy: 'ana',
      },
      NOW,
    )
    h.protocols.create(
      {
        id: 'p2',
        owner: 'keith',
        name: 'self',
        definition: JSON.stringify(protocol([notify('tell', { text: TEXT })])),
        savedBy: 'vian',
      },
      NOW,
    )
    await h.engine.start({ protocolId: 'p2', trigger: 'time', triggerRef: 'self-1' })
    const started = await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'ana-1' })
    expect(started.status).toBe('created')
    h.setAt(NOW + HOUR + MINUTE)
    await h.engine.tick()

    // the person's rows carry the subject; a keith-owned run acts for the instance owner, so its rows carry the owner
    const ana = h.audits.filter((row) => row.detail.subject === 'ana')
    expect(ana.map((row) => row.kind)).toEqual([
      'protocol.run.start',
      'protocol.run.step',
      'protocol.run.step',
      'protocol.run.end',
    ])
    expect(h.audits.filter((row) => row.detail.subject === 'vian').map((row) => row.kind)).toEqual([
      'protocol.run.start',
      'protocol.run.step',
      'protocol.run.end',
    ])
    expect(h.audits.every((row) => row.detail.subject !== undefined)).toBe(true)
    // a step row names the outcome, never the text of the message
    expect(ana.find((row) => row.kind === 'protocol.run.step')?.detail.outcome).toBe('ok')
    expect(JSON.stringify(h.audits)).not.toContain(TEXT)
  })

  test('a refused start writes its refusal with the subject of the protocol owner', async () => {
    const h = setup()
    h.protocols.create(
      {
        id: 'p1',
        owner: 'ana',
        name: 'capped',
        definition: JSON.stringify(protocol([wait('pause', HOUR)], { maxRunsPerDay: 1 })),
        savedBy: 'ana',
      },
      NOW,
    )
    await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'a' })
    await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'b' })
    const refused = h.audits.find((row) => row.kind === 'protocol.run.refused')
    expect(refused?.detail).toEqual({ protocolId: 'p1', reason: 'daily-limit', subject: 'ana' })
  })
})

describe('brain events of a run', () => {
  test('the four records parse with the brain contracts, carry the region, and sit on the right front session', async () => {
    const h = setup()
    h.protocols.create(
      {
        id: 'p1',
        owner: 'ana',
        name: 'ladder',
        definition: JSON.stringify(
          protocol([notify('tell', { next: 'pause' }), wait('pause', HOUR)]),
        ),
        savedBy: 'ana',
      },
      NOW,
    )
    h.protocols.create(
      {
        id: 'p2',
        owner: 'keith',
        name: 'self',
        definition: JSON.stringify(protocol([notify('tell')])),
        savedBy: 'vian',
      },
      NOW,
    )
    await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'ana-1' })
    await h.engine.start({ protocolId: 'p2', trigger: 'time', triggerRef: 'self-1' })
    h.setAt(NOW + HOUR + MINUTE)
    await h.engine.tick()

    const feed = await records(h.store, 8)
    const hypo = feed.filter((r) => r.type.startsWith('brain.hypothalamus.'))
    expect(hypo.map((r) => r.type)).toEqual(
      expect.arrayContaining([
        'brain.hypothalamus.fire',
        'brain.hypothalamus.step',
        'brain.hypothalamus.wait',
        'brain.hypothalamus.end',
      ]),
    )
    for (const record of hypo) {
      expect(parseBrainEvent({ type: record.type, payload: record.payload })).toBeDefined()
      expect(record.payload.region).toBe('hypothalamus')
    }
    const onAna = hypo.filter((r) => r.sessionId === 'front:ana')
    const onOwner = hypo.filter((r) => r.sessionId === 'front:vian')
    expect(onAna.length).toBeGreaterThan(0)
    expect(onOwner.length).toBeGreaterThan(0)
    expect(onAna.every((r) => r.payload.personId === 'ana')).toBe(true)
    // a keith-owned run speaks on the owner's session: no person id in its payload, the session names the owner
    expect(onOwner.every((r) => r.payload.personId === 'vian')).toBe(true)
    expect(JSON.stringify(hypo)).not.toContain('Text of')
  })
})
