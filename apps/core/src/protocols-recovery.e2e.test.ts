import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PresenceState } from '@keith/contracts'
import { migrateDatabase, openDatabase, protocolRunsRepo, protocolsRepo } from '@keith/db'
import { APPROVAL_PING_BEFORE_MS } from './modules/hypothalamus/builtins.ts'
import { createEngine, type ProtocolEngine } from './modules/hypothalamus/engine.ts'
import {
  ask,
  HOUR,
  MINUTE,
  NOW,
  notify,
  protocol,
  wait,
} from './modules/hypothalamus/engine-harness.ts'
import type { StepResult, StepRunInput, StepRunner } from './modules/hypothalamus/ports.ts'

// Recovery of the protocol engine over a real SQLite file (docs/specs/hypothalamus.md, "Restart"): each "process" is a
// connection to the same file, an engine over the repos, and a clock the test moves. The delivery service is a map that
// outlives a process (as P25's table does): a key it has seen answers its stored outcome and sends nothing again.

const dir = mkdtempSync(join(tmpdir(), 'keith-protocols-recovery-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Process {
  engine: ProtocolEngine
  runs: ReturnType<typeof protocolRunsRepo>
  protocols: ReturnType<typeof protocolsRepo>
  calls: string[]
  tells: string[]
  crash(): void
}

/** The world a process sees: a clock, a presence state, the delivery service (shared) and what this process hangs on. */
interface World {
  now: number
  presence: PresenceState | null
  delivered: Map<string, string>
  sends: string[]
  /** A step whose key is in this set never returns (a crash in the middle of the step). */
  hang: Set<string>
}

function boot(file: string, world: World): Process {
  const sqlite = openDatabase(file)
  migrateDatabase(sqlite)
  const protocols = protocolsRepo(sqlite)
  const runs = protocolRunsRepo(sqlite)
  const calls: string[] = []
  const tells: string[] = []
  const steps: StepRunner = {
    async run(input: StepRunInput): Promise<StepResult> {
      calls.push(`${input.step.kind}:${input.key}`)
      if (input.step.kind === 'act') {
        // an act is never sent twice: the first call of this process is the only one
        if (world.hang.has(input.key)) return new Promise<never>(() => {})
        return { kind: 'done', outcome: 'ok' }
      }
      const prior = world.delivered.get(input.key)
      if (prior === undefined) {
        world.delivered.set(input.key, 'ok')
        world.sends.push(input.key)
      }
      if (world.hang.has(input.key)) return new Promise<never>(() => {})
      if (input.step.kind === 'ask') return { kind: 'open', timeoutMs: HOUR }
      return { kind: 'done', outcome: prior ?? 'ok' }
    },
    async tell(input) {
      tells.push(input.key)
    },
  }
  const engine = createEngine({
    pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
    clock: { now: () => world.now, timeZone: 'UTC' },
    conditions: {
      clock: { now: () => world.now, timeZone: 'UTC' },
      presence: async () => world.presence,
      agenda: { confirmedNow: async () => false },
      lastSign: async () => null,
      budget: { remaining: async () => 1 },
      approvals: { pending: async () => null },
    },
    protocols,
    runs,
    steps,
    journal: { audit() {}, event() {} },
    transaction: (fn) => sqlite.transaction(fn).immediate(),
    ownerOf: async () => 'vian',
  })
  return {
    engine,
    runs,
    protocols,
    calls,
    tells,
    crash: () => sqlite.close(),
  }
}

const freshWorld = (now = NOW): World => ({
  now,
  presence: null,
  delivered: new Map(),
  sends: [],
  hang: new Set(),
})

const newFile = (name: string): string => join(dir, `${name}.sqlite`)

/** A step that waits for the process to hang: the test only needs the call to have started. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5)
}

describe('restart of the protocol engine', () => {
  test('a run waiting one hour survives a restart and advances when its wake time comes', async () => {
    const file = newFile('waiting')
    const world = freshWorld()
    const first = boot(file, world)
    first.protocols.create(
      {
        id: 'p1',
        owner: 'ana',
        name: 'check-in',
        definition: JSON.stringify(
          protocol([
            notify('tell', { next: 'pause' }),
            wait('pause', HOUR, 'again'),
            notify('again'),
          ]),
        ),
        savedBy: 'ana',
      },
      world.now,
    )
    const started = await first.engine.start({
      protocolId: 'p1',
      trigger: 'time',
      triggerRef: 'fire-1',
    })
    if (started.status !== 'created') throw new Error(started.status)
    const runId = started.run.id
    expect(first.runs.get(runId)?.status).toBe('waiting')
    first.crash()

    // the next process starts 30 minutes later: the run is still waiting, nothing is sent again
    world.now = NOW + 30 * MINUTE
    const second = boot(file, world)
    const report = await second.engine.recover()
    expect(report).toEqual({ waiting: 1, resumed: 0 })
    expect(second.engine.watched.has(runId)).toBe(false)
    await second.engine.tick()
    expect(second.runs.get(runId)?.status).toBe('waiting')
    expect(second.runs.get(runId)?.wakeAt).toBe(NOW + HOUR)

    // an hour later the next process advances it: the second notify goes out once
    world.now = NOW + HOUR + MINUTE
    const third = boot(file, world)
    await third.engine.recover()
    await third.engine.tick()
    expect(third.runs.get(runId)?.status).toBe('done')
    expect(world.sends).toEqual([`${runId}:tell:1`, `${runId}:again:1`])
    third.crash()
  })

  test('a notify in flight at the crash is replayed with its key: it is sent once, the run goes on', async () => {
    const file = newFile('mid-step')
    const world = freshWorld()
    const first = boot(file, world)
    first.protocols.create(
      {
        id: 'p2',
        owner: 'ana',
        name: 'ladder',
        definition: JSON.stringify(
          protocol([notify('tell', { next: 'pause' }), wait('pause', HOUR)]),
        ),
        savedBy: 'ana',
      },
      world.now,
    )
    // the delivery is made and the call hangs before its outcome is written: the step row stays `started`
    const runId = runIdOf('p2', 'fire-3')
    world.hang.add(`${runId}:tell:1`)
    void first.engine.start({ protocolId: 'p2', trigger: 'time', triggerRef: 'fire-3' })
    await until(() => first.calls.length >= 1)
    first.crash()
    world.hang.clear()

    const second = boot(file, world)
    const report = await second.engine.recover()
    expect(report.resumed).toBe(1)
    await second.engine.tick()
    expect(second.runs.get(runId)?.status).toBe('waiting')
    // the wait has no `next`: the run waits for it, then ends
    expect(second.runs.get(runId)?.wakeAt).toBe(NOW + HOUR)
    expect(second.runs.steps(runId).map((row) => `${row.step}:${row.outcome}`)).toEqual([
      // the replayed row is the one settled: one row per execution
      'tell:ok',
      'pause:ok',
    ])
    // the replay answered from the delivery service: the message went out once
    expect(world.sends.filter((key) => key === `${runId}:tell:1`)).toHaveLength(1)
    second.crash()
  })

  test('an act in flight at the crash becomes unknown: never repeated, and the owner is told once', async () => {
    const file = newFile('act')
    const world = freshWorld()
    const first = boot(file, world)
    const act = {
      id: 'run',
      kind: 'act',
      operation: { kind: 'node.capability', node: 'laptop', capability: 'shell.exec' },
      input: { command: 'df -h' },
    }
    first.protocols.create(
      {
        id: 'p3',
        owner: 'vian',
        name: 'disk',
        definition: JSON.stringify(protocol([act])),
        savedBy: 'vian',
      },
      world.now,
    )
    const runId = runIdOf('p3', 'fire-4')
    world.hang.add(`${runId}:run:1`)
    void first.engine.start({ protocolId: 'p3', trigger: 'time', triggerRef: 'fire-4' })
    await until(() => first.calls.length >= 1)
    first.crash()
    world.hang.clear()

    const second = boot(file, world)
    await second.engine.recover()
    expect(second.runs.get(runId)?.status).toBe('failed')
    expect(second.tells).toEqual([`${runId}:unknown`])
    expect(second.runs.steps(runId).at(-1)?.outcome).toBe('unknown')
    // the act was called once, by the process that crashed; the restart never calls it again
    expect(first.calls.filter((call) => call.startsWith('act:'))).toHaveLength(1)
    expect(second.calls.filter((call) => call.startsWith('act:'))).toHaveLength(0)
    second.crash()
  })

  test('a waiting ask keeps its deadline across a restart and times out at it', async () => {
    const file = newFile('ask')
    const world = freshWorld()
    const first = boot(file, world)
    first.protocols.create(
      {
        id: 'p4',
        owner: 'ana',
        name: 'question',
        definition: JSON.stringify(protocol([ask('q', ['yes', 'no'], [])])),
        savedBy: 'ana',
      },
      world.now,
    )
    const started = await first.engine.start({
      protocolId: 'p4',
      trigger: 'time',
      triggerRef: 'fire-5',
    })
    if (started.status !== 'created') throw new Error(started.status)
    const runId = started.run.id
    expect(first.runs.get(runId)?.wakeAt).toBe(NOW + HOUR)
    first.crash()

    world.now = NOW + 30 * MINUTE
    const second = boot(file, world)
    await second.engine.recover()
    await second.engine.tick()
    expect(second.runs.get(runId)?.status).toBe('waiting')
    expect(second.runs.get(runId)?.wakeAt).toBe(NOW + HOUR)
    world.now = NOW + HOUR
    await second.engine.tick()
    expect(second.runs.get(runId)?.status).toBe('expired')
    second.crash()
  })

  test('a waiting run with cancelWhen is watched again after a restart and cancelled by it', async () => {
    const file = newFile('cancel')
    const world = freshWorld()
    const first = boot(file, world)
    first.protocols.create(
      {
        id: 'p5',
        owner: 'ana',
        name: 'quiet',
        definition: JSON.stringify(
          protocol([wait('pause', HOUR, 'tell'), notify('tell')], {
            cancelWhen: { kind: 'presence', person: 'ana', in: ['busy'] },
          }),
        ),
        savedBy: 'ana',
      },
      world.now,
    )
    const started = await first.engine.start({
      protocolId: 'p5',
      trigger: 'time',
      triggerRef: 'fire-6',
    })
    if (started.status !== 'created') throw new Error(started.status)
    const runId = started.run.id
    first.crash()

    const second = boot(file, world)
    const report = await second.engine.recover()
    expect(report.waiting).toBe(1)
    expect(second.engine.watched.has(runId)).toBe(true)
    world.presence = 'busy'
    const outcome = await second.engine.tick()
    expect(outcome.cancelled).toBe(1)
    expect(second.runs.get(runId)?.status).toBe('cancelled')
    second.crash()
  })
})

/** The run id of a trigger (`runIdFor` in steps.ts), without importing the engine's internals into the test. */
function runIdOf(protocolId: string, triggerRef: string): string {
  const digest = new Bun.CryptoHasher('sha256').update(`${protocolId}\n${triggerRef}`).digest('hex')
  return `run_${digest.slice(0, 32)}`
}
