/** M4 gate: resume across processes. Two cores, one database. */
import { afterAll, describe, expect, test } from 'bun:test'
import { openDatabase, sqliteState } from '@keith/db'
import { instanceIdOf } from './modules/resume/index.ts'
import { boot, cleanup, connect, FAST, messagesOf, newDir, stop } from './testing/core-harness.ts'
import { createGate, testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const defs = (
  front: Parameters<typeof testProvider>[0]['models'][string],
  gate?: ReturnType<typeof createGate>,
) => {
  const f = testProvider({ id: 'front-p', models: { f: front }, ...(gate ? { gate } : {}) })
  const w = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
  return { f, defs: [f, w] as never[] }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe('M4: resume across processes', () => {
  test('a reader on another core replays the chunks of a turn that runs on core A', async () => {
    const config = newDir()
    const a = await boot(
      config,
      defs([{ text: 'Answer from core A', delayMs: 150 }]).defs,
      undefined,
      FAST,
      'core-a',
    )
    await connect(a.client)
    const b = await boot(config, defs([{ text: 'not used' }]).defs, a.token, FAST, 'core-b')

    const running = (async () => {
      for await (const _ of a.client.reply('hello')) {
        // drain: the turn ends with the stream
      }
    })()
    // the turn is running on A and is not finished
    await until(
      'turn running on A',
      async () => (await a.client.harness.sessions.get('front:owner')).running,
    )
    const response = await fetch(new URL('/sessions/front:owner/chat/stream', b.server.url), {
      headers: auth(a.token),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('Answer from core A')
    await running

    // a reader that comes after the turn ended gets 204: the stored messages are the answer
    const after = await fetch(new URL('/sessions/front:owner/chat/stream', b.server.url), {
      headers: auth(a.token),
    })
    expect(after.status).toBe(204)
    await stop(b)
    await stop(a)
  })

  test('core B marks the turn core A left behind as interrupted, with a notice, at boot', async () => {
    const config = newDir()
    const gate = createGate()
    const a = await boot(
      config,
      defs([{ text: 'never finishes' }], gate).defs,
      undefined,
      FAST,
      'core-a',
    )
    await connect(a.client)
    const running = (async () => {
      for await (const _ of a.client.reply('hello')) {
        // never ends while the gate is closed
      }
    })().catch(() => undefined)
    await gate.whenStarted(1)

    // core A dies: its heartbeat is old and its lock lease has run out
    await staleness(config.dbFile)

    const b = await boot(config, defs([{ text: 'I am back.' }]).defs, a.token, FAST, 'core-b')
    const messages = await until(
      'interrupted notice',
      () => messagesOf(b.client),
      (list) =>
        list.some((m) =>
          m.parts.some(
            (p) => p.type === 'data-eh.notice' && JSON.stringify(p).includes('EH_TURN_INTERRUPTED'),
          ),
        ),
    )
    expect(messages.length).toBeGreaterThan(0)
    expect((await b.client.harness.sessions.get('front:owner')).running).toBe(false)
    gate.release()
    await running
    await stop(b)
    await stop(a)
  })

  test('the instance id of a core is kept in its data folder', () => {
    const config = newDir()
    const id = instanceIdOf(config.dataDir)
    expect(id).toStartWith('core-')
    expect(instanceIdOf(config.dataDir)).toBe(id)
    expect(instanceIdOf(newDir().dataDir)).not.toBe(id)
  })
})

/** Make the front turn look abandoned: heartbeat from long ago, lock lease expired. */
async function staleness(dbFile: string): Promise<void> {
  const sqlite = openDatabase(dbFile)
  try {
    const state = sqliteState(sqlite)
    const front = (await state.get('front:owner')) as unknown as {
      core: { activeTurn: { heartbeatAt: number } }
    }
    front.core.activeTurn.heartbeatAt = 0
    await state.set('front:owner', front as never)
    sqlite.query('UPDATE eh_locks SET until = 0 WHERE session_id = ?').run('front:owner')
  } finally {
    sqlite.close()
  }
}
