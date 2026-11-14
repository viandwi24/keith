/** M2 gate: recovery (a restart while a worker runs) and stopping a task. */
import { afterAll, describe, expect, test } from 'bun:test'
import { parseBrainEvent } from '@keith/contracts'
import { openDatabase, sqliteState, tasksRepo } from '@keith/db'
import {
  boot,
  cleanup,
  connect,
  FAST,
  messagesOf,
  newDir,
  send,
  spawn,
  stop,
  tasksOf,
  textOf,
} from './testing/core-harness.ts'
import { createGate, testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

describe('M2: a restart while a worker runs', () => {
  test('reconcile ends the task as interrupted and the owner is told proactively', async () => {
    const config = newDir()
    const gate = createGate()
    const defsA = [
      testProvider({
        id: 'front-p',
        models: {
          f: [{ toolCalls: [spawn('c1', 'find B')] }, { text: 'Okay, I will look up B.' }],
        },
      }),
      testProvider({ id: 'cortex-p', models: { w: [{ text: 'never finishes' }] }, gate }),
    ]
    // the first core never gets to finish the worker: it stands for a process that died
    const a = await boot(config, defsA as never[], undefined, {
      ...FAST,
      inboxPollMs: 3_600_000,
    })
    await connect(a.client)
    // the worker's inbox is polled by the (slow) timer: nudge it by reopening is not needed,
    // the lead enqueues the child on the same instance, which drains at once
    await send(a.client, 'find B')
    await gate.whenStarted(1)
    await until(
      'task running',
      () => tasksOf(a.client),
      (t) => t[0]?.status === 'running',
    )
    const token = a.token

    // a dead owner leaves a stale heartbeat on the turn it held
    const sqlite = openDatabase(config.dbFile)
    const state = sqliteState(sqlite)
    const child = (await state.get('front:owner:agent:c1')) as unknown as {
      core: { activeTurn: { heartbeatAt: number } }
    }
    child.core.activeTurn.heartbeatAt = 0
    await state.set('front:owner:agent:c1', child as never)
    sqlite.close()

    const defsB = [
      testProvider({
        id: 'front-p',
        models: { f: [{ text: 'Sir, job B was interrupted by a restart.' }] },
      }),
      testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } }),
    ]
    const b = await boot(config, defsB as never[], token)
    await until(
      'interrupted',
      () => tasksOf(b.client),
      (t) => t[0]?.status === 'interrupted',
    )
    const wake = await until('proactive message', async () =>
      (await messagesOf(b.client)).find((m) => textOf(m).includes('interrupted')),
    )
    expect(wake?.parts.some((p) => p.type === 'data-keith.proactive')).toBe(true)
    gate.release()
    await stop(b)
    await stop(a)
  })
})

describe('M2: stopping a task', () => {
  test('tasks.stop aborts the worker and the board says stopped', async () => {
    const gate = createGate()
    const defs = [
      testProvider({
        id: 'front-p',
        models: {
          f: [
            { toolCalls: [spawn('c1', 'find C')] },
            { text: 'Okay, I will look up C.' },
            { text: 'Dihentikan, Sir.' },
          ],
        },
      }),
      testProvider({ id: 'cortex-p', models: { w: [{ text: 'terlambat' }] }, gate }),
    ]
    const r = await boot(newDir(), defs as never[])
    await connect(r.client)
    await send(r.client, 'find C')
    await gate.whenStarted(1)
    await until(
      'running',
      () => tasksOf(r.client),
      (t) => t[0]?.status === 'running',
    )
    await expect(r.client.rpc.tasks.stop({ id: 'nope' })).rejects.toThrow()
    expect(await r.client.rpc.tasks.stop({ id: 'front:owner:agent:c1' })).toEqual({ ok: true })
    gate.release()
    await until(
      'stopped',
      () => tasksOf(r.client),
      (t) => t[0]?.status === 'stopped',
    )
    await stop(r)
  })

  test('tasks.stop on a task whose worker is gone still emits task-changed with status stopped', async () => {
    const config = newDir()
    const r = await boot(config, [])
    // a row left running by a worker that no longer exists anywhere
    const sqlite = openDatabase(config.dbFile)
    tasksRepo(sqlite).upsert({
      id: 'front:owner:agent:ghost',
      parentSessionId: 'front:owner',
      agent: 'cortex.research',
      description: 'hantu',
      status: 'running',
    })
    sqlite.close()
    expect(await r.client.rpc.tasks.stop({ id: 'front:owner:agent:ghost' })).toEqual({ ok: true })
    expect((await tasksOf(r.client))[0]?.status).toBe('stopped')
    const page = await r.client.harness.activity.page({ after: 0, limit: 100 })
    const changed = page.events.filter((e) => e.type === 'task-changed')
    expect(changed.at(-1)?.payload).toMatchObject({
      task: { id: 'front:owner:agent:ghost', status: 'stopped' },
    })
    const end = page.events.find((e) => e.type === 'brain.cortex.end')
    expect(end?.payload).toMatchObject({ taskId: 'front:owner:agent:ghost', status: 'stopped' })
    expect(parseBrainEvent(end as never)).toBeDefined()
    await stop(r)
  })
})
