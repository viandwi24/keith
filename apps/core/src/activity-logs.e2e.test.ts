/** ADR-0032 §1, P36.3.2: a front turn with the scripted provider leaves its session and its calls in the activity logs. */
import { afterAll, describe, expect, test } from 'bun:test'
import { activityLogsRepo, openDatabase } from '@keith/db'
import { boot, cleanup, connect, FAST, newDir, send } from './testing/core-harness.ts'
import { testProvider } from './testing/scripted-providers.ts'

afterAll(cleanup)

describe('activity logs: a front turn is recorded', () => {
  test('the session and its model call are stored once the queue is flushed', async () => {
    const front = testProvider({ id: 'front-p', models: { f: [{ text: 'Hello.' }] } })
    const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
    const config = newDir()
    const r = await boot(config, [front, worker] as never[], undefined, FAST)
    await connect(r.client)
    await send(r.client, 'hello')

    await r.core.activity.flush()
    const sqlite = openDatabase(config.dbFile)
    try {
      const repo = activityLogsRepo(sqlite)
      const session = repo.getSession('front:owner')
      expect(session).toMatchObject({
        kind: 'chat',
        personId: 'owner',
        roomId: null,
        app: 'Front',
        primaryModel: 'f',
        primaryProvider: 'front-p',
      })
      expect(session?.calls).toBeGreaterThanOrEqual(1)

      const calls = repo.listCalls('front:owner')
      expect(session?.calls).toBe(calls.length)
      const step = calls.find((c) => c.kind === 'step')
      expect(step).toMatchObject({
        sessionId: 'front:owner',
        status: 'ok',
        modelId: 'f',
        provider: 'front-p',
        trigger: 'send',
        bodyState: 'stored',
      })
      expect(step && repo.getBodies(step.id)?.request).toBeInstanceOf(Uint8Array)
    } finally {
      sqlite.close()
    }
  })
})
