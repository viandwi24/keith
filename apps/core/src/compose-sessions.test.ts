import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsRepo, sqliteActivityStore, sqliteLock } from '@keith/db'
import { defineHarnessAgent, type HarnessAgent } from 'eharness'
import { inMemoryMessages, inMemoryState } from 'eharness/storage/memory'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import {
  closeRoomAgent,
  createSessionCare,
  recoverRooms,
  unansweredQueued,
} from './compose-sessions.ts'
import { createBudget, FRONT_TURN_BUDGET_USD } from './modules/budget/index.ts'
import { createRoomContext } from './modules/corpus-callosum/context.ts'
import { as, roomWorld } from './modules/corpus-callosum/fixtures.ts'
import { createRoomSettings } from './modules/corpus-callosum/settings.ts'
import { createTextTransport } from './modules/corpus-callosum/transport-text.ts'
import { createRoomTurns, type RoomTurns } from './modules/corpus-callosum/turns.ts'
import { type Logger, silentLogger } from './platform/logger.ts'
import { until } from './testing/wait.ts'

type Status = 'active' | 'suspended'
const person = (id: string, status: Status = 'active', role = 'member') => ({ id, status, role })

function setup(
  people: ReturnType<typeof person>[],
  owner = 'owner',
  logger: Logger = silentLogger,
  generationOf: (personId: string) => number = () => 0,
) {
  const injected: string[] = []
  const recovered: string[] = []
  const opened = (id: string) => ({
    inject: async () => void injected.push(id),
    recover: async () => {
      recovered.push(id)
      return { recovered: false }
    },
  })
  const lead = { session: (id: string) => opened(id) } as unknown as HarnessAgent
  const care = createSessionCare({
    generations: { current: generationOf },
    people: {
      list: async () => people as never,
      get: async (ref: string) => {
        const found = people.find((p) => p.id === ref)
        if (found === undefined) throw new Error('no person')
        return found as never
      },
      owner: async () => people.find((p) => p.id === owner) as never,
    },
    lock: {} as never,
    logger,
    lead: () => lead,
  })
  return { care, injected, recovered, lead }
}

const dead = (sessionId: string) =>
  ({ sessionId, kind: 'wake', attempts: 3, reason: 'max-attempts' }) as never

describe('session care', () => {
  test('a dead letter goes to the front of the person it belongs to, a worker included', async () => {
    const t = setup([person('owner', 'active', 'owner'), person('ana')])
    await t.care.onDeadLetter(dead('front:ana:agent:c1'))
    await t.care.onDeadLetter(dead('front:owner'))
    expect(t.injected).toEqual(['front:ana', 'front:owner'])
  })

  test('a dead letter without a session goes to the current owner, after a transfer too', async () => {
    const t = setup([person('owner'), person('ana', 'active', 'owner')], 'ana')
    await t.care.onDeadLetter(dead(''))
    expect(t.injected).toEqual(['front:ana'])
  })

  test('a guest session dead letter is only logged: the owner gets nothing, whatever the id looks like', async () => {
    const errors: string[] = []
    const t = setup([person('owner', 'active', 'owner'), person('ana')], 'owner', {
      ...silentLogger,
      error: (message: string) => void errors.push(message),
    })
    // guests are not people: no front session exists for them
    await t.care.onDeadLetter(dead('guest:g1'))
    await t.care.onDeadLetter(dead('front:guest:g1'))
    await t.care.onDeadLetter(dead('front:guest:g1:agent:c1'))
    expect(errors).toHaveLength(3)
    expect(t.injected).toEqual([])
  })

  test('nothing is routed to a suspended or removed person', async () => {
    const t = setup([person('owner', 'active', 'owner'), person('bob', 'suspended')])
    await t.care.onDeadLetter(dead('front:bob'))
    await t.care.onDeadLetter(dead('front:gone:agent:c1'))
    expect(t.injected).toEqual([])
  })

  test('boot recovery covers every person who exists, suspended ones included', async () => {
    const t = setup([person('owner', 'active', 'owner'), person('ana'), person('bob', 'suspended')])
    await t.care.recoverAll(t.lead)
    expect(t.recovered).toEqual(['front:owner', 'front:ana', 'front:bob'])
  })

  test('boot recovery repairs only the current generation of each person (ADR-0030 §10)', async () => {
    const t = setup(
      [person('owner', 'active', 'owner'), person('ana')],
      'owner',
      silentLogger,
      (personId) => (personId === 'ana' ? 2 : 0),
    )
    await t.care.recoverAll(t.lead)
    expect(t.recovered).toEqual(['front:owner', 'front:ana:g2'])
  })

  test('reconcile: a person whose repair throws does not stop the repair of the people after them', async () => {
    const warnings: string[] = []
    const people = [person('owner', 'active', 'owner'), person('ana'), person('bob'), person('cy')]
    const repaired: string[] = []
    // the session handle is the one `agent.session` opened for that person
    const cortex = {
      reconcile: async (session: { __id: string }) => {
        if (session.__id === 'front:ana') throw new Error('no worker "lost-agent"')
        repaired.push(session.__id)
        return []
      },
    }
    const agent = {
      session: (id: string) => ({ __id: id }),
    } as unknown as HarnessAgent
    const care = createSessionCare({
      generations: { current: () => 0 },
      people: {
        list: async () => people as never,
        get: async () => people[0] as never,
        owner: async () => people[0] as never,
      },
      lock: {} as never,
      logger: { ...silentLogger, warn: (m: string) => warnings.push(m) },
      lead: () => agent,
    })
    await care.reconcileAll(agent, cortex as never, { tasks: {} as never, store: {} as never })
    expect(repaired).toEqual(['front:owner', 'front:bob', 'front:cy'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('front:ana')
  })
})

// Room recovery (P30.3.5): a core boot runs the queued messages no answer followed, once, and a graceful stop interrupts a
// room turn like a front turn. A "boot" is a fresh room agent and turn pipeline over the same database and message storage,
// as a restarted core has them; the model is scripted and held (calls wait until the test or the abort releases them).
describe('room recovery', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'keith-room-recovery-'))
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  const CATALOG = { 'mock/scripted': { contextWindow: 100_000, pricing: { input: 1, output: 4 } } }
  const quiet = { info: () => {}, warn: () => {} }

  /** A scripted model whose calls wait while `gate.hold` is pending, unless the call is aborted; `entered` counts the calls. */
  function heldModel(steps: ScriptedStepInput[], gate: { hold?: Promise<void>; entered: number }) {
    const inner = scriptedModel(steps)
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop !== 'doStream') return Reflect.get(target, prop, receiver)
        return async (call: Parameters<typeof inner.doStream>[0]) => {
          gate.entered += 1
          const hold = gate.hold
          if (hold !== undefined) {
            await new Promise<void>((resolve) => {
              call.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
              void hold.then(() => resolve())
            })
          }
          return target.doStream(call)
        }
      },
    })
  }

  /** One boot of the core's room part over the shared database `w` and message storage `storage`. */
  function boot(
    w: ReturnType<typeof roomWorld>,
    storage: {
      messages: ReturnType<typeof inMemoryMessages>
      state: ReturnType<typeof inMemoryState>
    },
    steps: ScriptedStepInput[],
    owner: string,
  ) {
    const gate: { hold?: Promise<void>; entered: number } = { entered: 0 }
    const stops: unknown[] = []
    const model = heldModel(steps, gate)
    const budget = createBudget({
      generations: { current: () => 0 },
      sqlite: w.sqlite,
      settings: settingsRepo(w.sqlite),
      store: sqliteActivityStore(w.sqlite),
    })
    const lock = sqliteLock(w.sqlite, { owner })
    const agent = defineHarnessAgent({
      id: 'room',
      model: model as never,
      models: CATALOG,
      contextWindow: 100_000,
      plugins: [
        createRoomContext({
          rooms: w.rooms,
          disclosedFor: async () => ({ line: null }),
          listWorkspace: () => [],
          now: w.now,
          name: (id) => id,
        }),
      ] as never,
      budget: budget.config({ maxTurnUsd: FRONT_TURN_BUDGET_USD }),
      storage,
    }) as HarnessAgent
    const turns: RoomTurns = createRoomTurns({
      agent,
      lock,
      service: w.svc,
      rooms: w.rooms,
      transport: createTextTransport({
        rooms: w.rooms,
        activity: { append: async () => ({}) } as never,
        now: w.now,
      }),
      budget,
      settings: createRoomSettings(settingsRepo(w.sqlite)),
      activity: { record: (_sessionId, _type, payload) => stops.push(payload.stop) },
      now: w.now,
    })
    const deps = { rooms: w.rooms, agent, turns, lock }
    return { agent, turns, gate, model, deps, stops }
  }

  const keithLines = (w: ReturnType<typeof roomWorld>, roomId: string) =>
    w.rooms
      .eventsForOwner(roomId, 0, 500)
      .filter((e) => e.kind === 'keith')
      .map((e) => ({ text: e.text, answers: e.data?.answers }))

  const idle = (turns: RoomTurns, roomId: string) =>
    until(
      `room ${roomId} idle`,
      () => turns.busy(roomId),
      (busy) => !busy,
    )

  const newStorage = () => ({ messages: inMemoryMessages(), state: inMemoryState() })

  test('a core restart with a queued message answers it once, and a second restart answers nothing more', async () => {
    const w = roomWorld(dataDir)
    const started = await w.svc.start(as('ana'), { invite: ['bob'] })
    const roomId = started.room.id
    await w.svc.accept(as('bob'), roomId)
    const storage = newStorage()
    // the process that died stored bob's message as queued and never answered it
    const queued = await w.svc.say(as('bob'), roomId, '@keith queued', { queued: true })
    expect(unansweredQueued(w.rooms, roomId).map((e) => e.seq)).toEqual([queued])

    const second = boot(w, storage, [{ text: 'answer to queued' }, { text: 'never' }], 'boot-2')
    await recoverRooms(second.deps, quiet)
    await idle(second.turns, roomId)
    expect(keithLines(w, roomId)).toEqual([{ text: 'answer to queued', answers: queued }])
    expect(second.model.prompts).toHaveLength(1)

    const third = boot(w, storage, [{ text: 'never again' }], 'boot-3')
    await recoverRooms(third.deps, quiet)
    await idle(third.turns, roomId)
    expect(keithLines(w, roomId)).toHaveLength(1)
    expect(third.model.prompts).toHaveLength(0)
    expect(unansweredQueued(w.rooms, roomId)).toEqual([])
  })

  test('a graceful stop interrupts the room turn in flight: no answer, and the queued message runs at the next boot', async () => {
    const w = roomWorld(dataDir)
    const started = await w.svc.start(as('ana'), { invite: ['bob'] })
    const roomId = started.room.id
    await w.svc.accept(as('bob'), roomId)
    const storage = newStorage()

    const first = boot(w, storage, [{ text: 'held answer' }], 'boot-1')
    first.gate.hold = new Promise<void>(() => {})
    await first.turns.say(as('ana'), roomId, '@keith long question')
    await until(
      'the room turn reaches the model',
      () => first.gate.entered,
      (n) => n === 1,
    )
    const queued = await first.turns.say(as('bob'), roomId, '@keith waits')
    expect(queued.queued).toBe(true)

    await closeRoomAgent(first.deps, quiet)
    await idle(first.turns, roomId)
    // the turn ended as interrupted, wrote no answer, and its queued message has none either
    expect(first.stops).toEqual(['interrupted'])
    expect(keithLines(w, roomId)).toEqual([])
    expect(unansweredQueued(w.rooms, roomId).map((e) => e.seq)).toEqual([queued.seq])

    const next = boot(w, storage, [{ text: 'answer after the restart' }], 'boot-2')
    await recoverRooms(next.deps, quiet)
    await idle(next.turns, roomId)
    expect(keithLines(w, roomId)).toEqual([
      { text: 'answer after the restart', answers: queued.seq },
    ])
  })
})
