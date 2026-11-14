import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DeliveryOutcome,
  type DeliveryRequestInput,
  MS_HOUR,
  MS_MINUTE,
} from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  protocolRunsRepo,
  protocolsRepo,
  type RunRecord,
  type Sqlite,
  settingsRepo,
  sqliteActivityStore,
  sqliteSchedules,
} from '@keith/db'
import { createApprovalSettings } from './modules/amygdala/settings.ts'
import { APPROVAL_STALE, REMINDER_MISSED, seedBuiltIns } from './modules/hypothalamus/builtins.ts'
import { createProtocolCatalog } from './modules/hypothalamus/catalog.ts'
import {
  createEngine,
  createRunStarter,
  type ProtocolEngine,
} from './modules/hypothalamus/engine.ts'
import { createStepRunner } from './modules/hypothalamus/steps.ts'
import { createTriggers, settingsCursorStore } from './modules/hypothalamus/triggers.ts'

// The built-in protocols on the real engine, over a real SQLite file (docs/specs/hypothalamus.md, "Built-ins"): the
// activity feed is the store the core uses, the triggers and the engine are the real ones, the clock is a number the
// test moves, and the delivery service is a map that answers a repeated id with its stored outcome (P25's exactly-once
// rule). The approval guard reads a fake attention queue: an approval is pending until the test answers it.

const dir = mkdtempSync(join(tmpdir(), 'keith-protocols-builtins-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const NOW = Date.UTC(2026, 10, 10, 9, 0) // 09:00 UTC on 2026-11-10, as the engine harness
const OWNER = 'vian'
const MEMBER = 'ana'
const APPROVAL_PING_TEXT = 'An approval waits and expires soon.'
const REMINDER_TEXT = 'A reminder could not be delivered earlier; here it is now.'

interface Sent {
  id: string
  to: string
  name: string
  text: string
}

interface World {
  now: number
  /** Approvals still pending, by id, with their expiry (an answered approval is removed). */
  pending: Map<string, number>
  /** Every delivery the service accepted, once per request id. */
  sent: Sent[]
  delivered: Map<string, DeliveryOutcome>
}

const freshWorld = (): World => ({
  now: NOW,
  pending: new Map(),
  sent: [],
  delivered: new Map(),
})

interface Stack {
  sqlite: Sqlite
  engine: ProtocolEngine
  runs: ReturnType<typeof protocolRunsRepo>
  protocols: ReturnType<typeof protocolsRepo>
  approvals: ReturnType<typeof createApprovalSettings>
  /** Appends one activity record at the world's clock (the wait and failure records the built-ins react to). */
  record(type: string, payload: Record<string, unknown>): Promise<void>
  /** One core tick: the triggers, then the engine, as the timer calls them. */
  beat(): Promise<void>
  /** The built-in protocol id, the run of a trigger ref, and what was sent to a person. */
  builtIn(name: string): string
  runOf(name: string, triggerRef: string): RunRecord | undefined
  sentTo(to: string, name?: string): Sent[]
  close(): void
}

/** A process over the file: the built-ins are seeded (idempotent), the engine and the triggers are wired as in compose. */
function openStack(file: string, world: World): Stack {
  const sqlite = openDatabase(file)
  migrateDatabase(sqlite)
  const settings = settingsRepo(sqlite)
  const protocols = protocolsRepo(sqlite)
  const runs = protocolRunsRepo(sqlite)
  const approvals = createApprovalSettings(settings)
  const store = sqliteActivityStore(sqlite, { now: () => world.now })
  const warnings: string[] = []
  const warn = (message: string): void => void warnings.push(message)
  // the built-ins are saved at the test clock: a record older than its protocol's save never matches it
  seedBuiltIns({ protocols, now: () => world.now })

  const clock = { now: () => world.now, timeZone: 'UTC' }
  const pingBeforeMs = (): number => approvals.pingBeforeHours() * MS_HOUR
  const delivery = {
    async deliver(request: DeliveryRequestInput): Promise<DeliveryOutcome> {
      const prior = world.delivered.get(request.id)
      if (prior !== undefined) return prior
      const outcome: DeliveryOutcome = { status: 'delivered', route: 'test', attempts: 1 }
      world.delivered.set(request.id, outcome)
      world.sent.push({ id: request.id, to: request.to, name: request.name, text: request.text })
      return outcome
    },
  }
  const engine = createEngine({
    clock,
    conditions: {
      clock,
      presence: async () => null,
      agenda: { confirmedNow: async () => false },
      lastSign: async () => null,
      budget: { remaining: async () => Number.POSITIVE_INFINITY },
      approvals: {
        async pending(approvalId: string) {
          const expiresAt = world.pending.get(approvalId)
          return expiresAt === undefined ? null : { expiresAt }
        },
      },
    },
    protocols,
    runs,
    steps: createStepRunner({
      deliver: delivery,
      people: { isActive: async () => true },
      budget: { remaining: async () => Number.POSITIVE_INFINITY },
      // no built-in has an `act` step: reaching one is a failure of this test
      act: async () => {
        throw new Error('the built-ins never run an act step')
      },
    }),
    journal: { audit() {}, event() {} },
    transaction: (fn) => sqlite.transaction(fn).immediate(),
    ownerOf: async () => OWNER,
    warn,
    pingBeforeMs,
  })
  const triggers = createTriggers({
    runs: createRunStarter(engine),
    protocols: createProtocolCatalog({ protocols, warn }),
    feed: {
      async read(query) {
        const records = await store.read({
          after: query.after,
          limit: query.limit,
          types: [...query.types],
        })
        return records.map((r) => ({
          seq: r.seq,
          type: r.type,
          payload: r.payload,
          createdAt: r.createdAt,
        }))
      },
      lastSeq: () => store.lastSeq(),
      prunedThrough: () => store.prunedThrough(),
    },
    signals: { since: async () => [] },
    lastSign: { lastSign: async () => null },
    schedules: sqliteSchedules(sqlite),
    cursor: settingsCursorStore(settings),
    now: clock.now,
    pingBeforeMs,
    log: { warn },
  })

  const builtInRow = (name: string) => {
    const row = protocols.findBuiltIn('keith', name)
    if (row === undefined) throw new Error(`built-in ${name} is not seeded`)
    return row
  }

  return {
    sqlite,
    engine,
    runs,
    protocols,
    approvals,
    async record(type, payload) {
      await store.append({ type, payload, at: world.now })
    },
    async beat() {
      await triggers.tick()
      await engine.tick()
    },
    builtIn: (name) => builtInRow(name).id,
    runOf: (name, triggerRef) => runs.findByTrigger(builtInRow(name).id, triggerRef),
    sentTo: (to, name) =>
      world.sent.filter((s) => s.to === to && (name === undefined || s.name === name)),
    close: () => sqlite.close(),
  }
}

const newFile = (name: string): string => join(dir, `${name}.sqlite`)

/** Moves the clock and runs one core tick at that time. */
async function at(s: Stack, world: World, when: number): Promise<void> {
  world.now = when
  await s.beat()
}

describe('approval-stale: the owner is pinged once before an approval expires', () => {
  test('one ping at expiry minus the ping window, none before it, none again after it', async () => {
    const world = freshWorld()
    const s = openStack(newFile('ping'), world)
    await s.beat() // the feed head and the trigger cursor are taken before the first record
    const expiresAt = NOW + 24 * MS_HOUR
    world.pending.set('a1', expiresAt)
    await s.record('brain.amygdala.wait', {
      region: 'amygdala',
      toolName: 'shell.exec',
      sessionId: 'ana-front',
      count: 1,
      approvalId: 'a1',
      expiresAt,
    })

    await at(s, world, NOW + MS_HOUR)
    expect(s.sentTo(OWNER)).toHaveLength(0)
    expect(s.runOf(APPROVAL_STALE, 'approval:a1')?.status).toBe('waiting')
    expect(s.runOf(APPROVAL_STALE, 'approval:a1')?.wakeAt).toBe(expiresAt - 2 * MS_HOUR)

    await at(s, world, expiresAt - 2 * MS_HOUR - MS_MINUTE)
    expect(s.sentTo(OWNER)).toHaveLength(0)

    await at(s, world, expiresAt - 2 * MS_HOUR)
    expect(s.sentTo(OWNER, 'protocol.notify')).toEqual([
      expect.objectContaining({ to: OWNER, text: APPROVAL_PING_TEXT }),
    ])
    expect(s.runOf(APPROVAL_STALE, 'approval:a1')?.status).toBe('done')

    // later ticks, past the expiry too: the same run, no second ping
    await at(s, world, expiresAt - MS_HOUR)
    await at(s, world, expiresAt + MS_HOUR)
    expect(s.sentTo(OWNER)).toHaveLength(1)
    s.close()
  })

  test('a second wait record of the same approval starts no second run and sends no second ping', async () => {
    const world = freshWorld()
    const s = openStack(newFile('reread'), world)
    await s.beat()
    const expiresAt = NOW + 24 * MS_HOUR
    world.pending.set('a2', expiresAt)
    const payload = {
      region: 'amygdala',
      toolName: 'shell.exec',
      sessionId: 'ana-front',
      count: 1,
      approvalId: 'a2',
      expiresAt,
    }
    await s.record('brain.amygdala.wait', payload)
    await s.record('brain.amygdala.wait', payload)
    await at(s, world, expiresAt - 2 * MS_HOUR)
    await at(s, world, expiresAt - MS_HOUR)
    expect(s.sentTo(OWNER, 'protocol.notify')).toHaveLength(1)
    expect(s.runs.findByTrigger(s.builtIn(APPROVAL_STALE), 'approval:a2')).toBeDefined()
    s.close()
  })

  test('an approval answered before the window is never pinged: its run is skipped', async () => {
    const world = freshWorld()
    const s = openStack(newFile('answered'), world)
    await s.beat()
    const expiresAt = NOW + 24 * MS_HOUR
    world.pending.set('a3', expiresAt)
    await s.record('brain.amygdala.wait', {
      region: 'amygdala',
      toolName: 'shell.exec',
      sessionId: 'ana-front',
      count: 1,
      approvalId: 'a3',
      expiresAt,
    })
    await at(s, world, NOW + 5 * MS_HOUR)
    world.pending.delete('a3') // answered by the person
    await at(s, world, expiresAt - 2 * MS_HOUR)
    expect(s.sentTo(OWNER)).toHaveLength(0)
    expect(s.runOf(APPROVAL_STALE, 'approval:a3')?.status).toBe('skipped')
    s.close()
  })

  test('the ping window is the live setting: a 5 h window pings at expiry minus 5 h', async () => {
    const world = freshWorld()
    const s = openStack(newFile('window'), world)
    await s.beat()
    s.approvals.setPingBeforeHours(5)
    const expiresAt = NOW + 24 * MS_HOUR
    world.pending.set('a4', expiresAt)
    await s.record('brain.amygdala.wait', {
      region: 'amygdala',
      toolName: 'shell.exec',
      sessionId: 'ana-front',
      count: 1,
      approvalId: 'a4',
      expiresAt,
    })
    await at(s, world, expiresAt - 6 * MS_HOUR)
    expect(s.sentTo(OWNER)).toHaveLength(0)
    await at(s, world, expiresAt - 5 * MS_HOUR)
    expect(s.sentTo(OWNER, 'protocol.notify')).toHaveLength(1)
    s.close()
  })
})

describe('reminder-missed: a reminder that could not be delivered is told to its creator once', () => {
  test('one notify to the creator after the 15 minute settle, none again for the same delivery', async () => {
    const world = freshWorld()
    const s = openStack(newFile('missed'), world)
    await s.beat()
    await s.record('delivery.failed', {
      personId: MEMBER,
      deliveryId: 'd1',
      source: 'plugin:reminders',
      reason: 'unavailable',
    })
    // the tick that reads the failure starts the run; its settle wait runs 15 minutes from that tick
    await at(s, world, NOW)
    expect(s.runOf(REMINDER_MISSED, 'delivery:d1')?.status).toBe('waiting')

    await at(s, world, NOW + 14 * MS_MINUTE)
    expect(s.sentTo(MEMBER)).toHaveLength(0)

    await at(s, world, NOW + 15 * MS_MINUTE)
    const told = s.sentTo(MEMBER, 'protocol.notify')
    expect(told).toEqual([expect.objectContaining({ to: MEMBER, text: REMINDER_TEXT })])
    expect(told[0]?.id).toBe(`${s.runOf(REMINDER_MISSED, 'delivery:d1')?.id}:tell:1`)
    expect(s.runOf(REMINDER_MISSED, 'delivery:d1')?.status).toBe('done')

    // the same failure again (a re-read or a repeated report of the same delivery) starts nothing
    await s.record('delivery.failed', {
      personId: MEMBER,
      deliveryId: 'd1',
      source: 'plugin:reminders',
      reason: 'unavailable',
    })
    await at(s, world, NOW + 3 * MS_HOUR)
    await at(s, world, NOW + 4 * MS_HOUR)
    expect(s.sentTo(MEMBER, 'protocol.notify')).toHaveLength(1)
    expect(s.sentTo(OWNER)).toHaveLength(0)
    s.close()
  })

  test('a second failed delivery makes a second run; a failure of another source is ignored', async () => {
    const world = freshWorld()
    const s = openStack(newFile('missed-two'), world)
    await s.beat()
    await s.record('delivery.failed', {
      personId: MEMBER,
      deliveryId: 'd2',
      source: 'plugin:reminders',
      reason: 'no-route',
    })
    await s.record('delivery.failed', {
      personId: MEMBER,
      deliveryId: 'd3',
      source: 'protocol:some-other',
      reason: 'no-route',
    })
    await at(s, world, NOW)
    await at(s, world, NOW + 15 * MS_MINUTE)
    expect(s.sentTo(MEMBER, 'protocol.notify')).toHaveLength(1)

    await s.record('delivery.failed', {
      personId: MEMBER,
      deliveryId: 'd4',
      source: 'plugin:reminders',
      reason: 'no-route',
    })
    await at(s, world, NOW + 15 * MS_MINUTE)
    await at(s, world, NOW + 30 * MS_MINUTE)
    expect(s.sentTo(MEMBER, 'protocol.notify')).toHaveLength(2)
    expect(s.runOf(REMINDER_MISSED, 'delivery:d3')).toBeUndefined()
    s.close()
  })
})
