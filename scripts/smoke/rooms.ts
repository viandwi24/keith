/**
 * P30.5.5 steps of the smoke test (docs/plans/active/P30-shared-rooms.md, phase 5): a shared room between the owner and ana.
 * The owner starts it with ana (`rooms.start` by username), ana accepts, both talk, `@keith` lines get the fake provider's
 * answer (the room agent sees no "run" word, so the scripted answer is the plain greeting). A private note ana wrote never
 * reaches the room transcript or the owner's activity feed. The owner ends the room; ana still reads the transcript. A second
 * room between ana (granted `rooms.start`) and rhea, which the owner is not in: the owner's read of it writes `room.read` and
 * `acl.owner-access`, and ana sees both lines in `audit.mine`.
 *
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. Passwords and PINs are built at runtime, and
 * a password never contains its username (AGENTS.md). Runs before the succession block (succession): the owner acts here, and succession
 * makes ana the owner.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './proc.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface RoomsContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  adminStdin(stdin: string, ...args: string[]): Promise<Ran>
  tmp: string
  coreUrl: string
  output(): string
}

interface RoomEventDto {
  seq: number
  kind: string
  speaker: { id: string; name: string } | null
  text: string | null
}

/** The fake provider's greeting (`scripts/smoke/fake-provider.ts`): a message without "run" gets it. */
const KEITH_ANSWER = 'Hello from the fake provider.'

export async function roomsSteps(c: RoomsContext): Promise<void> {
  const { coreUrl } = c
  const json = { 'content-type': 'application/json' }
  const rpc = (credential: string, path: string, input: unknown = null) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, ...json },
      body: JSON.stringify({ json: input }),
    })
  const rpcJson = async <T>(
    credential: string,
    path: string,
    input: unknown = null,
  ): Promise<T> => {
    const res = await rpc(credential, path, input)
    const body = await res.text()
    assert(res.status === 200, `${path} answered ${res.status}: ${body}`)
    return (JSON.parse(body) as { json: T }).json
  }
  const eventsOf = async (credential: string, roomId: string): Promise<RoomEventDto[]> =>
    (await rpcJson<{ events: RoomEventDto[] }>(credential, 'rooms/events', { roomId, limit: 200 }))
      .events
  const keithAnswers = (events: RoomEventDto[]) =>
    events.filter((e) => e.kind === 'keith' && e.text?.includes(KEITH_ANSWER) === true).length
  const memberCredential = (name: string): string => {
    const file = join(c.tmp, `${name}-client.json`)
    const token = (JSON.parse(readFileSync(file, 'utf8')) as { token?: string }).token ?? ''
    assert(token.startsWith('keith_s_'), `${name} has no keith_s_ credential`)
    return token
  }
  const ana = memberCredential('ana')
  // the person ids are not usernames: ana's id is read from her own whoami
  let anaId = ''
  const sentinel = `rooms-private-${crypto.randomUUID()}`
  let owner = ''
  let roomId = ''
  let roomTwo = ''

  await c.step('rooms start: the owner starts a room with ana, ana accepts', async () => {
    anaId = (await rpcJson<{ personId: string }>(ana, 'auth/whoami')).personId
    assert(anaId !== '' && anaId !== 'owner', `unexpected ana id ${anaId}`)
    owner =
      /(keith_s_\S+)/.exec(
        await c.ok(c.admin('token', 'create', '--label', 'rooms'), 'token create'),
      )?.[1] ?? ''
    assert(owner !== '', 'no owner credential')
    const started = await rpcJson<{
      room: { id: string; state: string }
      members: Array<{ person: { id: string }; status: string }>
    }>(owner, 'rooms/start', { invite: ['ana'], name: 'rooms room' })
    roomId = started.room.id
    assert(roomId !== '', 'rooms.start gave no room id')
    assert(
      started.members.some((m) => m.person.id === anaId && m.status === 'invited'),
      `ana is not invited: ${JSON.stringify(started.members)}`,
    )
    await rpcJson(ana, 'rooms/accept', { roomId })
    const view = await rpcJson<{
      members: Array<{ person: { id: string }; status: string }>
      you: { canControl: boolean }
    }>(owner, 'rooms/get', { roomId })
    assert(
      view.members.some((m) => m.person.id === anaId && m.status === 'active'),
      `ana did not become active: ${JSON.stringify(view.members)}`,
    )
    assert(view.you.canControl === true, 'the initiator cannot control the room')
  })

  await c.step(
    'rooms private: ana plants a private note that the room must never show',
    async () => {
      const made = await fetch(`${coreUrl}/plugins/notes/create`, {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${ana}` },
        body: JSON.stringify({ title: 'rooms note', body: sentinel }),
      })
      assert(made.status === 200, `ana notes/create answered ${made.status}`)
    },
  )

  await c.step('rooms talk: both speak, each @keith line gets the scripted answer', async () => {
    const said = await rpcJson<{ addressed: boolean; queued: boolean }>(ana, 'rooms/say', {
      roomId,
      text: '@keith hello room',
    })
    assert(said.addressed === true, `ana's @keith line was not addressed: ${JSON.stringify(said)}`)
    await until(
      async () => keithAnswers(await eventsOf(ana, roomId)) >= 1,
      25_000,
      "Keith's first room answer",
      c.output,
    )
    await rpcJson(owner, 'rooms/say', { roomId, text: 'hello ana' })
    const again = await rpcJson<{ addressed: boolean }>(owner, 'rooms/say', {
      roomId,
      text: '@keith hello from the owner',
    })
    assert(again.addressed === true, 'the owner @keith line was not addressed')
    await until(
      async () => keithAnswers(await eventsOf(owner, roomId)) >= 2,
      25_000,
      "Keith's second room answer",
      c.output,
    )
    const events = await eventsOf(ana, roomId)
    assert(
      events.some((e) => e.kind === 'say' && e.speaker?.id === 'owner' && e.text === 'hello ana'),
      'the owner plain line is not in the transcript',
    )
    assert(
      events.some((e) => e.kind === 'say' && e.speaker?.id === anaId),
      "ana's line is not in the transcript",
    )
  })

  await c.step(
    'rooms leak: the private note is in neither the transcript nor the owner feed',
    async () => {
      const events = await eventsOf(owner, roomId)
      assert(
        !JSON.stringify(events).includes(sentinel),
        'the private note of ana appears in the room transcript',
      )
      // the feed pages oldest first and earlier blocks left more than one page: read the whole log, page by page
      let after = 0
      let feedBody = ''
      for (let page = 0; page < 100; page++) {
        const res = await fetch(`${coreUrl}/activity?after=${after}&limit=500`, {
          headers: { authorization: `Bearer ${owner}` },
        })
        assert(res.status === 200, `the owner's feed answered ${res.status}`)
        const body = (await res.json()) as { events: unknown[]; lastSeq: number }
        feedBody += JSON.stringify(body.events)
        if (body.events.length < 500) break
        after = body.lastSeq
      }
      assert(!feedBody.includes(sentinel), "the private note of ana appears in the owner's feed")
      assert(
        feedBody.includes('room.event') && feedBody.includes(roomId),
        "the owner's feed holds no room.event of this room (the check would be empty)",
      )
    },
  )

  await c.step('rooms end: the owner ends the room, ana still reads the transcript', async () => {
    await rpcJson(owner, 'rooms/end', { roomId, reason: 'rooms done' })
    const view = await rpcJson<{ room: { state: string } }>(ana, 'rooms/get', { roomId })
    assert(view.room.state === 'ended', `the room is ${view.room.state}, expected ended`)
    const events = await eventsOf(ana, roomId)
    assert(
      events.some((e) => e.kind === 'end'),
      'the end of the room is not in the transcript ana reads',
    )
    assert(keithAnswers(events) >= 2, `ana reads ${keithAnswers(events)} Keith answers, expected 2`)
  })

  await c.step(
    'rooms read: the owner reads a room she is not in; ana sees the audit lines',
    async () => {
      // a second room between two members: ana holds `rooms.start` by a grant, rhea (identity-access's member) is the other one.
      // Password login is refused from loopback after identity-access's policy change, so rhea's saved credential is used.
      await c.ok(c.admin('people', 'grant', 'ana', 'rooms.start'), 'people grant ana rooms.start')
      const rheaToken = memberCredential('rhea')
      const started = await rpcJson<{ room: { id: string } }>(ana, 'rooms/start', {
        invite: ['rhea'],
        name: 'rooms second room',
      })
      roomTwo = started.room.id
      await rpcJson(rheaToken, 'rooms/accept', { roomId: roomTwo })
      await rpcJson(ana, 'rooms/say', { roomId: roomTwo, text: 'hello rhea' })

      // the owner is in neither member's room: the read is the audited owner path
      const read = await eventsOf(owner, roomTwo)
      assert(
        read.some((e) => e.text === 'hello rhea'),
        "the owner's read misses the room's line",
      )

      const mine = await fetch(`${coreUrl}/rpc/admin/audit/mine`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ana}`, ...json },
        body: JSON.stringify({ json: { limit: 200 } }),
      })
      assert(mine.status === 200, `audit.mine answered ${mine.status}`)
      const kinds = ((await mine.json()) as { json: Array<{ kind: string; summary: string }> }).json
      assert(
        kinds.some((row) => row.kind === 'room.read'),
        `ana's audit.mine has no room.read line:\n${JSON.stringify(kinds)}`,
      )
      assert(
        kinds.some((row) => row.kind === 'acl.owner-access'),
        `ana's audit.mine has no acl.owner-access line:\n${JSON.stringify(kinds)}`,
      )
      const everything = JSON.stringify(kinds)
      assert(!everything.includes(sentinel), 'the private note leaked into audit.mine')
    },
  )
}
