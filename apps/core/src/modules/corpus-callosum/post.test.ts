// The `room_post` tool and its confirmation (P30.4.3, docs/specs/corpus-callosum.md "Private requests and results"): the tool never
// posts by itself; the person's own confirmation posts the exact text once, with the person as speaker; another person's
// confirmation is refused; a person with no active room gets no tool and cannot create a post request.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessContext } from 'eharness'
import { resolvePlugin } from 'eharness/testing'
import { as, refusal, roomWorld } from './fixtures.ts'
import {
  createRoomPostPlugin,
  POST_PENDING_MESSAGE,
  ROOM_POST_PLUGIN,
  ROOM_POST_TOOL,
  RoomPostInput,
  roomPostToolOf,
} from './post.ts'
import { RoomError } from './service.ts'

type Exec = { execute: (input: unknown, options: unknown) => Promise<unknown> }
type StepOutput = { activeTools?: string[]; reminder?: string } | undefined
const OPTIONS = { toolCallId: 't1', messages: [], abortSignal: new AbortController().signal }
const TEXT = 'Ana, the plan is:\n<b>blue door</b> [keep it] & check the watch'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keith-room-post-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Ana starts a room with Bob invited and Bob accepts: Ana and Bob are active. Dee is in no room. */
function setup() {
  const w = roomWorld(dir)
  return w.svc.start(as('ana'), { invite: ['bob'] }).then(({ room }) => {
    w.svc.accept(as('bob'), room.id)
    return { w, roomId: room.id }
  })
}

/** The turn context of a front session, for `principal` (undefined: a turn with no principal). */
const ctxOf = (principal?: string): HarnessContext =>
  ({
    session: { id: `front:${principal ?? 'none'}` },
    ...(principal === undefined ? {} : { principal: { id: principal } }),
  }) as unknown as HarnessContext

/** The tool of one turn, as the agent sees it. */
const toolFor = (w: ReturnType<typeof roomWorld>, principal?: string) =>
  roomPostToolOf({ rooms: w.rooms, service: w.svc })(ctxOf(principal)) as unknown as Exec

/** Runs the tool the way the AI SDK does: the input is parsed by the schema first. */
const callTool = (
  w: ReturnType<typeof roomWorld>,
  principal: string | undefined,
  roomId: string,
  text: string,
) => toolFor(w, principal).execute(RoomPostInput.parse({ roomId, text }), OPTIONS)

/** The step hook of the plugin, run by `resolvePlugin` with the turn context `ctx`. */
const stepHook = async (
  w: ReturnType<typeof roomWorld>,
  ctx: HarnessContext,
  e: { toolNames: string[] },
): Promise<StepOutput> => {
  const resolved = await resolvePlugin(createRoomPostPlugin({ rooms: w.rooms, service: w.svc }))
  expect(resolved.name).toBe(ROOM_POST_PLUGIN)
  return resolved.runHook('step.prepare', e as never, ctx as never) as Promise<StepOutput>
}

/** The `post` lines of a room, oldest first. */
const postsOf = (w: ReturnType<typeof roomWorld>, roomId: string) =>
  w.rooms.window(roomId, w.now()).filter((event) => event.kind === 'post')

describe('room_post: offered only while the person is active in a room', () => {
  test('an active member is offered the tool, and the reminder names the room id', async () => {
    const { w, roomId } = await setup()
    const out = await stepHook(w, ctxOf('bob'), { toolNames: [ROOM_POST_TOOL, 'presence'] })
    expect(out?.activeTools).toBeUndefined()
    expect(out?.reminder).toContain(roomId)
  })

  test('a person with no active room does not get the tool in the step', async () => {
    const { w } = await setup()
    const out = await stepHook(w, ctxOf('dee'), { toolNames: [ROOM_POST_TOOL, 'presence'] })
    expect(out?.activeTools).toEqual(['presence'])
    expect(out?.reminder).toBeUndefined()
  })

  test('a turn with no principal does not get the tool', async () => {
    const { w } = await setup()
    const out = await stepHook(w, ctxOf(), { toolNames: [ROOM_POST_TOOL, 'presence'] })
    expect(out?.activeTools).toEqual(['presence'])
  })

  test('a person whose room has ended no longer gets the tool', async () => {
    const { w, roomId } = await setup()
    await w.svc.end(as('ana'), roomId)
    const out = await stepHook(w, ctxOf('ana'), { toolNames: [ROOM_POST_TOOL, 'presence'] })
    expect(out?.activeTools).toEqual(['presence'])
  })
})

describe('room_post: the tool never posts by itself', () => {
  test('a call writes one pending post request for the person and no transcript line', async () => {
    const { w, roomId } = await setup()
    const answer = await callTool(w, 'ana', roomId, TEXT)
    expect(answer).toEqual({ ok: true, status: 'pending', message: POST_PENDING_MESSAGE })

    const pending = w.rooms.pendingRequests('ana', w.now())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.kind).toBe('post')
    expect(pending[0]?.person).toBe('ana')
    expect(pending[0]?.roomId).toBe(roomId)
    expect(pending[0]?.payload).toEqual({ text: TEXT })
    expect(postsOf(w, roomId)).toHaveLength(0)
  })

  test('the input schema keeps the text exact: empty and over 2000 characters are refused', () => {
    expect(RoomPostInput.safeParse({ roomId: 'r', text: '' }).success).toBe(false)
    expect(RoomPostInput.safeParse({ roomId: 'r', text: 'x'.repeat(2001) }).success).toBe(false)
    expect(RoomPostInput.safeParse({ roomId: 'r', text: 'x'.repeat(2000) }).success).toBe(true)
  })

  test('a turn with no principal is refused and creates no request', async () => {
    const { w, roomId } = await setup()
    const answer = await callTool(w, undefined, roomId, TEXT)
    expect(answer).toMatchObject({ ok: false, reason: 'no-person' })
    expect(w.rooms.pendingRequests('ana', w.now())).toHaveLength(0)
  })
})

describe('room_post: confirmation by the person', () => {
  test('the person confirms once: the exact text posts once, with the person as speaker', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')

    expect(await w.svc.confirm(request.id, as('ana'), true)).toEqual({ status: 'confirmed' })

    const posts = postsOf(w, roomId)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.speaker).toBe('ana')
    expect(posts[0]?.text).toBe(TEXT)
    expect(w.rooms.request(request.id)?.status).toBe('confirmed')
  })

  test('a replay of the confirmed request is CONFLICT and posts nothing more', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')
    await w.svc.confirm(request.id, as('ana'), true)

    const error = await refusal(() => w.svc.confirm(request.id, as('ana'), true))
    expect(error).toBeInstanceOf(RoomError)
    expect((error as RoomError).code).toBe('CONFLICT')
    expect(postsOf(w, roomId)).toHaveLength(1)
  })

  test('the post is audited as room.post with no text', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')
    await w.svc.confirm(request.id, as('ana'), true)

    const rows = w.audit.filter((row) => row.kind === 'room.post')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor).toBe('ana')
    expect(JSON.stringify(rows[0]?.detail)).not.toContain('blue door')
  })

  test('a refusal by the person changes nothing and posts nothing', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')

    expect(await w.svc.confirm(request.id, as('ana'), false)).toEqual({ status: 'refused' })
    expect(postsOf(w, roomId)).toHaveLength(0)
  })

  test('an unconfirmed post expires after 10 minutes and posts nothing', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')

    w.advance(10 * 60_000 + 1)
    const error = await refusal(() => w.svc.confirm(request.id, as('ana'), true))
    expect((error as RoomError).code).toBe('PRECONDITION_FAILED')
    expect(postsOf(w, roomId)).toHaveLength(0)
  })
})

describe('room_post: confirmation by someone else is refused', () => {
  test('another member cannot confirm the request; the person still can, once', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')

    const error = await refusal(() => w.svc.confirm(request.id, as('bob'), true))
    expect(error).toBeInstanceOf(RoomError)
    expect((error as RoomError).code).toBe('FORBIDDEN')
    expect((error as RoomError).reason).toBe('not-initiator')
    expect(w.rooms.request(request.id)?.status).toBe('pending')
    expect(postsOf(w, roomId)).toHaveLength(0)

    await w.svc.confirm(request.id, as('ana'), true)
    expect(postsOf(w, roomId).map((event) => event.speaker)).toEqual(['ana'])
  })

  test('the owner cannot confirm a post, even though the owner may confirm a remove or an end', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')

    const error = await refusal(() => w.svc.confirm(request.id, as('boss'), true))
    expect((error as RoomError).code).toBe('FORBIDDEN')
    expect((error as RoomError).reason).toBe('not-member')
    expect(w.rooms.request(request.id)?.status).toBe('pending')
    expect(postsOf(w, roomId)).toHaveLength(0)
  })

  test('a refusal by someone else changes nothing', async () => {
    const { w, roomId } = await setup()
    await callTool(w, 'ana', roomId, TEXT)
    const [request] = w.rooms.pendingRequests('ana', w.now())
    if (request === undefined) throw new Error('no request')

    const error = await refusal(() => w.svc.confirm(request.id, as('bob'), false))
    expect((error as RoomError).code).toBe('FORBIDDEN')
    expect(w.rooms.request(request.id)?.status).toBe('pending')
  })
})

describe('room_post: a person with no active room cannot create a post request', () => {
  test('the service refuses a post request from a person outside the room', async () => {
    const { w, roomId } = await setup()
    const error = await refusal(() => w.svc.requestPost(as('dee'), roomId, TEXT))
    expect(error).toBeInstanceOf(RoomError)
    expect((error as RoomError).code).toBe('FORBIDDEN')
    expect((error as RoomError).reason).toBe('not-member')
    expect(w.rooms.pendingRequests('dee', w.now())).toHaveLength(0)
  })

  test('the tool answers a refusal for a person outside the room, and writes no request', async () => {
    const { w, roomId } = await setup()
    const answer = await callTool(w, 'dee', roomId, TEXT)
    expect(answer).toMatchObject({ ok: false, reason: 'not-member' })
    expect(w.rooms.pendingRequests('dee', w.now())).toHaveLength(0)
  })

  test('a room that has ended takes no post request', async () => {
    const { w, roomId } = await setup()
    await w.svc.end(as('ana'), roomId)
    const error = await refusal(() => w.svc.requestPost(as('ana'), roomId, TEXT))
    expect((error as RoomError).code).toBe('PRECONDITION_FAILED')
  })
})
