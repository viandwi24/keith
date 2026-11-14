/**
 * P36 audit F16 (docs/specs/activity-logs.md "What each agent adds"): a worker turn, a room turn and a guest turn each leave their
 * session and one model call in the activity logs, with the registered kind, the owner rule and no personal data of the wrong
 * person. Real core, scripted models; one core per scenario.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { openDatabase } from '@keith/db'
import { cleanup, tasksOf } from './testing/core-harness.ts'
import { ask, scenario } from './testing/scenario-harness.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

interface SessionRow {
  id: string
  kind: string
  person_id: string | null
  room_id: string | null
  app: string
}
interface CallRow {
  session_id: string
  call_kind: string
  trigger: string
  status: string
  speaker_id: string | null
}

/** The session rows and call rows of a core's database, read after the activity queue is flushed. */
async function logsOf(
  r: { core: { activity: { flush(): Promise<void> } } },
  dataDir: string,
): Promise<{ sessions: SessionRow[]; calls: CallRow[] }> {
  await r.core.activity.flush()
  const sqlite = openDatabase(`${dataDir}/keith.db`)
  try {
    return {
      sessions: sqlite
        .query('SELECT id, kind, person_id, room_id, app FROM llm_sessions')
        .all() as SessionRow[],
      calls: sqlite
        .query('SELECT session_id, call_kind, trigger, status, speaker_id FROM llm_calls')
        .all() as CallRow[],
    }
  } finally {
    sqlite.close()
  }
}

describe('activity logs: every kind of agent is recorded', () => {
  test('a worker turn is a task session of its person, with its parent front session', async () => {
    const s = await scenario({ worker: [{ text: 'Report: all good.' }] as never })
    await ask(s.r, 'check the machine')
    await until(
      'the task is done',
      () => tasksOf(s.r.client),
      (list) => list[0]?.status === 'done',
    )
    const { sessions, calls } = await logsOf(s.r, s.dataDir)
    const worker = sessions.find((x) => x.kind === 'task')
    expect(worker).toMatchObject({
      id: 'front:owner:agent:c1',
      person_id: 'owner',
      room_id: null,
      app: 'Worker',
    })
    const workerCalls = calls.filter((c) => c.session_id === worker?.id)
    expect(workerCalls.length).toBeGreaterThanOrEqual(1)
    expect(workerCalls[0]).toMatchObject({ call_kind: 'step', status: 'ok', speaker_id: null })
  })

  test('a room turn is a room session with the room and the speaker, and no person', async () => {
    const s = await scenario({
      pricing: { input: 1, output: 4 },
      front: [{ text: 'room reply' }] as never,
    })
    await s.r.client.rpc.admin.people.add({ username: 'ana' })
    const room = await s.r.client.rpc.rooms.start({ name: 'Logs probe', invite: ['ana'] })
    await s.r.client.rpc.rooms.say({ roomId: room.room.id, text: 'keith, hello the room' })
    await until(
      'the room answers',
      async () =>
        (await s.r.client.rpc.rooms.events({ roomId: room.room.id, after: 0, limit: 50 })).events,
      (events) => events.some((e) => e.kind === 'keith'),
      10_000,
    )
    const { sessions, calls } = await logsOf(s.r, s.dataDir)
    const session = sessions.find((x) => x.kind === 'room')
    expect(session).toMatchObject({ person_id: null, room_id: room.room.id, app: 'Room' })
    expect(session?.id.startsWith(`room:${room.room.id}:g`)).toBe(true)
    const roomCalls = calls.filter((c) => c.session_id === session?.id)
    expect(roomCalls.length).toBeGreaterThanOrEqual(1)
    expect(roomCalls[0]).toMatchObject({ call_kind: 'step', status: 'ok', speaker_id: 'owner' })
  })

  test('a guest turn is a guest session with no person and no room', async () => {
    const s = await scenario({
      pricing: { input: 1, output: 4 },
      front: [{ text: 'guest reply' }] as never,
    })
    await s.r.client.rpc.models.roles.set({ role: 'guest', ref: 'front-p:f' })
    await s.r.client.rpc.admin.guests.set({ enabled: true })
    const opened = await s.r.core.guests.open({ zone: 'lan', ipHash: 'abc123def456' })
    if (!opened.ok) throw new Error(`refused: ${opened.block}`)
    await opened.session.session().send('hello, a guest').result
    const { sessions, calls } = await logsOf(s.r, s.dataDir)
    const session = sessions.find((x) => x.kind === 'guest')
    expect(session).toMatchObject({ person_id: null, room_id: null, app: 'Guest' })
    expect(session?.id.startsWith('guest:')).toBe(true)
    const guestCalls = calls.filter((c) => c.session_id === session?.id)
    expect(guestCalls.length).toBeGreaterThanOrEqual(1)
    expect(guestCalls[0]).toMatchObject({ call_kind: 'step', status: 'ok', speaker_id: null })
  })
})
