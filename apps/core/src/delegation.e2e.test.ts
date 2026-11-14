/**
 * M2 gate (docs/plans/done/P3-m2-brain.md "M2 gate"): "find A" end to end on the real core
 * in process, driven through `@keith/client`. Front and Cortex models are scripted; the worker's
 * model calls are held by the test until it releases them.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { parseBrainEvent } from '@keith/contracts'
import {
  boot,
  cleanup,
  connect,
  idle,
  messagesOf,
  newDir,
  type Running,
  send,
  spawn,
  tasksOf,
  textOf,
} from './testing/core-harness.ts'
import { createGate, testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

describe('M2: "find A" end to end', () => {
  const gate = createGate()
  const D = /Started background subagent front:owner:agent:d\d/g
  let base = 0
  const front = testProvider({
    id: 'front-p',
    models: {
      f: [
        // turn 1: delegate, then answer (the lead continues the same message after the park)
        { toolCalls: [spawn('c1', 'find A')] },
        { text: 'Okay, I will look it up.' },
        // turn 2: a second owner message while the worker is held
        { text: 'In progress.' },
        // the wake turn
        { text: 'Result A: found, Sir.' },
        // phase 7: four delegations one after another, the fourth must be refused
        { toolCalls: [spawn('d1', 'task 1')] },
        { toolCalls: [spawn('d2', 'task 2')] },
        { toolCalls: [spawn('d3', 'task 3')] },
        { toolCalls: [spawn('d4', 'task 4')] },
        { text: 'Three running, one rejected.' },
        { text: 'Report received 1.' },
        { text: 'Report received 2.' },
        { text: 'Report received 3.' },
        { text: 'Report received 4.' },
      ],
    },
    // phase 7: let each started worker enter its turn before the lead delegates again
    before: async (prompt) => {
      const n = (prompt.match(D) ?? []).length
      if (n > 0) await gate.whenStarted(base + n)
    },
  })
  const cortex = testProvider({
    id: 'cortex-p',
    models: {
      w: [
        { text: 'Report A: found, source https://a.example.' },
        { text: 'Done 1.' },
        { text: 'Done 2.' },
        { text: 'Done 3.' },
        { text: 'Done 4.' },
      ],
    },
    gate,
  })
  let r: Running & { token: string }

  test('boot with a scripted front and a held worker', async () => {
    r = await boot(newDir(), [front as never, cortex as never])
    await connect(r.client)
    expect((await r.client.rpc.models.roles.get()).cortex).toBe('cortex-p:w')
  })

  test('delegation: the front answers at once and tasks.list shows the task running', async () => {
    await send(r.client, 'find A')
    await until('front answer', async () =>
      (await messagesOf(r.client)).some((m) => textOf(m).includes('Okay, I will look it up.')),
    )
    await gate.whenStarted(1)
    const [task] = await until(
      'running task',
      () => tasksOf(r.client),
      (t) => t.length === 1,
    )
    expect(task).toMatchObject({
      id: 'front:owner:agent:c1',
      agent: 'cortex.research',
      description: 'find A',
      status: 'running',
    })
    // the worker is still held: nothing of its report exists yet
    expect(JSON.stringify(await messagesOf(r.client))).not.toContain('Report A')
    expect((await r.client.rpc.tasks.list({ active: true })).length).toBe(1)
  })

  test('a second owner message gets its own answer while the worker is held, with the task in the reminder', async () => {
    await until('front idle', () => idle(r.client))
    await send(r.client, 'while we wait, how are you?')
    const msgs = await messagesOf(r.client)
    expect(msgs.map(textOf).join('|')).toContain('In progress.')
    expect((await tasksOf(r.client))[0]?.status).toBe('running')
    // the step that answered (call 2: delegation, its continuation, this reply) saw the active
    // task in its volatile reminder, and the reminder never reached the stored history
    const answering = JSON.stringify(front.models.get('f')?.prompts[2])
    expect(answering).toContain('Background tasks you delegated')
    expect(answering).toContain('front:owner:agent:c1')
    expect(answering).toContain('find A')
    expect(JSON.stringify(msgs)).not.toContain('Background tasks you delegated')
  })

  test('release: the task is done with a summary, the wake answer is proactive and reaches messages', async () => {
    gate.release()
    const [done] = await until(
      'task done',
      () => tasksOf(r.client),
      (t) => t[0]?.status === 'done',
    )
    expect(done?.summary).toContain('Report A: found')
    expect(done?.finishedAt).not.toBeNull()
    await until('wake answer', async () =>
      (await messagesOf(r.client)).some((m) => textOf(m).includes('Result A: found')),
    )
    const msgs = await messagesOf(r.client)
    const wake = msgs.find((m) => textOf(m).includes('Result A: found'))
    const marker = wake?.parts.find((p) => p.type === 'data-keith.proactive') as
      | { data?: unknown }
      | undefined
    expect(marker?.data).toEqual({ reason: 'subagent-report' })
    // answers to the owner are not marked
    const replies = msgs.filter(
      (m) => m.role === 'assistant' && m !== wake && textOf(m).includes('In progress'),
    )
    expect(replies.length).toBe(1)
    expect(replies[0]?.parts.some((p) => p.type === 'data-keith.proactive')).toBe(false)
    // the finished task is no longer in the reminder of the wake step
    const last = JSON.stringify(front.models.get('f')?.prompts.at(-1))
    expect(last).not.toContain('Background tasks you delegated')
  })

  test('the activity feed has the brain events in order, and every payload parses', async () => {
    const page = await r.client.harness.activity.page({ after: 0, limit: 500 })
    const types = page.events.map((e) => e.type)
    const first = (type: string): number => {
      const at = types.indexOf(type)
      expect(at).toBeGreaterThan(-1)
      return at
    }
    const order = [
      'brain.thalamus.routed',
      'brain.wernicke.start',
      'brain.broca.start',
      'brain.cortex.start',
      'brain.cortex.end',
      'brain.ras.deliver',
    ].map(first)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const event of page.events.filter((e) => e.type.startsWith('brain.'))) {
      expect(parseBrainEvent(event)).toBeDefined()
    }
    const routed = page.events.find((e) => e.type === 'brain.thalamus.routed')
    expect(routed?.payload).toMatchObject({ preview: 'find A', sessionId: 'front:owner' })
    const deliver = page.events.find((e) => e.type === 'brain.ras.deliver')
    expect(deliver?.payload).toMatchObject({ taskId: 'front:owner:agent:c1' })
    // the feed is behind the owner token like the rest
    expect((await fetch(new URL('/activity', r.server.url))).status).toBe(401)
    expect(types).toContain('task-changed')
    expect(types).toContain('brain.cortex.step')
  })

  test('the front agent can delegate, read and stop, but has no send_message (deferred)', () => {
    const tools = (front.models.get('f')?.calls[0]?.tools ?? []).map(
      (t) => (t as { name: string }).name,
    )
    expect(tools).toEqual(expect.arrayContaining(['agent', 'agent_output', 'agent_stop']))
    expect(tools).not.toContain('send_message')
  })

  test('maxConcurrent: a fourth background delegation is refused with a readable result', async () => {
    gate.close()
    base = gate.started
    await until('front idle', () => idle(r.client))
    await send(r.client, 'do four tasks')
    await until(
      'three workers running',
      () => r.client.rpc.tasks.list({ active: true }),
      (t) => t.length === 3,
    )
    const [only] = await until(
      'refusal seen',
      () => front.models.get('f')?.prompts,
      (p) => JSON.stringify(p).includes('background subagents are already running'),
    ).then((p) => p ?? [])
    expect(only).toBeDefined()
    const active = await r.client.rpc.tasks.list({ active: true })
    expect(active.map((t) => t.description).sort()).toEqual(['task 1', 'task 2', 'task 3'])
    gate.release()
    await until(
      'all done',
      () => tasksOf(r.client),
      (t) => t.every((x) => x.status === 'done'),
    )
  })
})
