import { describe, expect, test } from 'bun:test'
import { parseBrainEvent } from '@keith/contracts'
import { defineHarnessAgent, type HarnessUIMessage } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import { scriptedModel } from 'eharness/testing'
import { proactive } from './proactive.ts'

type Part = { type: string; data?: unknown }
const partsOf = (m: HarnessUIMessage | undefined): Part[] => (m?.parts ?? []) as Part[]
const isProactive = (m: HarnessUIMessage): boolean =>
  partsOf(m).some((p) => p.type === 'data-keith.proactive')
const textOf = (m: HarnessUIMessage): string =>
  m.parts.map((p) => (p.type === 'text' ? (p as { text: string }).text : '')).join('')

const report = (taskId: string) => ({
  name: 'subagent',
  text: `Background subagent ${taskId} finished. Found it.`,
  data: { sessionId: taskId, agent: 'cortex.research', status: 'completed', taskId },
})

function build() {
  const store = inMemoryActivityStore()
  const agent = defineHarnessAgent({
    id: 'front',
    model: scriptedModel([{ text: 'The result is ready.' }, { text: 'A normal reply.' }]),
    contextWindow: 100_000,
    plugins: [proactive({ store })] as never,
  })
  return { agent, store }
}

describe('proactive', () => {
  test('a wake turn is marked, and brain.ras.deliver names the task and the message', async () => {
    const { agent, store } = build()
    const session = agent.session('front:owner')
    const { run } = await session.inject('eh.event', report('front:owner:agent:c1'), {
      deliver: 'next-turn',
      wake: true,
    })
    await run?.result
    const messages = (await session.messages()) as HarnessUIMessage[]
    const wake = messages.find((m) => textOf(m).includes('The result is ready'))
    expect(wake).toBeDefined()
    expect(isProactive(wake as HarnessUIMessage)).toBe(true)
    const marker = partsOf(wake).find((p) => p.type === 'data-keith.proactive')
    expect(marker?.data).toEqual({ reason: 'subagent-report' })
    const events = (await store.read({ after: 0, limit: 10 })).filter(
      (e) => e.type === 'brain.ras.deliver',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      region: 'ras',
      personId: 'owner',
      taskId: 'front:owner:agent:c1',
      messageId: wake?.id,
    })
    expect(parseBrainEvent(events[0] as never)).toBeDefined()
    await agent.close()
  })

  test('the answer to an owner message is not marked, even when a report was noted before it', async () => {
    const { agent, store } = build()
    const session = agent.session('front:owner')
    // a report stored without waking: the owner's turn reads it, so it is a reply, not an alert
    await session.inject('eh.event', report('front:owner:agent:c2'), { deliver: 'next-turn' })
    await session.send('hello').result
    const messages = (await session.messages()) as HarnessUIMessage[]
    expect(messages.filter((m) => m.role === 'assistant').some(isProactive)).toBe(false)
    expect((await store.read({ after: 0, limit: 10 })).map((e) => e.type)).not.toContain(
      'brain.ras.deliver',
    )
    await agent.close()
  })
})
