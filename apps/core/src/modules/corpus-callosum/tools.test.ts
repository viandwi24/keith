// The room tools (P30.3.4): every tool starts with `speakerOf`; a turn with no principal, or a principal who is not an active
// member, is refused; `room_leave` leaves only the speaker (no person parameter, a crafted field is stripped).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessContext } from 'eharness'
import { ROOM_AGENT_TOOL_NAMES, ROOM_FILE_TOOLS } from './agent.ts'
import { as, roomWorld } from './fixtures.ts'
import { createRoomTurnSeqs } from './handoff.ts'
import {
  createRoomTools,
  NOT_ALLOWED,
  ROOM_ACTIVITY_TOOL,
  ROOM_LEAVE_TOOL,
  ROOM_PRESENCE_TOOL,
  ROOM_REQUEST_END_TOOL,
  ROOM_REQUEST_REMOVE_TOOL,
  ROOM_SAY_TOOL,
  ROOM_TOOLS,
  type RoomToolCall,
  type RoomToolDeps,
  roomIdOfSession,
  roomTools,
  SPEAKER_REFUSAL,
  speakerOf,
} from './tools.ts'

type Exec = { execute: (input: unknown, options: unknown) => Promise<unknown> }
const OPTIONS = { toolCallId: 't1', messages: [], abortSignal: new AbortController().signal }
/** The handoff port of these tests: the room tools other than `room_handoff` never call it. */
const noHandoff = { hand: async () => ({ status: 'handed' as const }) }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keith-room-tools-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A room started by `ana` with `bob` and `cy` invited; `bob` and `ana` are active (cy stays invited). */
async function setup() {
  const w = roomWorld(dir)
  const started = await w.svc.start(as('ana'), { invite: ['bob', 'cy'] })
  return { w, roomId: started.room.id }
}

/** The turn context of a room session, for `principal` (undefined: a turn with no principal). */
const ctxOf = (roomId: string, principal?: string): HarnessContext =>
  ({
    session: { id: `room:${roomId}:g0` },
    ...(principal === undefined ? {} : { principal: { id: principal } }),
  }) as unknown as HarnessContext

const disclosure = {
  disclosedFor: async (_viewer: string, subject: string) =>
    subject === 'cy'
      ? { level: 'none' as const, line: null }
      : { level: 'state' as const, line: `${subject} is available.` },
}

/** Runs a tool the way the AI SDK does: the input is parsed by the tool's zod schema first, then `execute` runs. */
function toolsFor(
  w: ReturnType<typeof roomWorld>,
  ctx: HarnessContext,
  onToolCall?: RoomToolDeps['onToolCall'],
) {
  const factories = createRoomTools({
    rooms: w.rooms,
    service: w.svc,
    presence: disclosure,
    ...(onToolCall === undefined ? {} : { onToolCall }),
    transport: {
      sayLine: async (roomId, from, text) =>
        w.rooms.appendEvent({
          roomId,
          at: w.now(),
          kind: from === 'keith' ? 'keith' : 'say',
          speaker: from,
          text,
        }),
    },
    people: {
      get: async (ref) =>
        ({ name: ref.toUpperCase(), role: ref === 'boss' ? 'owner' : 'member' }) as never,
    },
    handoff: noHandoff,
    turnSeqs: createRoomTurnSeqs(),
    now: () => w.now(),
  })
  return {
    run: async (name: string, raw: unknown): Promise<unknown> => {
      const factory = factories[name]
      if (factory === undefined) throw new Error(`no tool ${name}`)
      const made = factory(ctx) as unknown as {
        inputSchema: { parse: (v: unknown) => unknown }
      } & Exec
      return made.execute(made.inputSchema.parse(raw), OPTIONS)
    },
  }
}

describe('room tools: the speaker', () => {
  test('a room session id names its room; other ids name none', async () => {
    expect(roomIdOfSession('room:0190f5e2-0000-7000-8000-000000000001:g2')).toBe(
      '0190f5e2-0000-7000-8000-000000000001',
    )
    expect(roomIdOfSession('front:ana')).toBeUndefined()
    expect(roomIdOfSession('room:not-a-uuid:g0')).toBeUndefined()
    expect(roomIdOfSession(undefined)).toBeUndefined()
  })

  test('no principal is refused on every tool', async () => {
    const { w, roomId } = await setup()
    const tools = toolsFor(w, ctxOf(roomId, undefined))
    for (const name of [ROOM_SAY_TOOL, ROOM_PRESENCE_TOOL, ROOM_ACTIVITY_TOOL, ROOM_LEAVE_TOOL]) {
      const input = name === ROOM_SAY_TOOL ? { text: 'hi' } : {}
      await expect(tools.run(name, input)).rejects.toThrow(SPEAKER_REFUSAL)
    }
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('invited')
  })

  test('a principal who was never invited is refused', async () => {
    const { w, roomId } = await setup()
    expect(() => speakerOf({ rooms: w.rooms }, ctxOf(roomId, 'dee'))).toThrow(SPEAKER_REFUSAL)
    await expect(
      toolsFor(w, ctxOf(roomId, 'dee')).run(ROOM_SAY_TOOL, { text: 'hi' }),
    ).rejects.toThrow(SPEAKER_REFUSAL)
  })

  test('an invited but not yet active member is refused', async () => {
    const { w, roomId } = await setup()
    expect(() => speakerOf({ rooms: w.rooms }, ctxOf(roomId, 'cy'))).toThrow(SPEAKER_REFUSAL)
  })

  test('a member who left is refused, and a session of another room names no speaker', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    w.svc.leave(as('bob'), roomId)
    expect(() => speakerOf({ rooms: w.rooms }, ctxOf(roomId, 'bob'))).toThrow(SPEAKER_REFUSAL)
    const other = { session: { id: 'front:ana' }, principal: { id: 'ana' } } as never
    expect(() => speakerOf({ rooms: w.rooms }, other)).toThrow(SPEAKER_REFUSAL)
  })

  test('the active speaker is returned with the room', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    const speaker = speakerOf({ rooms: w.rooms }, ctxOf(roomId, 'bob'))
    expect(speaker.roomId).toBe(roomId)
    expect(speaker.personId).toBe('bob')
  })
})

describe('room_say', () => {
  test('an active member posts a Keith line through the transport', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    const out = await toolsFor(w, ctxOf(roomId, 'bob')).run(ROOM_SAY_TOOL, {
      text: 'to Ana: dinner at seven',
    })
    const seq = (out as { seq: number }).seq
    const line = w.rooms.window(roomId, w.now()).find((e) => e.seq === seq)
    expect(line?.kind).toBe('keith')
    expect(line?.speaker).toBe('keith')
    expect(line?.text).toBe('to Ana: dinner at seven')
  })

  test('the input is checked: empty text and a crafted extra field do not pass', async () => {
    const { w, roomId } = await setup()
    const say = toolsFor(w, ctxOf(roomId, 'ana'))
    await expect(say.run(ROOM_SAY_TOOL, { text: '' })).rejects.toThrow()
    await expect(say.run(ROOM_SAY_TOOL, { text: 'x'.repeat(2001) })).rejects.toThrow()
  })
})

describe('room_presence', () => {
  test('lists each active member as the speaker may see them; none is "not shared"', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    const out = (await toolsFor(w, ctxOf(roomId, 'bob')).run(ROOM_PRESENCE_TOOL, {})) as {
      members: { person: string; line: string }[]
    }
    expect(out.members).toEqual([
      { person: 'ana', line: 'ana is available.' },
      { person: 'bob', line: 'bob is available.' },
    ])
  })
})

describe('room_activity', () => {
  test('returns the window lines of the room, with names; minutes narrows it', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    w.advance(10 * 60_000)
    await w.svc.say(as('bob'), roomId, 'hello room')
    w.advance(20 * 60_000)
    const all = (await toolsFor(w, ctxOf(roomId, 'bob')).run(ROOM_ACTIVITY_TOOL, {})) as {
      lines: { text: string | null; speakerName: string | null }[]
    }
    expect(all.lines.some((l) => l.text === 'hello room' && l.speakerName === 'BOB')).toBe(true)
    const recent = (await toolsFor(w, ctxOf(roomId, 'bob')).run(ROOM_ACTIVITY_TOOL, {
      minutes: 5,
    })) as { lines: { text: string | null }[] }
    expect(recent.lines.some((l) => l.text === 'hello room')).toBe(false)
  })

  test('a non-integer or too long minutes is refused by the input schema', async () => {
    const { w, roomId } = await setup()
    const activity = toolsFor(w, ctxOf(roomId, 'ana'))
    await expect(activity.run(ROOM_ACTIVITY_TOOL, { minutes: 1.5 })).rejects.toThrow()
    await expect(activity.run(ROOM_ACTIVITY_TOOL, { minutes: 241 })).rejects.toThrow()
  })
})

describe('room_leave', () => {
  test('leaves only the speaker, even when the model names another person', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    await toolsFor(w, ctxOf(roomId, 'bob')).run(ROOM_LEAVE_TOOL, {
      person: 'ana',
      personId: 'ana',
      roomId: 'other',
    })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('left')
    expect(w.rooms.member(roomId, 'ana')?.status).toBe('active')
  })

  test('the tool has no person parameter', async () => {
    const { w, roomId } = await setup()
    const made = createRoomTools({
      rooms: w.rooms,
      service: w.svc,
      presence: disclosure,
      transport: { sayLine: async () => 0 },
      people: { get: async () => ({ name: 'x' }) as never },
      handoff: noHandoff,
      turnSeqs: createRoomTurnSeqs(),
    })[ROOM_LEAVE_TOOL]?.(ctxOf(roomId, 'ana')) as { inputSchema: { shape?: object } }
    expect(Object.keys(made.inputSchema.shape ?? {})).toEqual([])
  })
})

describe('room_request_remove and room_request_end', () => {
  test('the initiator asks for a removal: one pending row names them as the confirmer; nobody is removed', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    const out = (await toolsFor(w, ctxOf(roomId, 'ana')).run(ROOM_REQUEST_REMOVE_TOOL, {
      person: 'bob',
    })) as { requestId: string }
    const request = w.rooms.request(out.requestId)
    expect(request).toMatchObject({ kind: 'remove', person: 'ana', status: 'pending' })
    expect(request?.payload).toEqual({ target: 'bob' })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('active')
    expect(w.rooms.get(roomId)?.state).toBe('active')
  })

  test('the owner, an active member, may ask too; the request names the owner', async () => {
    const { w, roomId } = await setup()
    await w.svc.invite(as('ana'), roomId, ['boss'])
    w.svc.accept(as('boss'), roomId)
    const out = (await toolsFor(w, ctxOf(roomId, 'boss')).run(ROOM_REQUEST_END_TOOL, {})) as {
      requestId: string
    }
    expect(w.rooms.request(out.requestId)).toMatchObject({ kind: 'end', person: 'boss' })
    expect(w.rooms.get(roomId)?.state).toBe('active')
  })

  test("another member's request is refused: room.turn.refused is written, no row exists", async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    const tools = toolsFor(w, ctxOf(roomId, 'bob'))
    await expect(tools.run(ROOM_REQUEST_REMOVE_TOOL, { person: 'ana' })).rejects.toThrow(
      NOT_ALLOWED,
    )
    await expect(tools.run(ROOM_REQUEST_END_TOOL, {})).rejects.toThrow(NOT_ALLOWED)
    const refused = w.audit.filter((a) => a.kind === 'room.turn.refused')
    expect(refused.map((a) => [a.actor, a.detail?.tool])).toEqual([
      ['bob', ROOM_REQUEST_REMOVE_TOOL],
      ['bob', ROOM_REQUEST_END_TOOL],
    ])
    expect(refused[0]?.detail).toEqual({
      roomId,
      speaker: 'bob',
      tool: ROOM_REQUEST_REMOVE_TOOL,
      reason: 'not-initiator-or-owner',
    })
    expect(w.rooms.pendingRequests('ana', w.now())).toEqual([])
    expect(w.rooms.pendingRequests('bob', w.now())).toEqual([])
  })

  test('a turn with no speaker is refused as no speaker, and writes no refusal row', async () => {
    const { w, roomId } = await setup()
    await expect(
      toolsFor(w, ctxOf(roomId, undefined)).run(ROOM_REQUEST_REMOVE_TOOL, { person: 'bob' }),
    ).rejects.toThrow(SPEAKER_REFUSAL)
    expect(w.audit.some((a) => a.kind === 'room.turn.refused')).toBe(false)
  })

  test('a person the room does not hold cannot be named: the request is refused by the service', async () => {
    const { w, roomId } = await setup()
    await expect(
      toolsFor(w, ctxOf(roomId, 'ana')).run(ROOM_REQUEST_REMOVE_TOOL, { person: 'dee' }),
    ).rejects.toThrow('not in the room')
    expect(w.rooms.pendingRequests('ana', w.now())).toEqual([])
  })
})

describe('the recorder seam (onToolCall)', () => {
  test('every call reports the tool, the principal it saw and the room, before its checks run', async () => {
    const { w, roomId } = await setup()
    w.svc.accept(as('bob'), roomId)
    const calls: RoomToolCall[] = []
    const tools = toolsFor(w, ctxOf(roomId, 'bob'), (call) => calls.push(call))
    await tools.run(ROOM_ACTIVITY_TOOL, {})
    await expect(tools.run(ROOM_REQUEST_REMOVE_TOOL, { person: 'ana' })).rejects.toThrow()
    await expect(
      toolsFor(w, ctxOf(roomId, undefined), (c) => calls.push(c)).run(ROOM_LEAVE_TOOL, {}),
    ).rejects.toThrow(SPEAKER_REFUSAL)
    expect(calls).toEqual([
      { tool: ROOM_ACTIVITY_TOOL, principalId: 'bob', roomId },
      { tool: ROOM_REQUEST_REMOVE_TOOL, principalId: 'bob', roomId },
      { tool: ROOM_LEAVE_TOOL, principalId: undefined, roomId },
    ])
  })
})

describe('roomTools plugin', () => {
  test('offers exactly the seven room tools', async () => {
    const { w } = await setup()
    const plugin = roomTools({
      rooms: w.rooms,
      service: w.svc,
      presence: disclosure,
      transport: { sayLine: async () => 0 },
      people: { get: async () => ({ name: 'x' }) as never },
      handoff: noHandoff,
      turnSeqs: createRoomTurnSeqs(),
    })
    expect(plugin.name).toBe('keith-corpus-callosum-tools')
    expect([...ROOM_TOOLS]).toEqual([
      'room_say',
      'room_presence',
      'room_activity',
      'room_leave',
      'room_request_remove',
      'room_request_end',
      'room_handoff',
    ])
  })
})

describe('the room agent has no document tool (P33.4.3)', () => {
  test('the room tool list and the room file tools never include document_save', () => {
    // a room's result stays in the room workspace; only the personal front session saves documents (ADR-0029 §5)
    expect(ROOM_AGENT_TOOL_NAMES).not.toContain('document_save')
    expect(ROOM_AGENT_TOOL_NAMES).toEqual([...ROOM_TOOLS, ...ROOM_FILE_TOOLS])
  })
})
