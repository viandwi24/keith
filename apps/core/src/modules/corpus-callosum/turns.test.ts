// The turn pipeline (P30.3.3): one turn at a time per room, the speaker as each turn's principal, the queue bound, the hourly
// limit, the budget of the speaker (no budget: a notice and no turn), the cost in the speaker's scope, and no parking.
// A real SQLite room world, the real text transport and budget, and a scripted model in a room-shaped agent (the room tools,
// the room approval and the room context; the front role model is not needed for these tests).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { budgetStatus, settingsRepo, sqliteActivityStore, sqliteLock } from '@keith/db'
import { tool } from 'ai'
import { defineHarnessAgent, definePlugin, type HarnessAgent } from 'eharness'
import { inMemoryMessages, inMemoryState } from 'eharness/storage/memory'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { until } from '../../testing/wait.ts'
import { createBudget, FRONT_TURN_BUDGET_USD } from '../budget/index.ts'
import { templateToBody } from '../prefrontal/index.ts'
import { roomApproval } from './agent.ts'
import { createRoomContext } from './context.ts'
import { as, refusal, roomWorld } from './fixtures.ts'
import { createRoomTurnSeqs } from './handoff.ts'
import { type RoomError, roomSessionId } from './service.ts'
import { createRoomSettings } from './settings.ts'
import { roomTools } from './tools.ts'
import { createTextTransport } from './transport-text.ts'
import {
  ANSWER_FAILED_NOTICE,
  createRoomTurns,
  NO_BUDGET_NOTICE,
  ROOM_BUSY,
  ROOM_TURN_LIMIT,
  type RoomTurns,
} from './turns.ts'
import { createRoomWorkspace } from './workspace.ts'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-room-turns-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** The scripted model priced per million tokens, so a turn's usage is a real cost (not an unpriced warning). */
const CATALOG = { 'mock/scripted': { contextWindow: 100_000, pricing: { input: 1, output: 4 } } }

/** What each turn's hook saw: the principal and the kind of the turn. */
interface Seen {
  principal: string | undefined
  kind: string | undefined
}

/** A room with ana (the initiator) and bob active, and the pipeline over a scripted room agent. */
function setup(steps: ScriptedStepInput[], failedLine?: () => string) {
  const w = roomWorld(dataDir)
  const budget = createBudget({
    generations: { current: () => 0 },
    sqlite: w.sqlite,
    settings: settingsRepo(w.sqlite),
    store: sqliteActivityStore(w.sqlite),
  })
  const settings = createRoomSettings(settingsRepo(w.sqlite))
  const lock = sqliteLock(w.sqlite, { owner: 'turns-test' })
  const transport = createTextTransport({
    rooms: w.rooms,
    activity: { append: async () => ({}) } as never,
    now: w.now,
  })
  const model = scriptedModel(steps)
  const seen: Seen[] = []
  const activities: { sessionId: string; payload: Record<string, unknown> }[] = []
  // a gate the test holds: the turn in progress waits in `turn.prepare` until the test releases it
  const gate: { hold?: Promise<void> } = {}
  const agent = defineHarnessAgent({
    id: 'room',
    model,
    models: CATALOG,
    contextWindow: 100_000,
    plugins: [
      definePlugin({
        name: 'probe',
        setup: () => ({
          tools: {
            wipe_room: tool({
              description: 'Wipe the room (never offered to a room).',
              inputSchema: z.object({}),
              metadata: { risk: 'destructive' },
              execute: () => 'wiped',
            }),
          },
          hooks: {
            'turn.prepare': async (ctx) => {
              seen.push({ principal: ctx.principal?.id, kind: ctx.turn?.kind })
              if (gate.hold !== undefined) await gate.hold
            },
          },
        }),
      }),
      roomApproval(),
      roomTools({
        rooms: w.rooms,
        service: w.svc,
        presence: { disclosedFor: async () => ({ level: 'none', line: null }) },
        transport,
        people: { get: async (ref: string) => ({ name: ref }) as never },
        handoff: { hand: async () => ({ status: 'handed' as const }) },
        turnSeqs: createRoomTurnSeqs(),
      }),
      createRoomContext({
        rooms: w.rooms,
        disclosedFor: async () => ({ line: null }),
        listWorkspace: () => [],
        now: w.now,
        name: (id) => id,
      }),
    ] as never,
    budget: budget.config({ maxTurnUsd: FRONT_TURN_BUDGET_USD }),
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
  }) as HarnessAgent
  const turns: RoomTurns = createRoomTurns({
    agent,
    lock,
    service: w.svc,
    rooms: w.rooms,
    transport,
    budget,
    settings,
    activity: { record: (sessionId, _type, payload) => activities.push({ sessionId, payload }) },
    now: w.now,
    ...(failedLine === undefined ? {} : { answerFailedLine: failedLine }),
  })
  return { w, agent, budget, settings, transport, turns, seen, activities, gate, model }
}

/** A room started by ana with bob invited and accepted; the room id. */
async function startRoom(w: ReturnType<typeof setup>['w']): Promise<string> {
  const started = await w.svc.start(as('ana'), { invite: ['bob'] })
  await w.svc.accept(as('bob'), started.room.id)
  createRoomWorkspace(dataDir, started.room.id)
  return started.room.id
}

const idle = (turns: RoomTurns, roomId: string) =>
  until(
    `room ${roomId} idle`,
    () => turns.busy(roomId),
    (busy) => !busy,
  )

/** The Keith lines of a room, with their `answers` marker (the say row each one answers). */
const keithLines = (w: ReturnType<typeof setup>['w'], roomId: string) =>
  w.rooms
    .eventsForOwner(roomId, 0, 500)
    .filter((e) => e.kind === 'keith')
    .map((e) => ({ text: e.text, answers: e.data?.answers }))

const rowOf = (w: ReturnType<typeof setup>['w'], roomId: string, text: string) =>
  w.rooms.eventsForOwner(roomId, 0, 500).find((e) => e.kind === 'say' && e.text === text)

describe('turns: order and the principal of each turn', () => {
  test('turns of A then B run in order, and each turn runs as its speaker', async () => {
    const t = setup([{ text: 'to ana' }, { text: 'to bob' }])
    const roomId = await startRoom(t.w)
    const first = await t.turns.say(as('ana'), roomId, '@keith first')
    expect(first).toEqual({ seq: expect.any(Number), queued: false, addressed: true })
    await idle(t.turns, roomId)
    const second = await t.turns.say(as('bob'), roomId, 'keith second')
    expect(second.addressed).toBe(true)
    await idle(t.turns, roomId)

    expect(t.seen.map((s) => s.principal)).toEqual(['ana', 'bob'])
    expect(t.seen.every((s) => s.kind === 'send')).toBe(true)
    expect(keithLines(t.w, roomId)).toEqual([
      { text: 'to ana', answers: first.seq },
      { text: 'to bob', answers: second.seq },
    ])
    expect(t.activities.map((a) => a.payload)).toEqual([
      expect.objectContaining({ roomId, speakerId: 'ana', stop: 'complete' }),
      expect.objectContaining({ roomId, speakerId: 'bob', stop: 'complete' }),
    ])
    expect(t.activities.every((a) => a.sessionId === roomSessionId(roomId, 1))).toBe(true)
    expect(t.transport.indicatorOf(roomId)).toEqual({ kind: 'idle' })
  })

  test('a message while a turn runs queues, is marked queued, and runs next with its own principal', async () => {
    const t = setup([{ text: 'one' }, { text: 'two' }])
    const roomId = await startRoom(t.w)
    let release!: () => void
    t.gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = await t.turns.say(as('ana'), roomId, '@keith a')
    await until(
      'ana turn started',
      () => t.seen.length,
      (n) => n === 1,
    )
    const b = await t.turns.say(as('bob'), roomId, '@keith b')
    expect(a.queued).toBe(false)
    expect(b).toEqual({ seq: expect.any(Number), queued: true, addressed: true })
    expect(rowOf(t.w, roomId, '@keith b')?.data).toEqual({ queued: true })
    expect(t.turns.busy(roomId)).toBe(true)

    release()
    await idle(t.turns, roomId)
    expect(t.seen.map((s) => s.principal)).toEqual(['ana', 'bob'])
    expect(keithLines(t.w, roomId).map((l) => l.answers)).toEqual([a.seq, b.seq])
  })
})

describe('turns: queue bound and hourly limit', () => {
  test('the 11th waiting message is refused as room is busy, and its line is kept as refused', async () => {
    const steps: ScriptedStepInput[] = Array.from({ length: 11 }, (_, i) => ({ text: `r${i}` }))
    const t = setup(steps)
    const roomId = await startRoom(t.w)
    let release!: () => void
    t.gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    await t.turns.say(as('ana'), roomId, '@keith 0')
    await until(
      'the first turn started',
      () => t.seen.length,
      (n) => n === 1,
    )
    for (let i = 1; i <= 10; i++) {
      const queued = await t.turns.say(as('bob'), roomId, `@keith ${i}`)
      expect(queued.queued).toBe(true)
    }
    const error = (await refusal(() => t.turns.say(as('bob'), roomId, '@keith 11'))) as RoomError
    expect(error.code).toBe('TOO_MANY_REQUESTS')
    expect(error.message).toBe(ROOM_BUSY)
    expect(rowOf(t.w, roomId, '@keith 11')?.data).toEqual({ refused: true })

    release()
    await idle(t.turns, roomId)
    expect(t.seen).toHaveLength(11)
    expect(keithLines(t.w, roomId)).toHaveLength(11)
  })

  test('the hourly limit refuses the message over rooms.maxTurnsPerHour, with the same marker', async () => {
    const t = setup([{ text: 'a' }, { text: 'b' }])
    const roomId = await startRoom(t.w)
    t.settings.set({ maxTurnsPerHour: 2 })
    await t.turns.say(as('ana'), roomId, '@keith one')
    await idle(t.turns, roomId)
    await t.turns.say(as('ana'), roomId, '@keith two')
    await idle(t.turns, roomId)
    const error = (await refusal(() => t.turns.say(as('ana'), roomId, '@keith three'))) as RoomError
    expect(error.code).toBe('TOO_MANY_REQUESTS')
    expect(error.message).toBe(ROOM_TURN_LIMIT)
    expect(rowOf(t.w, roomId, '@keith three')?.data).toEqual({ refused: true })
    expect(t.seen).toHaveLength(2)
  })
})

describe('turns: which lines start a turn', () => {
  test('in addressed mode a plain line starts no turn', async () => {
    const t = setup([{ text: 'never' }])
    const roomId = await startRoom(t.w)
    const plain = await t.turns.say(as('ana'), roomId, 'hello room')
    expect(plain).toEqual({ seq: expect.any(Number), queued: false, addressed: false })
    expect(t.turns.busy(roomId)).toBe(false)
    expect(t.seen).toEqual([])
    expect(rowOf(t.w, roomId, 'hello room')?.data).toBeNull()
  })

  test('in every mode each line starts a turn', async () => {
    const t = setup([{ text: 'to a line' }])
    const roomId = await startRoom(t.w)
    t.w.sqlite.query("UPDATE rooms SET answer_mode = 'every' WHERE id = ?").run(roomId)
    const line = await t.turns.say(as('ana'), roomId, 'hello room')
    expect(line.addressed).toBe(true)
    await idle(t.turns, roomId)
    expect(t.seen.map((s) => s.principal)).toEqual(['ana'])
    expect(keithLines(t.w, roomId)).toEqual([{ text: 'to a line', answers: line.seq }])
  })
})

describe('turns: the budget of the speaker', () => {
  test('a speaker without budget gets the notice and no turn; another speaker still gets one', async () => {
    const t = setup([{ text: 'to ana' }])
    const roomId = await startRoom(t.w)
    t.budget.setPersonCap('bob', 0.01)
    const bob = await t.turns.say(as('bob'), roomId, '@keith hi')
    await idle(t.turns, roomId)
    expect(t.seen).toEqual([])
    expect(keithLines(t.w, roomId)).toEqual([{ text: NO_BUDGET_NOTICE, answers: bob.seq }])
    expect(t.activities.at(-1)?.payload).toEqual({ roomId, speakerId: 'bob' })

    const ana = await t.turns.say(as('ana'), roomId, '@keith hello')
    await idle(t.turns, roomId)
    expect(t.seen.map((s) => s.principal)).toEqual(['ana'])
    expect(keithLines(t.w, roomId).at(-1)).toEqual({ text: 'to ana', answers: ana.seq })
  })

  test('the cost of a turn lands in the speaker’s scope, never the other person’s', async () => {
    const t = setup([{ text: 'answer', usage: { inputTokens: 100_000, outputTokens: 50_000 } }])
    const roomId = await startRoom(t.w)
    await t.turns.say(as('bob'), roomId, '@keith spend')
    await idle(t.turns, roomId)
    expect(t.seen.map((s) => s.principal)).toEqual(['bob'])
    const [bob, ana] = budgetStatus(t.w.sqlite, ['person:bob', 'person:ana'])
    // 100 000 input and 50 000 output tokens at 1 and 4 USD per million: 0.3 USD
    expect(bob?.spentUsd).toBeCloseTo(0.3, 6)
    expect(ana?.spentUsd ?? 0).toBe(0)
  })
})

describe('turns: the notice of an answer that failed is the persona line', () => {
  test('a failed turn writes the persona line; after a template switch the next notice is the new line', async () => {
    let line: string = templateToBody('butler').lines.answerFailed
    const t = setup(
      [{ throws: new Error('provider down') }, { throws: new Error('provider down') }],
      () => line,
    )
    const roomId = await startRoom(t.w)
    await t.turns.say(as('ana'), roomId, '@keith one')
    await idle(t.turns, roomId)
    expect(keithLines(t.w, roomId).at(-1)?.text).toBe(templateToBody('butler').lines.answerFailed)

    line = templateToBody('friend').lines.answerFailed
    await t.turns.say(as('ana'), roomId, '@keith two')
    await idle(t.turns, roomId)
    expect(keithLines(t.w, roomId).at(-1)?.text).toBe(
      'Sorry, that did not work. Try me again in a moment.',
    )
  })

  test('without a persona the notice is the professional line', async () => {
    const t = setup([{ throws: new Error('provider down') }])
    const roomId = await startRoom(t.w)
    await t.turns.say(as('ana'), roomId, '@keith one')
    await idle(t.turns, roomId)
    expect(keithLines(t.w, roomId).at(-1)?.text).toBe(ANSWER_FAILED_NOTICE)
    expect(ANSWER_FAILED_NOTICE).toBe('I could not answer that just now.')
  })
})

describe('turns: a turn never parks', () => {
  test('a tool outside the room allowlist is denied at once: the turn completes with an answer', async () => {
    const t = setup([
      { toolCalls: [{ toolName: 'wipe_room', toolCallId: 'w1', input: {} }] },
      { text: 'I will not wipe the room.' },
    ])
    const roomId = await startRoom(t.w)
    await t.turns.say(as('ana'), roomId, '@keith wipe it')
    await idle(t.turns, roomId)
    expect(t.activities.at(-1)?.payload).toMatchObject({ speakerId: 'ana', stop: 'complete' })
    expect(keithLines(t.w, roomId).map((l) => l.text)).toEqual(['I will not wipe the room.'])
    expect(t.turns.busy(roomId)).toBe(false)
  })
})

describe('turns: generation rollover after an idle window', () => {
  const MINUTE = 60_000

  test('idle 31 minutes, then a message starts generation +1 whose context holds only the window block', async () => {
    const t = setup([{ text: 'first answer' }, { text: 'second answer' }])
    const roomId = await startRoom(t.w)
    await t.turns.say(as('ana'), roomId, '@keith first')
    await idle(t.turns, roomId)
    expect(t.w.rooms.get(roomId)?.generation).toBe(1)

    t.w.advance(31 * MINUTE)
    await t.turns.say(as('bob'), roomId, '@keith second')
    await idle(t.turns, roomId)

    expect(t.w.rooms.get(roomId)?.generation).toBe(2)
    expect(t.activities.at(-1)?.sessionId).toBe(roomSessionId(roomId, 2))
    // the second turn's model call: the reminder with the window (its own line only, the first one is 31 minutes old),
    // and no stored message of the first generation
    const prompt = t.model.prompts[1] ?? []
    const json = JSON.stringify(prompt)
    expect(json).toContain('Window: the last 30 minutes')
    expect(json).toContain('@keith second')
    expect(json).not.toContain('first answer')
    expect(prompt.filter((m) => m.role === 'assistant')).toEqual([])
    // the reminder is one user message; the only other one is the turn's own line
    const lines = prompt.filter(
      (m) => m.role === 'user' && !JSON.stringify(m).includes('Window: the last'),
    )
    expect(lines).toHaveLength(1)
  })

  test('a message within the window keeps the generation and the stored history of the turn before', async () => {
    const t = setup([{ text: 'first answer' }, { text: 'second answer' }])
    const roomId = await startRoom(t.w)
    await t.turns.say(as('ana'), roomId, '@keith first')
    await idle(t.turns, roomId)

    t.w.advance(10 * MINUTE)
    await t.turns.say(as('bob'), roomId, '@keith second')
    await idle(t.turns, roomId)

    expect(t.w.rooms.get(roomId)?.generation).toBe(1)
    expect(t.activities.at(-1)?.sessionId).toBe(roomSessionId(roomId, 1))
    expect(JSON.stringify(t.model.prompts[1])).toContain('first answer')
  })
})
