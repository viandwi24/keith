/**
 * P27.4.3: the isolation proof of presence (ADR-0020 §2, docs/specs/parietal.md "Isolation proof"). A member asks the
 * front agent about the owner and about another member, at each disclosure level. Per turn, the new messages of the
 * member's session and the new prompts of the front model (what the model was given) hold only the released line:
 * never a client id, a client label, a raw field name, or a note above the level. A worker never gets the tool.
 * Real core, scripted models, the owner and two members (`ana` asks, `ben` is asked about).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createKeithClient, type KeithClient } from '@keith/client'
import { cleanup, spawn, stop, tasksOf } from './testing/core-harness.ts'
import { issueOwnerToken } from './testing/owner-token.ts'
import { baseUrl, type Scenario, scenario } from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const NOTE_OWNER = 'board review on Friday'
const NOTE_BEN = 'dentist until noon'
const LABEL = 'vian-laptop-LABEL'
const HONEST = 'I can only tell you what they share.'
/** Raw field names of the presence record: never in a model context or in a member's messages (the chat's own metadata is not checked). */
const RAW_FIELDS = ['activeClient', 'reachableOn', 'lastSeenAt', 'lastActiveAt', 'firstSeenAt']

const configOf = (dataDir: string) => ({ dataDir, dbFile: `${dataDir}/keith.db` }) as never

/** A member with a live credential (no password hashing involved), as the P9 isolation test adds one. */
async function addMember(s: Scenario, username: string) {
  const person = await s.r.client.rpc.admin.people.add({ username })
  const token = await issueOwnerToken(configOf(s.dataDir), username, { personId: person.id })
  return {
    id: person.id,
    client: createKeithClient({ baseUrl: baseUrl(s.r), token }) as KeithClient,
  }
}

/** One scripted member turn that asks the presence tool, then answers honestly. */
const ask = (n: number, person: string) => [
  { toolCalls: [{ toolName: 'presence', toolCallId: `ask-${n}`, input: { person } }] },
  { text: HONEST },
]

describe('presence isolation for a member', () => {
  let s: Scenario
  let ana: Awaited<ReturnType<typeof addMember>>
  let ben: Awaited<ReturnType<typeof addMember>>
  const clientId = crypto.randomUUID()
  const anaSession = () => `front:${ana.id}`
  /** Message ids already seen in ana's session, so each turn reads only what it added. */
  const seen = new Set<string>()

  beforeAll(async () => {
    s = await scenario({
      front: [
        ...ask(1, 'owner'),
        ...ask(2, 'owner'),
        ...ask(3, 'owner'),
        ...ask(4, 'ben'),
        ...ask(5, 'ben'),
        ...ask(6, 'ben'),
        { toolCalls: [spawn('w1', 'look up the weather')] },
        { text: 'On it.' },
        { text: 'The worker reports: checked.' },
      ] as never,
      worker: [{ text: 'checked' }] as never,
    })
    ana = await addMember(s, 'ana')
    ben = await addMember(s, 'ben')
    // the owner has a client in use and a busy note; ben has a busy note of his own
    await s.r.client.rpc.presence.clients.register({
      id: clientId,
      kind: 'tui',
      label: LABEL,
      capabilities: ['chat'],
      version: '0.0.0',
    })
    await s.r.client.rpc.presence.clients.heartbeat({ id: clientId, active: true })
    await s.r.client.rpc.presence.setStatus({ busy: true, note: NOTE_OWNER, minutes: 60 })
    await ben.client.rpc.presence.setStatus({ busy: true, note: NOTE_BEN, minutes: 60 })
  })

  afterAll(async () => {
    await stop(s.r)
  })

  /** The new messages of ana's session since the last call (by message id). */
  const freshMessages = async (): Promise<string> => {
    const all = (await ana.client.harness.sessions.messages(anaSession(), { limit: 200 })).messages
    const fresh = all.filter((m) => !seen.has(m.id))
    for (const m of fresh) seen.add(m.id)
    return JSON.stringify(fresh)
  }

  /** The prompts the front model got during one turn (its context), as JSON. */
  const contextFrom = (before: number): string =>
    JSON.stringify((s.front.models.get('f')?.prompts ?? []).slice(before))

  const turnPrompts = (): number => s.front.models.get('f')?.prompts.length ?? 0

  /** Every raw field, the clients and their label, must be absent from what the member and the model see. */
  const expectNoRaw = (text: string) => {
    expect(text).not.toContain(clientId)
    expect(text).not.toContain(LABEL)
    for (const field of RAW_FIELDS) expect(text).not.toContain(field)
  }

  const askAs = async (text: string) => {
    const before = turnPrompts()
    for await (const _ of ana.client.reply(text, anaSession())) {
      // drain: the stream ends with the turn
    }
    return { context: contextFrom(before), messages: await freshMessages() }
  }

  test('the owner at level none: the tool answers that nothing is shared, and no note or raw field leaks', async () => {
    await s.r.client.rpc.presence.disclosure.set({ audience: '@users', level: 'none' })
    const turn = await askAs('is the owner free?')
    expect(turn.messages).toContain('"disclosed":false')
    expect(turn.context).toContain('"disclosed":false')
    expect(turn.messages).not.toContain(NOTE_OWNER)
    expect(turn.context).not.toContain(NOTE_OWNER)
    expectNoRaw(turn.messages)
    expectNoRaw(turn.context)
  })

  test('the owner at level state: busy or available only, no note, no raw field', async () => {
    await s.r.client.rpc.presence.disclosure.set({ audience: '@users', level: 'state' })
    const turn = await askAs('is the owner free now?')
    expect(turn.messages).toContain(' is busy.')
    expect(turn.context).toContain(' is busy.')
    expect(turn.messages).not.toContain(NOTE_OWNER)
    expect(turn.context).not.toContain(NOTE_OWNER)
    expectNoRaw(turn.messages)
    expectNoRaw(turn.context)
  })

  test('the owner at level detail: the note is released, and still no client id, label or raw field', async () => {
    await s.r.client.rpc.presence.disclosure.set({ audience: '@users', level: 'detail' })
    const turn = await askAs('what is the owner doing?')
    expect(turn.messages).toContain(NOTE_OWNER)
    expect(turn.context).toContain(NOTE_OWNER)
    expectNoRaw(turn.messages)
    expectNoRaw(turn.context)
  })

  test("another member at level none and state: the note of ben stays out of ana's context", async () => {
    await ben.client.rpc.presence.disclosure.set({ audience: '@users', level: 'none' })
    const none = await askAs('is Ben free?')
    expect(none.messages).toContain('"disclosed":false')
    expect(none.messages).not.toContain(NOTE_BEN)
    expect(none.context).not.toContain(NOTE_BEN)
    expectNoRaw(none.messages)

    await ben.client.rpc.presence.disclosure.set({ audience: '@users', level: 'state' })
    const state = await askAs('is Ben busy?')
    expect(state.messages).toContain(' is busy.')
    expect(state.messages).not.toContain(NOTE_BEN)
    expect(state.context).not.toContain(NOTE_BEN)
    expectNoRaw(state.messages)
    expectNoRaw(state.context)
  })

  test('another member at level detail: the note is released, no raw field', async () => {
    await ben.client.rpc.presence.disclosure.set({ audience: '@users', level: 'detail' })
    const turn = await askAs('what is Ben doing?')
    expect(turn.messages).toContain(NOTE_BEN)
    expectNoRaw(turn.messages)
    expectNoRaw(turn.context)
  })

  test('a worker never gets the presence tool; the front agent does', async () => {
    const front = s.front.models.get('f')?.calls ?? []
    const frontTools = front.flatMap((c) => (c.tools ?? []).map((t) => t.name))
    expect(frontTools).toContain('presence')

    const before = s.worker.models.get('w')?.calls.length ?? 0
    for await (const _ of ana.client.reply('look up the weather', anaSession())) {
      // drain
    }
    await until(
      'the worker is done',
      () => tasksOf(ana.client),
      (list) => list[0]?.status === 'done',
    )
    await until(
      'ana is idle',
      async () => !(await ana.client.harness.sessions.get(anaSession())).running,
    )
    const workerCalls = (s.worker.models.get('w')?.calls ?? []).slice(before)
    expect(workerCalls.length).toBeGreaterThan(0)
    for (const call of workerCalls) {
      expect((call.tools ?? []).map((t) => t.name)).not.toContain('presence')
    }
  }, 30_000)
})
