import { afterEach, describe, expect, test } from 'bun:test'
import type { LlmRequest } from '../../packages/sdk/src/index.ts'
import { fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import {
  addPerson,
  connectNode,
  createGate,
  createHome,
  e2eClock,
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

const GOAL = 'Research venue options for the Stark Expo'
const PROMISE = "I'll tell you when the shortlist is ready"
const RESULT = 'Venue shortlist: Flushing Meadows, Javits Center, Pier 94.'

/** The delivery turn: says the result when it is in the context (section 8). */
function deliveryReply(req: LlmRequest) {
  return fakeText(
    systemOf(req).includes(RESULT) ? `Sir, the venue shortlist is ready. ${RESULT}` : 'Nothing to report.',
  )
}

describe('S-2: research in the background, report when done', () => {
  test(
    'S-2 / I-5 / I-11: task.start ends the turn fast, chat continues, the result arrives unsolicited',
    async () => {
      const home = await createHome()
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const researchGate = createGate()
      const chat = scriptedLlm([
        [fakeToolCall('task.start', { goal: GOAL, notify: 'when-done', promise: PROMISE })],
        fakeText("I'll get on it, sir."),
        fakeText('Nothing until three, sir.'),
        deliveryReply,
      ])
      const researcher = scriptedLlm([fakeText(RESULT, 12)])
      let researching = 0
      const { keith } = await startKeith({
        home,
        clock,
        provider: scriptedProvider({
          chat: { llm: chat },
          researcher: {
            llm: researcher,
            before: () => {
              researching += 1
              return researchGate.promise
            },
          },
        }),
      })
      cleanups.push(() => keith.stop())
      cleanups.push(() => researchGate.open())
      const tony = await addPerson(keith, clock, { name: 'Tony', tier: 'owner' })

      const node = await connectNode(keith, tony)
      cleanups.push(() => node.close())
      const { threadId } = await node.openMain()

      const order: string[] = []
      keith.events.on('turn.completed', (e) => {
        if (e.data.threadId === threadId) order.push('turn.completed')
      })
      keith.events.on('task.completed', () => {
        order.push('task.completed')
      })

      // 1-2. The model starts a task with a commitment; the turn ends while the task still runs.
      const taskStarted = nextEvent(keith, 'task.started')
      node.say(threadId, 'Keith, research venue options for the Expo.')
      const tool = await node.next('tool.activity', (f) => f.data.status === 'completed')
      expect(tool.data.name).toBe('task.start')
      const ack = await node.reply(threadId)
      expect(ack.content).toBe("I'll get on it, sir.")
      const { taskId } = await taskStarted
      expect((await keith.repos.tasks.get(taskId))?.status).toBe('running')
      const commitments = await keith.repos.commitments.openForThread(threadId)
      expect(commitments.map((c) => [c.taskId, c.promise])).toEqual([[taskId, PROMISE]])

      // 3. Tony keeps chatting: his turn is not delayed by the running task (I-5).
      node.say(threadId, "By the way, what's on my calendar?")
      const second = await node.reply(threadId)
      expect(second.content).toBe('Nothing until three, sir.')
      expect((await keith.repos.tasks.get(taskId))?.status).toBe('running')
      // The task is inside its model call, holding a background slot.
      expect(researching).toBe(1)

      // 4. The task completes: commitment fulfilled, delivery queued, proactive turn at idle (I-11).
      const sentBefore = node.frames.length
      const enqueued = nextEvent(keith, 'delivery.enqueued', (d) => d.threadId === threadId)
      const delivered = nextEvent(keith, 'delivery.delivered', (d) => d.threadId === threadId)
      researchGate.open()
      const started = await node.next('message.started', (f) => f.data.proactive)
      const report = await node.reply(threadId)
      expect(report.id).toBe(started.data.messageId)
      expect(report.content).toBe(`Sir, the venue shortlist is ready. ${RESULT}`)
      expect(report.meta?.proactive).toBe(true)
      expect(node.frames.length).toBeGreaterThan(sentBefore)

      expect(order).toEqual(['turn.completed', 'turn.completed', 'task.completed', 'turn.completed'])

      const { deliveryId, kind } = await enqueued
      expect(kind).toBe('task_result')
      const done = await delivered
      expect(done.deliveryId).toBe(deliveryId)
      expect(done.messageId).toBe(report.id)
      await keith.threads.idle()
      expect((await keith.repos.deliveries.get(deliveryId))?.status).toBe('delivered')
      expect((await keith.repos.commitments.get(commitments[0]?.id ?? ('' as never)))?.status).toBe(
        'fulfilled',
      )
      const task = await keith.repos.tasks.get(taskId)
      expect(task?.status).toBe('completed')
      expect(task?.detail).toBe(RESULT)

      // The task ran with the background model, its goal as the only message and no thread history.
      expect(researcher.requests[0]?.messages).toEqual([{ role: 'user', content: GOAL }])

      // The delivery turn replayed the whole conversation in order, tool step before its reply.
      expect(chat.requests[3]?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
        'user:Keith, research venue options for the Expo.',
        'assistant:',
        `tool:${chat.requests[1]?.messages.at(-1)?.content}`,
        "assistant:I'll get on it, sir.",
        "user:By the way, what's on my calendar?",
        'assistant:Nothing until three, sir.',
      ])

      // The thread history reads naturally, and the report is stored as a proactive message.
      const page = await keith.repos.messages.page({ threadId, limit: 20, roles: ['user', 'assistant'] })
      const visible = page.messages.filter(
        (m) => m.role === 'user' || (m.role === 'assistant' && m.toolCalls === null),
      )
      expect(visible.map((m) => [m.role, m.content])).toEqual([
        ['user', 'Keith, research venue options for the Expo.'],
        ['assistant', "I'll get on it, sir."],
        ['user', "By the way, what's on my calendar?"],
        ['assistant', 'Nothing until three, sir.'],
        ['assistant', `Sir, the venue shortlist is ready. ${RESULT}`],
      ])
    },
    TEST_TIMEOUT_MS,
  )
})
