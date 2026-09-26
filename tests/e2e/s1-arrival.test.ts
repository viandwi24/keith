import { afterEach, describe, expect, test } from 'bun:test'
import type { DeliveryId } from '../../packages/protocol/src/index.ts'
import { type AnyPluginDefinition, definePlugin, type LlmRequest } from '../../packages/sdk/src/index.ts'
import { type FakeLlm, fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import {
  addPerson,
  connectNode,
  createGate,
  createHome,
  type E2eConfig,
  type E2ePerson,
  e2eClock,
  e2eConfig,
  type Keith,
  nextEvent,
  scriptedLlm,
  scriptedProvider,
  startKeith,
  systemOf,
  TEST_TIMEOUT_MS,
} from './harness.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const GOAL = 'Summarize the overnight lab test results'
const RESULT = 'Overnight: Mark 42 thruster test passed at 98% output.'
const AWAY_MINUTES = 1

const HEADLINES = '3 headlines: Stark Industries stock up, Expo opens Friday, rain at 4pm.'

/** Replies with the pending items that are in the turn's context (section 8). */
function briefingReply(req: LlmRequest) {
  const system = systemOf(req)
  let text = 'Good morning, sir.'
  if (system.includes(RESULT)) text += ` While you were away: ${RESULT}`
  if (system.includes(HEADLINES)) text += ` Also, ${HEADLINES}`
  return fakeText(text)
}

/**
 * A `tool` plugin that queues a news item when someone comes back (S-1 step 2; not on a first
 * meeting), and counts those arrivals in its data store.
 */
const newsPlugin = definePlugin({
  id: '@keith/e2e-news',
  namespace: 'news',
  version: '0.0.0',
  kind: 'tool',
  setup(ctx) {
    ctx.events.on('person.arrived', async (e) => {
      if (e.data.awayMs === null) return
      const seen = ((await ctx.data.get('arrivals')) as number | undefined) ?? 0
      await ctx.data.set('arrivals', seen + 1)
      await ctx.deliveries.enqueue({ personId: e.data.personId, text: HEADLINES })
    })
  },
})

type Setup = { keith: Keith; tony: E2ePerson; chat: FakeLlm; deliveryId: DeliveryId; threadId: string }

/**
 * Boots Keith, lets Tony start a task, disconnects him, and completes the task while no node is
 * attached. Returns once its delivery is queued (and not delivered, since Tony is away).
 */
async function taskCompletesWhileAway(
  config: E2eConfig,
  advanceMs: number,
  plugins: AnyPluginDefinition[] = [],
): Promise<Setup> {
  const home = await createHome(e2eConfig({ awayAfterMinutes: AWAY_MINUTES, ...config }))
  cleanups.push(() => home.remove())
  const clock = e2eClock()
  const gate = createGate()
  const chat = scriptedLlm([
    [fakeToolCall('task.start', { goal: GOAL, notify: 'when-done', promise: 'I will brief you' })],
    fakeText('Understood.'),
    briefingReply,
  ])
  const { keith } = await startKeith({
    home,
    clock,
    provider: scriptedProvider({
      chat: { llm: chat },
      researcher: { llm: scriptedLlm([fakeText(RESULT)]), before: () => gate.promise },
    }),
    plugins,
  })
  cleanups.push(() => keith.stop())
  cleanups.push(() => gate.open())
  const tony = await addPerson(keith, clock, { name: 'Tony', tier: 'owner' })

  const evening = await connectNode(keith, tony)
  cleanups.push(() => evening.close())
  const { threadId } = await evening.openMain()
  const started = nextEvent(keith, 'task.started')
  evening.say(threadId, 'Summarize the overnight tests for me tomorrow.')
  expect((await evening.reply(threadId)).content).toBe('Understood.')
  await started

  // Tony leaves. His last-seen time is written when his last node detaches.
  const left = nextEvent(keith, 'person.left', (e) => e.personId === tony.id)
  await evening.close()
  await left
  expect((await keith.repos.persons.get(tony.id))?.lastSeenAt).toBe(clock.now())
  clock.advance(advanceMs)

  // The task completes while no node is attached. The delivery waits (Tony is away).
  const enqueued = nextEvent(keith, 'delivery.enqueued', (e) => e.threadId === threadId)
  const completed = nextEvent(keith, 'task.completed')
  gate.open()
  await completed
  const { deliveryId } = await enqueued
  await keith.events.idle()
  await keith.threads.idle()
  expect((await keith.repos.deliveries.get(deliveryId))?.status).toBe('pending')
  expect(chat.calls).toBe(2)
  return { keith, tony, chat, deliveryId, threadId }
}

describe('S-1: arrival and briefing', () => {
  test(
    'S-1 / I-10: a task result waits while Tony is away; after the threshold his "hello" gets the briefing',
    async () => {
      const { keith, tony, chat, deliveryId } = await taskCompletesWhileAway({}, AWAY_MINUTES * 60_000 + 1, [
        newsPlugin,
      ])

      const arrived = nextEvent(keith, 'person.arrived', (e) => e.personId === tony.id)
      const news = nextEvent(keith, 'delivery.enqueued', (e) => e.deliveryId !== deliveryId)
      const morning = await connectNode(keith, tony)
      cleanups.push(() => morning.close())
      const { threadId } = await morning.openMain()
      expect((await arrived).awayMs).toBe(AWAY_MINUTES * 60_000 + 1)
      // A plugin listening to person.arrived queues its own item for the briefing.
      const newsId = (await news).deliveryId

      // on-greeting: an arrival hold, so Keith waits for Tony's first words.
      await Bun.sleep(100)
      expect(morning.frames.some((f) => f.type === 'message.started')).toBe(false)
      expect((await keith.repos.deliveries.get(deliveryId))?.status).toBe('pending')

      morning.say(threadId, 'Hello Keith.')
      const started = await morning.next('message.started')
      expect(started.data.proactive).toBe(false)
      const reply = await morning.reply(threadId)
      expect(reply.content).toBe(`Good morning, sir. While you were away: ${RESULT} Also, ${HEADLINES}`)

      const req = chat.requests.at(-1)
      expect(req?.messages.at(-1)).toEqual({ role: 'user', content: 'Hello Keith.' })
      await keith.threads.idle()
      expect((await keith.repos.deliveries.get(deliveryId))?.status).toBe('delivered')
      const item = await keith.repos.deliveries.get(newsId)
      expect([item?.status, item?.source, item?.kind]).toEqual(['delivered', '@keith/e2e-news', 'plugin'])
      expect(await keith.repos.pluginData.get('@keith/e2e-news', 'arrivals')).toBe(1)
      // Nothing else is flushed afterwards: the result was delivered once, in the reply.
      expect(chat.calls).toBe(3)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'S-1: briefing = auto greets on arrival without any input',
    async () => {
      const { keith, tony, chat, deliveryId } = await taskCompletesWhileAway(
        { briefing: 'auto', graceMs: 20 },
        AWAY_MINUTES * 60_000,
      )

      const morning = await connectNode(keith, tony)
      cleanups.push(() => morning.close())
      const { threadId } = await morning.openMain()
      const started = await morning.next('message.started')
      expect(started.data.proactive).toBe(true)
      const reply = await morning.reply(threadId)
      expect(reply.content).toBe(`Good morning, sir. While you were away: ${RESULT}`)
      expect(reply.meta?.proactive).toBe(true)
      // The replayed history ends with the last reply, after its tool step (order by createdAt, id).
      expect(chat.requests.at(-1)?.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ])
      expect(chat.requests.at(-1)?.messages.at(-1)).toEqual({ role: 'assistant', content: 'Understood.' })
      await keith.threads.idle()
      expect((await keith.repos.deliveries.get(deliveryId))?.status).toBe('delivered')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'S-1: a reconnect below the threshold is no arrival; pending items flush after thread.opened',
    async () => {
      const { keith, tony, deliveryId } = await taskCompletesWhileAway({}, AWAY_MINUTES * 60_000 - 1)

      let arrivals = 0
      keith.events.on('person.arrived', () => {
        arrivals += 1
      })
      const back = await connectNode(keith, tony)
      cleanups.push(() => back.close())
      back.send('thread.open', {})
      const opened = await back.next('thread.opened')
      const started = await back.next('message.started')
      expect(started.data.proactive).toBe(true)
      // Flush trigger (d) runs after the server attached the node and sent thread.opened (C1/E1).
      expect(back.frames.indexOf(opened)).toBeLessThan(back.frames.indexOf(started))
      const reply = await back.reply(opened.data.thread.id)
      expect(reply.content).toContain(RESULT)
      await keith.threads.idle()
      expect(arrivals).toBe(0)
      expect((await keith.repos.deliveries.get(deliveryId))?.status).toBe('delivered')
    },
    TEST_TIMEOUT_MS,
  )
})
