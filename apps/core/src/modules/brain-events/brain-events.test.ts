import { describe, expect, test } from 'bun:test'
import { parseBrainEvent } from '@keith/contracts'
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { emit } from './emit.ts'
import { brainEvents } from './plugin.ts'

const fetchPage = tool({
  description: 'fetches a page',
  inputSchema: z.object({}),
  metadata: { risk: 'external' },
  execute: async () => 'page',
} as never)

function build(role: 'front' | 'worker') {
  const store = inMemoryActivityStore()
  const agent = defineHarnessAgent({
    id: 'tester',
    model: scriptedModel([
      { toolCalls: [{ toolName: 'web_fetch', toolCallId: 't1', input: {} }] },
      { text: 'done' },
    ]),
    contextWindow: 100_000,
    tools: { web_fetch: fetchPage },
    approval: { risk: { external: 'approved' } },
    plugins: [brainEvents({ store, role })] as never,
  })
  return { agent, store }
}

const read = async (store: ReturnType<typeof inMemoryActivityStore>) =>
  store.read({ after: 0, limit: 100 })

describe('brainEvents (front)', () => {
  test('a send turn lights wernicke and broca, and its tool lights motor and amygdala', async () => {
    const { agent, store } = build('front')
    await agent.session('front:owner').send('hello').result
    const events = await read(store)
    expect(events.map((e) => e.type)).toEqual([
      'brain.wernicke.start',
      'brain.broca.start',
      'brain.amygdala.decide',
      'brain.motor.act',
      'brain.broca.end',
    ])
    for (const e of events) expect(parseBrainEvent(e)).toBeDefined()
    expect(events[2]?.payload).toMatchObject({ toolName: 'web_fetch', approved: true })
    expect(events[3]?.payload).toEqual({
      region: 'motor',
      personId: 'owner',
      toolName: 'web_fetch',
      ok: true,
    })
    expect(events[4]?.payload).toMatchObject({ kind: 'send', stop: 'complete' })
    expect(events.every((e) => e.sessionId === 'front:owner' && e.agentId === 'tester')).toBe(true)
    await agent.close()
  })

  test('orchestration tools never count as motor acts', async () => {
    const store = inMemoryActivityStore()
    const agent = defineHarnessAgent({
      id: 'tester',
      model: scriptedModel([
        { toolCalls: [{ toolName: 'agent_output', toolCallId: 't1', input: {} }] },
        { text: 'done' },
      ]),
      contextWindow: 100_000,
      tools: { agent_output: fetchPage },
      plugins: [brainEvents({ store, role: 'front' })] as never,
    })
    await agent.session('s').send('x').result
    expect((await read(store)).map((e) => e.type)).not.toContain('brain.motor.act')
    await agent.close()
  })
})

describe('brainEvents (worker)', () => {
  test('in a child session the motor act carries the task id; no front phases', async () => {
    const { agent, store } = build('worker')
    await agent
      .session('front:owner:agent:c1', {
        parent: { sessionId: 'front:owner', turnId: 't', depth: 1 },
      })
      .send('go').result
    const events = await read(store)
    expect(events.map((e) => e.type)).toEqual(['brain.amygdala.decide', 'brain.motor.act'])
    expect(events[1]?.payload).toMatchObject({ taskId: 'front:owner:agent:c1', ok: true })
    for (const e of events) expect(parseBrainEvent(e)).toBeDefined()
    await agent.close()
  })
})

describe('emit', () => {
  test('a failing store never throws, it reports', async () => {
    const warned: string[] = []
    const broken = {
      ...inMemoryActivityStore(),
      append: () => Promise.reject(new Error('disk full')),
    }
    emit(broken, 'brain.ras.deliver', null, null, { region: 'ras', taskId: 't' }, (m) =>
      warned.push(m),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(warned[0]).toContain('disk full')
  })
})
