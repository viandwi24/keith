/** M4 gate: the monthly budget. Readable stops, a status the TUI can show, workers that say so. */
import { afterAll, describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import {
  boot,
  cleanup,
  connect,
  FAST,
  messagesOf,
  newDir,
  send,
  stop,
  tasksOf,
} from './testing/core-harness.ts'
import { scenario } from './testing/scenario-harness.ts'
import { createGate, testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

/**
 * USD per 1M tokens: a step of 10 input and 5 output tokens costs 0.02 USD. Input is cheap on purpose: the ledger reserves each step
 * up front from the prompt size and 4096 output tokens, and the front prompt grows with every tool, so an expensive input price would
 * make the first reservation depend on the prompt's length instead of on the limits these tests are about.
 */
const PRICING = { input: 10, output: 3980 }
const info = (id: string) => ({ [id]: { contextWindow: 200_000, pricing: PRICING } })

const noticesOf = (messages: UIMessage[]): string[] =>
  messages.flatMap((m) =>
    m.parts.flatMap((p) =>
      p.type === 'data-eh.notice'
        ? [String((p as { data: { message: string } }).data.message)]
        : [],
    ),
  )

describe('M4: budget', () => {
  test('get reports limit, spent and remaining; a tiny limit stops the next turn with a readable notice', async () => {
    const front = testProvider({
      id: 'front-p',
      models: { f: [{ text: 'Hello.' }, { text: 'never called' }] },
      info: info('f'),
    })
    const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
    const r = await boot(newDir(), [front, worker] as never[], undefined, FAST)
    await connect(r.client)

    const before = await r.client.rpc.budget.get()
    expect(before).toMatchObject({ scope: 'owner', limitUsd: 20, spentUsd: 0, remainingUsd: 20 })
    expect(before.periodEnd).toBeGreaterThan(before.periodStart)
    expect(new Date(before.periodEnd).getUTCDate()).toBe(1)

    await send(r.client, 'hello')
    const after = await r.client.rpc.budget.get()
    expect(after.spentUsd).toBeCloseTo(0.02, 5)
    expect(after.remainingUsd).toBeCloseTo(20 - 0.02, 5)

    const changed = await r.client.rpc.budget.set({ limitUsd: 0.05 })
    expect(changed.limitUsd).toBe(0.05)
    const feed = await r.client.harness.activity.page({ after: 0, limit: 500 })
    const event = feed.events.filter((e) => e.type === 'budget-changed').at(-1)
    expect(event?.payload).toMatchObject({ status: { limitUsd: 0.05 } })

    await send(r.client, 'hello again')
    const notices = noticesOf(await messagesOf(r.client))
    // 0.02 spent of 0.05: the limit is not reached, the 0.50 reserve of a turn does not fit
    expect(notices.at(-1)).toBe(
      'The remaining monthly cost limit is not enough for one turn: 0.02 of 0.05 USD used or reserved, while one turn reserves up to 0.5 USD. Raise the limit with /budget or wait until next month.',
    )
    // the model was not called for the refused turn
    expect(front.models.get('f')?.calls.length).toBe(1)

    // the owner raises the limit and talks again
    await r.client.rpc.budget.set({ limitUsd: 20 })
    await send(r.client, 'hello a third time')
    expect(front.models.get('f')?.calls.length).toBe(2)
    // no limit at all: remaining is null, and it stays removed after a restart
    const none = await r.client.rpc.budget.set({ limitUsd: null })
    expect(none).toMatchObject({ limitUsd: null, remainingUsd: null })
    await stop(r)
  })

  test('limit 0.01 USD with nothing spent: the notice says the rest is too small, not that the limit was reached', async () => {
    const front = testProvider({ id: 'front-p', models: { f: [{ text: 'x' }] }, info: info('f') })
    const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
    const r = await boot(newDir(), [front, worker] as never[], undefined, FAST)
    await connect(r.client)
    await r.client.rpc.budget.set({ limitUsd: 0.01 })
    await send(r.client, 'hello')
    expect(noticesOf(await messagesOf(r.client)).at(-1)).toBe(
      'The remaining monthly cost limit is not enough for one turn: 0 of 0.01 USD used or reserved, while one turn reserves up to 0.5 USD. Raise the limit with /budget or wait until next month.',
    )
    expect(front.models.get('f')?.calls.length).toBe(0)
    await stop(r)
  })

  test('a turn over its own cap (0.5 USD) also ends with a readable notice, not silence', async () => {
    const front = testProvider({
      id: 'front-p',
      models: {
        f: [
          // 300 output tokens at 3 980 USD per 1M = 1.19 USD in one step, over the 0.5 cap
          {
            toolCalls: [{ toolName: 'nodes_status', toolCallId: 'n1', input: {} }],
            usage: { inputTokens: 0, outputTokens: 300 },
          },
          { text: 'never called' },
        ],
      },
      info: info('f'),
    })
    const worker = testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } })
    const r = await boot(newDir(), [front, worker] as never[], undefined, FAST)
    await connect(r.client)
    await send(r.client, 'big task')
    const notice = noticesOf(await messagesOf(r.client)).at(-1) ?? ''
    expect(notice).toContain('per-turn limit')
    expect(front.models.get('f')?.calls.length).toBe(1)
    await stop(r)
  })

  test('a limit the owner removed stays removed after a restart; the default is set once', async () => {
    const config = newDir()
    const first = await boot(config, [], undefined, FAST)
    expect((await first.client.rpc.budget.get()).limitUsd).toBe(20)
    await first.client.rpc.budget.set({ limitUsd: null })
    const token = first.token
    await stop(first)
    const second = await boot(config, [], token, FAST)
    expect((await second.client.rpc.budget.get()).limitUsd).toBeNull()
    await stop(second)
  })

  test('a worker that runs out of budget says so in its task and in the report', async () => {
    const gate = createGate()
    const s = await scenario({
      front: [
        {
          toolCalls: [
            {
              toolName: 'agent',
              toolCallId: 'c1',
              input: {
                subagent_type: 'cortex.general',
                description: 'expensive task',
                prompt: 'Do it.',
                run_in_background: true,
              },
            },
          ],
        },
        { text: 'Okay.' },
        { text: 'Anggaran habis, Sir.' },
      ],
      worker: [
        { toolCalls: [{ toolName: 'nodes_status', toolCallId: 'n1', input: {} }] },
        { text: 'never' },
      ],
      pricing: PRICING,
      workerGate: gate,
    })
    await send(s.r.client, 'do the expensive task')
    await gate.whenStarted(1)
    // the limit drops while the worker's first step is in flight: its second step is refused
    await s.r.client.rpc.budget.set({ limitUsd: 0.03 })
    gate.release()
    const task = await until(
      'task failed',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'failed',
    )
    expect(task[0]?.summary).toContain('cost limit')
    expect(task[0]?.error).toContain('cost-cap')
    // the report reached the front agent with the same words
    await s.r.client.rpc.budget.set({ limitUsd: 20 })
    await send(s.r.client, 'how is the task going?')
    const prompts = (s.front.models.get('f')?.prompts ?? []).map((p) => JSON.stringify(p))
    expect(prompts.some((p) => p.includes('cost-cap'))).toBe(true)
  })
})
