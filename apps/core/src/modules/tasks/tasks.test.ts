import { describe, expect, test } from 'bun:test'
import { capabilitiesOf, parseBrainEvent, TaskSchema } from '@keith/contracts'
import { migrateDatabase, openDatabase, tasksRepo } from '@keith/db'
import { call } from '@orpc/server'
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { taskBoard } from './board.ts'
import { taskProcedures } from './procedures.ts'
import { applyReconcile } from './reconcile.ts'
import { renderTasks, taskReminder } from './reminder.ts'

function setup() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return { tasks: tasksRepo(sqlite), store: inMemoryActivityStore() }
}

const work = tool({
  description: 'works',
  inputSchema: z.object({}),
  execute: async () => 'ok',
})
const PARENT = {
  sessionId: 'front:owner',
  turnId: 't',
  depth: 1,
  agent: 'cortex.research',
  description: 'find A',
}

function worker(steps: Parameters<typeof scriptedModel>[0]) {
  const { tasks, store } = setup()
  const agent = defineHarnessAgent({
    id: 'cortex.research',
    model: scriptedModel(steps),
    contextWindow: 100_000,
    tools: { work },
    plugins: [taskBoard({ tasks, store })] as never,
  })
  return { agent, tasks, store }
}

describe('taskBoard', () => {
  test('a worker turn goes running, counts steps, ends done with the final text', async () => {
    const { agent, tasks, store } = worker([
      { toolCalls: [{ toolName: 'work', toolCallId: 'w1', input: {} }] },
      { text: `Result:\n\n${'long '.repeat(100)}` },
    ])
    await agent.session('front:owner:agent:c1', { parent: PARENT }).send('go').result
    const row = tasks.get('front:owner:agent:c1')
    expect(row).toMatchObject({
      parentSessionId: 'front:owner',
      agent: 'cortex.research',
      description: 'find A',
      status: 'done',
      steps: 2,
    })
    expect(row?.summary?.length).toBeLessThanOrEqual(500)
    expect(row?.summary).toStartWith('Result: long')
    expect(row?.finishedAt).not.toBeNull()
    expect(TaskSchema.safeParse(row).success).toBe(true)
    const events = await store.read({ after: 0, limit: 100 })
    const types = events.map((e) => e.type)
    expect(types.filter((t) => t === 'brain.cortex.start')).toHaveLength(1)
    expect(types.filter((t) => t === 'brain.cortex.step')).toHaveLength(2)
    expect(types.filter((t) => t === 'brain.cortex.end')).toHaveLength(1)
    expect(types.indexOf('brain.cortex.start')).toBeLessThan(types.indexOf('brain.cortex.end'))
    const end = events.find((e) => e.type === 'brain.cortex.end')
    expect(end?.payload).toMatchObject({ taskId: 'front:owner:agent:c1', status: 'done' })
    expect(String(end?.payload.summary).length).toBeLessThanOrEqual(200)
    for (const e of events.filter((x) => x.type.startsWith('brain.'))) {
      expect(parseBrainEvent(e)).toBeDefined()
    }
    const changed = events.filter((e) => e.type === 'task-changed')
    expect(changed.length).toBeGreaterThanOrEqual(4)
    expect(changed.every((e) => e.sessionId === 'front:owner')).toBe(true)
    await agent.close()
  })

  test('a failing model ends the task failed with the reason', async () => {
    const { agent, tasks } = worker([{ streamError: 'boom' } as never])
    await agent.session('front:owner:agent:c2', { parent: PARENT }).send('go').result
    const row = tasks.get('front:owner:agent:c2')
    expect(row?.status).toBe('failed')
    expect(row?.error).toBeTruthy()
    await agent.close()
  })

  test('a root session (no parent) never touches the board', async () => {
    const { agent, tasks } = worker([{ text: 'hi' }])
    await agent.session('front:owner').send('go').result
    expect(tasks.list()).toEqual([])
    await agent.close()
  })
})

describe('a final task row never reopens', () => {
  for (const status of ['stopped', 'done'] as const) {
    test(`a ${status} row stays ${status} after a later turn.start of its worker`, async () => {
      const { agent, tasks, store } = worker([{ text: 'again' }])
      const id = `front:owner:agent:final-${status}`
      tasks.upsert({
        id,
        parentSessionId: 'front:owner',
        agent: 'cortex.research',
        description: 'find A',
        status,
        finishedAt: 1,
      })
      await agent.session(id, { parent: PARENT }).send('go').result
      expect(tasks.get(id)).toMatchObject({ status, finishedAt: 1 })
      const events = await store.read({ after: 0, limit: 100 })
      expect(events.filter((e) => e.type === 'brain.cortex.start')).toHaveLength(0)
      await agent.close()
    })
  }

  test('the repo upsert refuses a status regress on its own', () => {
    const { tasks } = setup()
    tasks.upsert({
      id: 'x',
      parentSessionId: 'front:owner',
      agent: 'cortex.research',
      description: 'd',
      status: 'stopped',
      finishedAt: 5,
    })
    const row = tasks.upsert({
      id: 'x',
      parentSessionId: 'front:owner',
      agent: 'cortex.research',
      description: 'd',
      status: 'running',
      finishedAt: null,
    })
    expect(row).toMatchObject({ status: 'stopped', finishedAt: 5 })
    // an active row may still move on to a final one
    expect(tasks.upsert({ ...row, status: 'waiting' }).status).toBe('stopped')
  })
})

describe('taskReminder', () => {
  test('lists the active tasks of the session in the step reminder, and nothing otherwise', async () => {
    const { tasks } = setup()
    tasks.upsert({
      id: 'front:owner:agent:c1',
      parentSessionId: 'front:owner',
      agent: 'cortex.research',
      description: 'find A',
      status: 'running',
      steps: 3,
    })
    tasks.upsert({
      id: 'front:owner:agent:c0',
      parentSessionId: 'front:owner',
      agent: 'cortex.general',
      description: 'already finished',
      status: 'done',
    })
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const agent = defineHarnessAgent({
      id: 'front',
      model,
      contextWindow: 100_000,
      plugins: [taskReminder({ tasks })] as never,
    })
    await agent.session('front:owner').send('how far along is it?').result
    const prompt = JSON.stringify(model.prompts[0])
    expect(prompt).toContain('front:owner:agent:c1')
    expect(prompt).toContain('cortex.research')
    expect(prompt).toContain('3 steps')
    expect(prompt).toContain('find A')
    expect(prompt).not.toContain('already finished')
    tasks.markFinished('front:owner:agent:c1', { status: 'done' })
    await agent.session('front:owner').send('again').result
    expect(JSON.stringify(model.prompts[1])).not.toContain('Background tasks')
    // another session sees none of it
    await agent.session('front:other').send('hello').result
    expect(JSON.stringify(model.prompts.at(-1))).not.toContain('front:owner:agent:c1')
    await agent.close()
  })

  test('renderTasks prints age and status', () => {
    const text = renderTasks(
      [
        {
          id: 't1',
          parentSessionId: 'p',
          agent: 'cortex.general',
          description: 'x',
          status: 'waiting',
          steps: 0,
          summary: null,
          error: null,
          createdAt: 0,
          updatedAt: 0,
          finishedAt: null,
        },
      ],
      5 * 60_000,
    )
    expect(text).toContain('t1 · cortex.general · waiting · 0 steps · started 5m ago: x')
  })
})

describe('applyReconcile', () => {
  test('active rows take the reconciled status; finished rows are left alone', async () => {
    const { tasks, store } = setup()
    for (const id of ['a', 'b', 'c']) {
      tasks.upsert({
        id,
        parentSessionId: 'front:owner',
        agent: 'cortex.research',
        description: id,
        status: 'running',
      })
    }
    tasks.markFinished('c', { status: 'done', summary: 'ok' })
    applyReconcile(tasks, store, [
      { sessionId: 'a', outcome: 'reported', status: 'interrupted', recovered: true },
      { sessionId: 'b', outcome: 'running' },
      { sessionId: 'c', outcome: 'reported', status: 'failed' },
      { sessionId: 'unknown', outcome: 'reported', status: 'failed' },
    ])
    expect(tasks.get('a')).toMatchObject({ status: 'interrupted' })
    expect(tasks.get('a')?.error).toContain('restarted')
    expect(tasks.get('b')?.status).toBe('running')
    expect(tasks.get('c')).toMatchObject({ status: 'done', summary: 'ok' })
    expect(tasks.get('unknown')).toBeUndefined()
    expect((await store.read({ after: 0, limit: 10 })).map((e) => e.type)).toEqual([
      'task-changed',
      'brain.cortex.end',
    ])
  })
})

describe('taskProcedures', () => {
  const base = { via: 'tcp' as const, record: () => {} }
  const owner = {
    ...base,
    principal: { personId: 'owner', role: 'owner' as const },
    capabilities: capabilitiesOf('owner'),
  }
  const guest = {
    ...base,
    principal: { personId: 'guest', role: 'member' as const },
    capabilities: capabilitiesOf('member'),
  }
  const sessionOf = (p: { personId: string }): string => `front:${p.personId}`

  function procedures() {
    const { tasks } = setup()
    const stopped: string[] = []
    const p = taskProcedures({
      tasks,
      sessionOf,
      stop: async (t) => {
        stopped.push(t.id)
      },
    })
    for (const [id, status] of [
      ['t1', 'running'],
      ['t2', 'done'],
    ] as const) {
      tasks.upsert({
        id,
        parentSessionId: 'front:owner',
        agent: 'cortex.research',
        description: id,
        status,
      })
    }
    return { p, tasks, stopped }
  }

  test('list filters by the principal, active and limit', async () => {
    const { p } = procedures()
    const all = await call(p.list, {}, { context: owner })
    expect(all.map((t) => t.id).sort()).toEqual(['t1', 't2'])
    expect(TaskSchema.array().safeParse(all).success).toBe(true)
    expect((await call(p.list, { active: true }, { context: owner })).map((t) => t.id)).toEqual([
      't1',
    ])
    expect(await call(p.list, { limit: 1 }, { context: owner })).toHaveLength(1)
    expect(await call(p.list, {}, { context: guest })).toEqual([])
  })

  test('stop aborts an active task and marks it stopped; a finished one is a no-op', async () => {
    const { p, tasks, stopped } = procedures()
    expect(await call(p.stop, { id: 't1' }, { context: owner })).toEqual({ ok: true })
    expect(stopped).toEqual(['t1'])
    expect(tasks.get('t1')?.status).toBe('stopped')
    expect(await call(p.stop, { id: 't2' }, { context: owner })).toEqual({ ok: true })
    expect(stopped).toEqual(['t1'])
  })

  test('the row is stopped before the worker is touched, so its late turn.end cannot record done', async () => {
    const { tasks } = setup()
    const seen: Array<string | undefined> = []
    const p = taskProcedures({
      tasks,
      sessionOf,
      stop: async (t) => {
        seen.push(tasks.get(t.id)?.status)
      },
    })
    tasks.upsert({
      id: 'w1',
      parentSessionId: 'front:owner',
      agent: 'cortex.research',
      description: 'w1',
      status: 'waiting',
    })
    await call(p.stop, { id: 'w1' }, { context: owner })
    expect(seen).toEqual(['stopped'])
    expect(tasks.get('w1')?.status).toBe('stopped')
  })

  test('another person, or an unknown id, is not found', async () => {
    const { p, stopped } = procedures()
    await expect(call(p.stop, { id: 't1' }, { context: guest })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(call(p.stop, { id: 'nope' }, { context: owner })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(stopped).toEqual([])
  })
})
