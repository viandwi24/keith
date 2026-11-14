import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DeliveryOutcome,
  type DeliveryRequestInput,
  MS_DAY,
  MS_HOUR,
  type Person,
} from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  presenceSignalsRepo,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
  settingsRepo,
  sqliteActivityStore,
  sqliteSchedules,
  successionRepo,
} from '@keith/db'
import { createApprovalSettings } from './modules/amygdala/settings.ts'
import {
  createEngine,
  createProtocolCatalog,
  createRunStarter,
  createSignOfLife,
  createStepRunner,
  createSuccession,
  createSuccessionSteps,
  createTriggers,
  type ProtocolEngine,
  type SuccessionService,
  seedBuiltIns,
  settingsCursorStore,
  syncOwnerAbsence,
} from './modules/hypothalamus/index.ts'
import { stateOf } from './modules/hypothalamus/run-state.ts'
import { totalVisits } from './modules/hypothalamus/steps.ts'
import type { SuccessionDeps } from './modules/hypothalamus/succession-shared.ts'
import { LAST_SIGN_TYPES } from './modules/parietal/ports.ts'

// The succession timeline end to end (docs/specs/succession.md, "The protocol", "As built"): the real succession service,
// the real engine, triggers and system steps, over a real SQLite file. The clock is a number the test moves, one whole
// day per tick; delivery is a map that answers a repeated request id with its stored outcome and survives a restart (as
// P25's table does). Nothing sleeps. The wiring mirrors `compose-protocols.ts`.

const dir = mkdtempSync(join(tmpdir(), 'keith-succession-e2e-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 10, 10, 9, 0) // 09:00 UTC on 2026-11-10, as the other e2e tests
const OWNER = 'vian'
const HEIR = 'ana'
const NEW_HEIR = 'kim'
const OWNER_CALLER = { actor: OWNER, via: 'tcp' as const }

/** Epoch ms of the whole day `d` after T0. */
const day = (d: number): number => T0 + d * MS_DAY

// The texts are fixed (the builder), so the tests match each notice by its wording, not its id.
const ASK = 'protocol.ask'
const GRACE_HEIR = /grace period of 7 days started/
const GRACE_OWNER = /Ownership will move to your heir after a 7-day grace period/
const CLAIM_HEIR = /You may claim now/
const CLAIM_OWNER = /Your heir may claim ownership now/
const STOP_HEIR = /The owner is back; the succession protocol stopped/
const STOP_OWNER = /The succession protocol stopped. You are back/

interface Sent {
  id: string
  at: number
  to: string
  name: string
  text: string
  fanout: string
}

interface Audited {
  kind: string
  actor: string
  via: string
  detail: Record<string, unknown>
}

/** The outside world a process sees: the clock, the people, delivery (shared), the audit (a fake). */
interface World {
  now: number
  people: Map<string, Person>
  secrets: Set<string>
  sends: Sent[]
  attempts: Map<string, number>
  delivered: Map<string, DeliveryOutcome>
  audits: Audited[]
  warnings: string[]
}

const toPerson = (id: string, role: 'owner' | 'member' = 'member'): Person => ({
  id,
  username: id,
  name: id,
  role,
  status: 'active',
  canLogin: true,
  createdBy: OWNER,
  createdAt: T0,
  updatedAt: T0,
})

function freshWorld(): World {
  return {
    now: T0,
    people: new Map([
      [OWNER, toPerson(OWNER, 'owner')],
      [HEIR, toPerson(HEIR)],
      [NEW_HEIR, toPerson(NEW_HEIR)],
    ]),
    secrets: new Set([OWNER, HEIR, NEW_HEIR]),
    sends: [],
    attempts: new Map(),
    delivered: new Map(),
    audits: [],
    warnings: [],
  }
}

/** One process over the file: the same wiring as `compose-protocols.ts`, with the fake delivery and clock. */
interface Stack {
  succession: SuccessionService
  /** Reads the one state row. */
  state(): ReturnType<ReturnType<typeof successionRepo>['get']>
  runs: ReturnType<typeof protocolRunsRepo>
  protocols: ReturnType<typeof protocolsRepo>
  engine: ProtocolEngine
  /** One core tick: the triggers, then the engine, as the timer calls them. */
  beat(): Promise<void>
  /** Boot recovery, as `compose-protocols.ts` runs it once before the timer. */
  recover(): Promise<{ waiting: number; resumed: number }>
  /** Records one `activity` signal of a person (what parietal's `recordActivity` writes). */
  sign(personId: string, at: number): void
  close(): void
}

function boot(file: string, world: World): Stack {
  const sqlite: Sqlite = openDatabase(file)
  migrateDatabase(sqlite)
  const settings = settingsRepo(sqlite)
  const protocols = protocolsRepo(sqlite)
  const runs = protocolRunsRepo(sqlite)
  const successionState = successionRepo(sqlite)
  const signals = presenceSignalsRepo(sqlite)
  const store = sqliteActivityStore(sqlite, { now: () => world.now })
  const clock = { now: () => world.now, timeZone: 'UTC' }
  const warn = (message: string): void => void world.warnings.push(message)
  const approvals = createApprovalSettings(settings)
  const pingBeforeMs = (): number => approvals.pingBeforeHours() * MS_HOUR
  const catalog = createProtocolCatalog({ protocols, warn })

  const people = {
    async get(ref: string): Promise<Person> {
      const found = world.people.get(ref)
      if (found === undefined) throw new Error(`no person ${ref}`)
      return found
    },
    async owner(): Promise<Person | undefined> {
      return [...world.people.values()].find((p) => p.role === 'owner')
    },
    async requireOwner(by: { actor: string }): Promise<void> {
      const caller = world.people.get(by.actor)
      if (caller !== undefined && caller.role !== 'owner') throw new Error('only the owner')
    },
    // the claim's owner swap is not part of this timeline (succession-procedures.ts is tested there)
    async succeed(): Promise<never> {
      throw new Error('the claim is not part of the timeline')
    },
  }

  const deps: SuccessionDeps = {
    settings,
    succession: successionState,
    runs,
    protocols,
    people,
    audit: {
      record: (event) =>
        void world.audits.push({
          kind: event.kind,
          actor: event.actor,
          via: event.via,
          detail: event.detail ?? {},
        }),
    },
    lastSign: async (personId) => signals.newest(personId, LAST_SIGN_TYPES),
    lastSignNow: (personId) => signals.newest(personId, LAST_SIGN_TYPES),
    hasSecret: (personId) => world.secrets.has(personId),
    now: clock.now,
    onChanged: () => syncNow(),
  }
  const succession = createSuccession(deps)

  // the built-in follows the settings (`syncOwnerAbsence`): on every heir or window change, and once at boot
  function syncNow(): void {
    const owner = [...world.people.values()].find((p) => p.role === 'owner')
    if (owner === undefined) return
    const current = succession.settings()
    const sync = syncOwnerAbsence({
      protocols,
      settings: { owner: owner.id, windowDays: current.windowDays, heir: current.heir },
      now: clock.now(),
    })
    if (sync.action !== 'unchanged') catalog.changed()
  }

  const signOfLife = createSignOfLife({
    lastSign: async (personId) => signals.newest(personId, LAST_SIGN_TYPES),
    pausedUntil: (personId) => succession.pausedUntil(personId),
  })

  const engine = createEngine({
    clock,
    conditions: {
      clock,
      presence: async () => null,
      agenda: { confirmedNow: async () => false },
      lastSign: (person) => signOfLife.lastSign(person),
      budget: { remaining: async () => Number.POSITIVE_INFINITY },
      approvals: { pending: async () => null },
    },
    protocols,
    runs,
    steps: createStepRunner({
      deliver: {
        async deliver(request: DeliveryRequestInput): Promise<DeliveryOutcome> {
          return deliverOnce(world, request)
        },
      },
      people: {
        async isActive(personId: string) {
          return world.people.get(personId)?.status === 'active'
        },
      },
      budget: { remaining: async () => Number.POSITIVE_INFINITY },
      // the owner-absence protocol has no `act` step: reaching one is a failure of this test
      act: async () => {
        throw new Error('the owner-absence protocol never runs an act step')
      },
      system: createSuccessionSteps(deps),
    }),
    journal: { audit() {}, event() {} },
    transaction: (fn) => sqlite.transaction(fn).immediate(),
    ownerOf: async () => OWNER,
    warn,
    pingBeforeMs,
  })

  // the built-ins are seeded and the owner-absence built-in synced before the first tick (compose-protocols.ts)
  seedBuiltIns({ protocols, now: clock.now })
  syncNow()

  const startRun = createRunStarter(engine)
  const triggers = createTriggers({
    runs: {
      async start(input) {
        const outcome = await startRun.start(input)
        if (outcome === 'started') await succession.runStarted(input.protocolId, input.ref)
        return outcome
      },
    },
    protocols: catalog,
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
    signals: { since: async (after, limit) => signals.since(after, limit) },
    lastSign: { lastSign: (personId) => signOfLife.lastSign(personId) },
    schedules: sqliteSchedules(sqlite),
    cursor: settingsCursorStore(settings),
    now: clock.now,
    pingBeforeMs,
    log: { warn },
  })

  return {
    succession,
    state: () => successionState.get(),
    runs,
    protocols,
    engine,
    async beat() {
      await triggers.tick()
      await engine.tick()
    },
    recover: () => engine.recover(),
    sign(personId, at) {
      signals.record({ personId, type: 'activity', at })
    },
    close: () => sqlite.close(),
  }
}

/** The delivery service: a repeated request id answers its stored outcome and sends nothing again (P25's rule). */
function deliverOnce(world: World, request: DeliveryRequestInput): DeliveryOutcome {
  world.attempts.set(request.id, (world.attempts.get(request.id) ?? 0) + 1)
  const prior = world.delivered.get(request.id)
  if (prior !== undefined) return prior
  const outcome: DeliveryOutcome = { status: 'delivered', route: 'fake', attempts: 1 }
  world.delivered.set(request.id, outcome)
  world.sends.push({
    id: request.id,
    at: world.now,
    to: request.to,
    name: request.name,
    text: request.text,
    fanout: request.needs?.fanout ?? 'best',
  })
  return outcome
}

/** The owner's last sign, the heir, the window: the setup every timeline starts from. */
async function setup(
  s: Stack,
  options: { heir?: string | null; windowDays?: number } = {},
): Promise<void> {
  s.sign(OWNER, T0)
  if (options.windowDays !== undefined)
    await s.succession.setWindow(options.windowDays, OWNER_CALLER)
  if (options.heir) await s.succession.setHeir(options.heir, OWNER_CALLER)
}

/** Runs one tick per whole day from `from` to `to` (inclusive) on the scripted clock. */
async function runDays(s: Stack, w: World, from: number, to: number): Promise<void> {
  for (let d = from; d <= to; d++) {
    w.now = day(d)
    await s.beat()
  }
}

const sentTo = (w: World, to: string, text: RegExp): Sent[] =>
  w.sends.filter((sent) => sent.to === to && text.test(sent.text))

const asksSent = (w: World): Sent[] => w.sends.filter((sent) => sent.name === ASK)

const auditKinds = (w: World): string[] => w.audits.map((row) => row.kind)

describe('the succession timeline on a scripted clock', () => {
  test('a silent owner: daily check-ins on every channel, grace at day 14, claimable at day 21', async () => {
    const w = freshWorld()
    const s = boot(join(dir, 'silent.sqlite'), w)
    await setup(s, { heir: HEIR })

    await runDays(s, w, 1, 13)
    expect(s.state().state).toBe('check-in')
    await runDays(s, w, 14, 14)
    expect(s.state()).toMatchObject({ state: 'grace', graceStartedAt: day(14) })

    // one check-in a day, day 1 to day 13, to the owner, on every channel
    const asks = asksSent(w)
    expect(asks.map((ask) => ask.at)).toEqual(Array.from({ length: 13 }, (_, i) => day(i + 1)))
    expect(asks.every((ask) => ask.to === OWNER && ask.fanout === 'all')).toBe(true)

    // the grace starts: heir and owner told once, on every channel
    expect(sentTo(w, HEIR, GRACE_HEIR).map((sent) => sent.at)).toEqual([day(14)])
    expect(sentTo(w, OWNER, GRACE_OWNER).map((sent) => sent.at)).toEqual([day(14)])
    expect(
      [...sentTo(w, HEIR, GRACE_HEIR), ...sentTo(w, OWNER, GRACE_OWNER)].every(
        (sent) => sent.fanout === 'all',
      ),
    ).toBe(true)

    await runDays(s, w, 15, 21)
    const row = s.state()
    expect(row).toMatchObject({ state: 'claimable', graceStartedAt: day(14), claimableAt: day(21) })
    // the heir is told once that the claim is open, the owner too
    expect(sentTo(w, HEIR, CLAIM_HEIR).map((sent) => sent.at)).toEqual([day(21)])
    expect(sentTo(w, OWNER, CLAIM_OWNER).map((sent) => sent.at)).toEqual([day(21)])
    // the run ends done after `open-claim`, never failed
    expect(s.runs.get(row.runId ?? '')?.status).toBe('done')
    expect(auditKinds(w)).toEqual(
      expect.arrayContaining(['owner.succession.start', 'owner.succession.claimable']),
    )
    expect(auditKinds(w)).not.toContain('owner.succession.cancel')
    expect(w.warnings).toEqual([])
    s.close()
  })

  test('an owner sign on day 20 cancels the grace: idle, the heir is told, never claimable', async () => {
    const w = freshWorld()
    const s = boot(join(dir, 'sign-day-20.sqlite'), w)
    await setup(s, { heir: HEIR })
    await runDays(s, w, 1, 19)
    expect(s.state().state).toBe('grace')

    const signAt = day(20) + MS_HOUR
    s.sign(OWNER, signAt)
    w.now = signAt
    await s.beat()
    expect(s.state().state).toBe('idle')
    expect(sentTo(w, HEIR, STOP_HEIR).map((sent) => sent.at)).toEqual([signAt])
    expect(sentTo(w, OWNER, STOP_OWNER)).toHaveLength(1)
    expect(w.audits.find((row) => row.kind === 'owner.succession.cancel')?.detail).toMatchObject({
      reason: 'owner-sign',
      sign: signAt,
    })

    // the rest of the window and the days after it: no grace again, no claim, nobody told to claim
    for (let d = 21; d <= 30; d++) {
      w.now = day(d)
      await s.beat()
      expect(['grace', 'claimable']).not.toContain(s.state().state)
    }
    expect(sentTo(w, HEIR, CLAIM_HEIR)).toHaveLength(0)
    expect(auditKinds(w)).not.toContain('owner.succession.claimable')
    expect(w.warnings).toEqual([])
    s.close()
  })

  test('a sign during a check-in day cancels cleanly: no ask after it, the run ends cancelled', async () => {
    const w = freshWorld()
    const s = boot(join(dir, 'sign-check-in.sqlite'), w)
    await setup(s, { heir: HEIR })
    await runDays(s, w, 1, 5)
    expect(s.state().state).toBe('check-in')
    const before = s.state()

    const signAt = day(5) + 6 * MS_HOUR
    s.sign(OWNER, signAt)
    w.now = signAt
    await s.beat()
    expect(s.state().state).toBe('idle')
    expect(s.runs.get(before.runId ?? '')?.status).toBe('cancelled')
    expect(w.audits.find((row) => row.kind === 'owner.succession.cancel')?.detail).toMatchObject({
      reason: 'owner-sign',
      sign: signAt,
    })
    // the ask of day 5 is the last one of the old run: nothing of it is sent at day 6, when it would time out
    expect(
      asksSent(w)
        .map((ask) => ask.at)
        .filter((at) => at > signAt),
    ).toEqual([])
    expect(sentTo(w, HEIR, STOP_HEIR)).toHaveLength(1)

    // a later run may start on its own from the sign, but it never reaches grace or claim inside the window
    await runDays(s, w, 6, 10)
    expect(['grace', 'claimable']).not.toContain(s.state().state)
    expect(sentTo(w, HEIR, GRACE_HEIR)).toHaveLength(0)
    expect(w.warnings).toEqual([])
    s.close()
  })

  test('a pause for a trip cancels the check-in with reason paused; counting restarts one day after the pause', async () => {
    const w = freshWorld()
    const s = boot(join(dir, 'pause.sqlite'), w)
    await setup(s, { heir: HEIR })
    await runDays(s, w, 1, 5)
    expect(s.state().state).toBe('check-in')

    // the pause runs from day 5 to day 15
    await s.succession.pause(day(15), OWNER_CALLER)
    expect(s.state().state).toBe('idle')
    expect(w.audits.find((row) => row.kind === 'owner.succession.cancel')?.detail).toMatchObject({
      reason: 'paused',
      sign: T0,
    })

    // no check-in during the pause, and the first one a day after its end
    await runDays(s, w, 6, 15)
    expect(
      asksSent(w)
        .map((ask) => ask.at)
        .filter((at) => at > day(5)),
    ).toEqual([])
    expect(s.state().state).toBe('idle')
    await runDays(s, w, 16, 16)
    expect(s.state().state).toBe('check-in')
    expect(
      asksSent(w)
        .map((ask) => ask.at)
        .filter((at) => at > day(5)),
    ).toEqual([day(16)])

    // grace comes 14 days after the pause's end (day 29), and the claim 7 days later (day 36)
    await runDays(s, w, 17, 29)
    expect(s.state()).toMatchObject({ state: 'grace', graceStartedAt: day(29) })
    await runDays(s, w, 30, 36)
    expect(s.state()).toMatchObject({ state: 'claimable', claimableAt: day(36) })
    expect(w.warnings).toEqual([])
    s.close()
  })

  test('a core restart in the middle of the grace continues the same run and sends no grace notice twice', async () => {
    const file = join(dir, 'restart.sqlite')
    const w = freshWorld()
    const first = boot(file, w)
    await setup(first, { heir: HEIR })
    await runDays(first, w, 1, 16)
    expect(first.state().state).toBe('grace')
    const runId = first.state().runId
    first.close()

    // the next process opens the same file on day 16: the wait of the grace is still there
    const second = boot(file, w)
    const report = await second.recover()
    expect(report.waiting).toBeGreaterThanOrEqual(1)
    await runDays(second, w, 16, 16)
    expect(second.state()).toMatchObject({ state: 'grace', runId, graceStartedAt: day(14) })

    await runDays(second, w, 17, 21)
    expect(second.state()).toMatchObject({ state: 'claimable', runId, claimableAt: day(21) })

    // one grace notice per recipient, one claim notice; the grace requests were answered, not sent again
    expect(sentTo(w, HEIR, GRACE_HEIR)).toHaveLength(1)
    expect(sentTo(w, OWNER, GRACE_OWNER)).toHaveLength(1)
    expect(sentTo(w, HEIR, CLAIM_HEIR)).toHaveLength(1)
    const graceKeys = [...w.attempts.keys()].filter((key) => key.includes(':grace-'))
    expect(graceKeys.length).toBeGreaterThan(0)
    for (const key of graceKeys) expect(w.attempts.get(key)).toBe(1)
    expect(second.runs.get(runId ?? '')?.status).toBe('done')
    expect(w.warnings).toEqual([])
    second.close()
  })

  test('no heir: the protocol is disabled and nothing is ever sent', async () => {
    const w = freshWorld()
    const s = boot(join(dir, 'no-heir.sqlite'), w)
    await setup(s, { heir: null })
    await runDays(s, w, 1, 30)
    expect(s.state().state).toBe('idle')
    expect(w.sends).toEqual([])
    expect(s.runs.inStatus('waiting')).toEqual([])
    expect(s.protocols.findBuiltIn('keith', 'owner-absence')?.enabled).toBe(false)
    expect(auditKinds(w)).not.toContain('owner.succession.start')
    expect(w.warnings).toEqual([])
    s.close()
  })

  test('a heir changed during a run cancels it; the old heir hears nothing more, the grace goes to the new heir', async () => {
    const w = freshWorld()
    const s = boot(join(dir, 'heir-changed.sqlite'), w)
    await setup(s, { heir: HEIR })
    await runDays(s, w, 1, 3)
    expect(s.state().state).toBe('check-in')
    const before = s.state()

    await s.succession.setHeir(NEW_HEIR, OWNER_CALLER)
    expect(s.state().state).toBe('idle')
    expect(s.runs.get(before.runId ?? '')?.status).toBe('cancelled')
    expect(w.audits.find((row) => row.kind === 'owner.succession.cancel')?.detail).toMatchObject({
      reason: 'heir-changed',
      heir: HEIR,
    })

    // the old heir gets no notice at all after the change; the grace of the new run goes to the new heir
    await runDays(s, w, 4, 14)
    expect(s.state()).toMatchObject({ state: 'grace', graceStartedAt: day(14) })
    expect(w.sends.filter((sent) => sent.to === HEIR && sent.at > day(3))).toEqual([])
    expect(sentTo(w, NEW_HEIR, GRACE_HEIR).map((sent) => sent.at)).toEqual([day(14)])
    expect(sentTo(w, HEIR, GRACE_HEIR)).toHaveLength(0)
    expect(w.warnings).toEqual([])
    s.close()
  })

  test('window 90: grace at day 90, claimable at day 97, the run never fails on its limits', async () => {
    const w = freshWorld()
    const s = boot(join(dir, 'window-90.sqlite'), w)
    await setup(s, { heir: HEIR, windowDays: 90 })

    await runDays(s, w, 1, 89)
    expect(s.state().state).toBe('check-in')
    await runDays(s, w, 90, 90)
    expect(s.state()).toMatchObject({ state: 'grace', graceStartedAt: day(90) })
    await runDays(s, w, 91, 97)
    const row = s.state()
    expect(row).toMatchObject({ state: 'claimable', claimableAt: day(97) })

    // 89 daily check-ins (one per day before the grace), each to the owner on every channel
    const asks = asksSent(w)
    expect(asks).toHaveLength(89)
    expect(asks.every((ask) => ask.to === OWNER && ask.fanout === 'all')).toBe(true)
    expect(sentTo(w, HEIR, CLAIM_HEIR)).toHaveLength(1)

    // the run ends done after the claim, and it stayed under the step cap
    const run = s.runs.get(row.runId ?? '')
    expect(run?.status).toBe('done')
    // the engine's own count (the visits of the run, `maxSteps` 100): 96 executions for a 90-day window (succession.md)
    expect(run).toBeDefined()
    if (run === undefined) throw new Error('the run is missing')
    expect(totalVisits(stateOf(run).visits)).toBe(96)
    expect(w.warnings).toEqual([])
    s.close()
  })

  // A core that was down catches up at its first ticks (docs/specs/succession.md, "Restart"): the overdue timeouts are
  // read against the silence thresholds with the real clock, not one step per day from the moment of the boot.
  test('(i) a core down 9 days in check-in of a 7-day window catches up: grace within a few ticks', async () => {
    const file = join(dir, 'downtime-9.sqlite')
    const w = freshWorld()
    const first = boot(file, w)
    await setup(first, { heir: HEIR, windowDays: 7 })
    await runDays(first, w, 1, 3)
    expect(first.state().state).toBe('check-in')
    first.close()

    // the owner stays silent while the core is down; it comes back nine days later on the same file
    w.now = day(3) + 9 * MS_DAY
    const second = boot(file, w)
    await second.recover()
    for (let tick = 0; tick < 3; tick++) await second.beat()
    expect(second.state().state).toBe('grace')
    expect(sentTo(w, HEIR, GRACE_HEIR)).toHaveLength(1)
    expect(sentTo(w, OWNER, GRACE_OWNER)).toHaveLength(1)
    expect(w.warnings).toEqual([])
    second.close()
  })

  // The grace is recorded when the core first sees the silence (`begin-grace` at the tick), and the owner is told then:
  // the seven days of notice run from that record, never from the silence's start. Backdating the grace to the missed
  // timeout would give the owner no notice at all, so the claim opens seven days after the restart, not at once.
  test('(j) a core down 16 days in check-in of a 7-day window catches up: grace at once, claimable 7 days later', async () => {
    const file = join(dir, 'downtime-16.sqlite')
    const w = freshWorld()
    const first = boot(file, w)
    await setup(first, { heir: HEIR, windowDays: 7 })
    await runDays(first, w, 1, 3)
    expect(first.state().state).toBe('check-in')
    first.close()

    w.now = day(3) + 16 * MS_DAY
    const second = boot(file, w)
    await second.recover()
    for (let tick = 0; tick < 3; tick++) await second.beat()
    expect(second.state()).toMatchObject({ state: 'grace', graceStartedAt: day(19) })
    expect(sentTo(w, HEIR, GRACE_HEIR).map((sent) => sent.at)).toEqual([day(19)])
    expect(sentTo(w, OWNER, GRACE_OWNER).map((sent) => sent.at)).toEqual([day(19)])

    await runDays(second, w, 20, 25)
    expect(second.state().state).toBe('grace')
    await runDays(second, w, 26, 26)
    expect(second.state()).toMatchObject({ state: 'claimable', claimableAt: day(26) })
    expect(sentTo(w, HEIR, CLAIM_HEIR).map((sent) => sent.at)).toEqual([day(26)])
    expect(w.warnings).toEqual([])
    second.close()
  })
})
