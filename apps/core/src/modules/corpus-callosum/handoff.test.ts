// The private handoff (P30.4.2): `room_handoff` sends the speaker's own request to the speaker's front session through the P25
// front route (a wake turn, the speaker as principal, the key `<roomId>:<seq>`); the room learns only "asked in their own chat";
// no other member's text ever reaches the speaker's chat; a non-member or a turn with no principal is refused.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DeliveryOutcome,
  type DeliveryRequestInput,
  DeliveryRequestSchema,
} from '@keith/contracts'
import type { HarnessAgent, HarnessContext, SessionLock } from 'eharness'
import { createFrontRoute } from '../delivery/index.ts'
import { as, roomWorld } from './fixtures.ts'
import {
  createRoomHandoff,
  createRoomTurnSeqs,
  HANDOFF_LINE,
  HANDOFF_REPLY,
  HANDOFF_REQUEST_MAX,
  type RoomTurnSeqs,
} from './handoff.ts'
import { createRoomTools, ROOM_HANDOFF_TOOL, SPEAKER_REFUSAL } from './tools.ts'
import { createTextTransport } from './transport-text.ts'

type Exec = { execute: (input: unknown, options: unknown) => Promise<unknown> }
const OPTIONS = { toolCallId: 't1', messages: [], abortSignal: new AbortController().signal }

/** What the front session received: the session id, the event and the inject options (principal, wake, key). */
interface Injected {
  sessionId: string
  name: string
  text: string
  wake: boolean | undefined
  principal: { id: string } | undefined
  key: string | undefined
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keith-room-handoff-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A room started by ana with bob invited and accepted, and a fixture world. The front sessions are a fake agent that records
 * each inject; the delivery is the real front route (`createFrontRoute`), so the wake, principal and key are the P25 ones.
 */
async function setup() {
  const w = roomWorld(dir)
  const started = await w.svc.start(as('ana'), { invite: ['bob'] })
  const roomId = started.room.id
  await w.svc.accept(as('bob'), roomId)
  const injected: Injected[] = []
  const agent = {
    session: (sessionId: string) => ({
      inject: async (
        _event: string,
        payload: { name: string; text: string },
        options: { wake?: boolean; principal?: { id: string }; key?: string },
      ) => {
        injected.push({
          sessionId,
          name: payload.name,
          text: payload.text,
          wake: options.wake,
          principal: options.principal,
          key: options.key,
        })
      },
    }),
  } as unknown as HarnessAgent
  const route = createFrontRoute({
    generations: { current: () => 0 },
    lead: () => agent,
    lock: {} as SessionLock,
    remainingUsd: () => null,
    warn: () => {},
  })
  const delivery = {
    deliver: async (input: DeliveryRequestInput): Promise<DeliveryOutcome> => {
      const request = DeliveryRequestSchema.parse(input)
      const sent = await route.send(request, { attempt: 1 })
      return sent.ok
        ? { status: 'delivered', route: 'front', attempts: 1 }
        : { status: 'failed', reason: sent.reason, attempts: 1 }
    },
  }
  const audit: { kind: string; actor: string; detail: Record<string, unknown> | undefined }[] = []
  const transport = createTextTransport({
    rooms: w.rooms,
    activity: { append: async () => ({}) } as never,
    now: w.now,
  })
  const turnSeqs: RoomTurnSeqs = createRoomTurnSeqs()
  const handoff = createRoomHandoff({
    rooms: w.rooms,
    delivery,
    transport,
    audit: {
      record: (event) => audit.push({ kind: event.kind, actor: event.actor, detail: event.detail }),
    },
  })
  const tools = createRoomTools({
    rooms: w.rooms,
    service: w.svc,
    presence: { disclosedFor: async () => ({ level: 'none', line: null }) },
    transport: {
      sayLine: async (roomId, from, text, data) =>
        w.rooms.appendEvent({
          roomId,
          at: w.now(),
          kind: from === 'keith' ? 'keith' : 'say',
          speaker: from,
          text,
          ...(data === undefined ? {} : { data }),
        }),
    },
    people: { get: async (ref) => ({ name: ref }) as never },
    handoff,
    turnSeqs,
    now: w.now,
  })
  /** Runs the room_handoff tool in a turn of `principal` on the room's session, the way the AI SDK does. */
  const callHandoff = async (ctx: HarnessContext, raw: unknown): Promise<unknown> => {
    const made = tools[ROOM_HANDOFF_TOOL]?.(ctx) as unknown as {
      inputSchema: { parse: (v: unknown) => unknown }
    } & Exec
    return made.execute(made.inputSchema.parse(raw), OPTIONS)
  }
  /** A turn of `principal` in the room, with `seq` as the line the turn answers. */
  const turn = (principal: string | undefined, seq: number): HarnessContext => {
    turnSeqs.set(roomId, seq)
    return {
      session: { id: `room:${roomId}:g0` },
      ...(principal === undefined ? {} : { principal: { id: principal } }),
    } as unknown as HarnessContext
  }
  /** The say row a turn answers: a line of `speaker` written now. */
  const say = (speaker: string, text: string): number =>
    w.rooms.appendEvent({ roomId, at: w.now(), kind: 'say', speaker, text })
  return { w, roomId, injected, audit, turnSeqs, callHandoff, turn, say }
}

describe('room_handoff: the front session', () => {
  test("receives exactly the speaker's request, as a wake turn of the speaker", async () => {
    const h = await setup()
    const name = h.w.rooms.get(h.roomId)?.name ?? ''
    const seq = h.say('ana', '@keith check my private note about the gift')
    const request = 'check my private note about the gift'

    const result = await h.callHandoff(h.turn('ana', seq), { request })

    expect(result).toEqual({ handed: true, answerInRoom: HANDOFF_REPLY })
    expect(h.injected).toHaveLength(1)
    const [got] = h.injected
    expect(got?.sessionId).toBe('front:ana')
    expect(got?.name).toBe('room-handoff')
    expect(got?.text).toBe(
      `From room "${name}": ${request}. Do it in this chat. When done, ask whether to share the result with the room.`,
    )
    expect(got?.wake).toBe(true)
    expect(got?.principal).toEqual({ id: 'ana' })
    expect(got?.key).toBe(`${h.roomId}:${seq}`)
  })

  test('a second call in the same turn (same seq) injects once and writes one room line and one audit row', async () => {
    const h = await setup()
    const seq = h.say('ana', '@keith remember my bank note')
    const ctx = h.turn('ana', seq)

    await h.callHandoff(ctx, { request: 'my bank note' })
    const again = await h.callHandoff(ctx, { request: 'my bank note' })

    expect(again).toEqual({ handed: true, answerInRoom: HANDOFF_REPLY })
    expect(h.injected).toHaveLength(1)
    const lines = h.w.rooms.window(h.roomId, h.w.now()).filter((e) => e.kind === 'handoff')
    expect(lines).toHaveLength(1)
    expect(h.audit.filter((a) => a.kind === 'room.handoff')).toHaveLength(1)
  })

  test('a later turn with a new seq is a new handoff', async () => {
    const h = await setup()
    const first = h.say('ana', '@keith note one')
    await h.callHandoff(h.turn('ana', first), { request: 'note one' })
    const second = h.say('ana', '@keith note two')
    await h.callHandoff(h.turn('ana', second), { request: 'note two' })

    expect(h.injected.map((i) => i.key)).toEqual([`${h.roomId}:${first}`, `${h.roomId}:${second}`])
  })
})

describe('room_handoff: other members and the room', () => {
  test("another member's text never goes into the speaker's chat", async () => {
    const h = await setup()
    h.say('bob', 'Bob: my private gift for Ana is a watch')
    const seq = h.say('ana', '@keith what is my bank PIN hint')

    await h.callHandoff(h.turn('ana', seq), { request: 'what is my bank PIN hint' })

    expect(h.injected.map((i) => i.sessionId)).toEqual(['front:ana'])
    const [got] = h.injected
    expect(got?.text).not.toContain('watch')
    expect(got?.text).not.toContain('gift')
    expect(got?.text).not.toContain('Bob')
  })

  test('the room transcript shows only "asked in their own chat", never the request', async () => {
    const h = await setup()
    const seq = h.say('ana', '@keith what is my bank PIN hint')
    await h.callHandoff(h.turn('ana', seq), { request: 'what is my bank PIN hint' })

    const events = h.w.rooms.window(h.roomId, h.w.now())
    const handoff = events.find((e) => e.kind === 'handoff')
    expect(handoff?.speaker).toBe('ana')
    expect(handoff?.text).toBe(HANDOFF_LINE)
    expect(HANDOFF_LINE).toBe('asked in their own chat')
    // the only line that names the request is the speaker's own say row, written before the handoff
    expect(JSON.stringify(events.filter((e) => e.kind !== 'say'))).not.toContain('PIN')
  })

  test('the audit row names the speaker and the room, never the request', async () => {
    const h = await setup()
    const seq = h.say('ana', '@keith what is my bank PIN hint')
    await h.callHandoff(h.turn('ana', seq), { request: 'what is my bank PIN hint' })

    expect(h.audit).toEqual([
      {
        kind: 'room.handoff',
        actor: 'ana',
        detail: { roomId: h.roomId, subject: 'ana' },
      },
    ])
    expect(JSON.stringify(h.audit)).not.toContain('PIN')
  })
})

describe('room_handoff: refusals', () => {
  test('a turn with no principal is refused and injects nothing', async () => {
    const h = await setup()
    const seq = h.say('ana', '@keith note')
    await expect(h.callHandoff(h.turn(undefined, seq), { request: 'note' })).rejects.toThrow(
      SPEAKER_REFUSAL,
    )
    expect(h.injected).toHaveLength(0)
    expect(h.w.rooms.window(h.roomId, h.w.now()).some((e) => e.kind === 'handoff')).toBe(false)
  })

  test('a person who is not in the room is refused and injects nothing', async () => {
    const h = await setup()
    const seq = h.say('ana', '@keith note')
    await expect(h.callHandoff(h.turn('dee', seq), { request: 'note' })).rejects.toThrow(
      SPEAKER_REFUSAL,
    )
    expect(h.injected).toHaveLength(0)
  })

  test('a person who is only invited (not active) is refused', async () => {
    const h = await setup()
    await h.w.svc.invite(as('ana'), h.roomId, ['cy'])
    const seq = h.say('ana', '@keith note')
    await expect(h.callHandoff(h.turn('cy', seq), { request: 'note' })).rejects.toThrow(
      SPEAKER_REFUSAL,
    )
    expect(h.injected).toHaveLength(0)
  })

  test('a request over the limit is refused by the tool schema', async () => {
    const h = await setup()
    const seq = h.say('ana', '@keith note')
    const tooLong = 'x'.repeat(HANDOFF_REQUEST_MAX + 1)
    await expect(h.callHandoff(h.turn('ana', seq), { request: tooLong })).rejects.toThrow()
    expect(h.injected).toHaveLength(0)
  })

  test('the tool takes no person parameter: a crafted person field is stripped', async () => {
    const h = await setup()
    const seq = h.say('ana', '@keith note')
    await h.callHandoff(h.turn('ana', seq), { request: 'note', person: 'bob' })
    expect(h.injected.map((i) => i.sessionId)).toEqual(['front:ana'])
  })
})

describe('room_handoff: the turn sequence', () => {
  test('a turn with no seq set refuses the handoff', async () => {
    const h = await setup()
    h.turnSeqs.clear(h.roomId)
    const ctx = {
      session: { id: `room:${h.roomId}:g0` },
      principal: { id: 'ana' },
    } as unknown as HarnessContext
    await expect(h.callHandoff(ctx, { request: 'note' })).rejects.toThrow('no turn')
    expect(h.injected).toHaveLength(0)
  })
})
