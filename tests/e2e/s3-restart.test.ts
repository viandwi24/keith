import { afterEach, describe, expect, test } from 'bun:test'
import type { LlmRequest } from '../../packages/sdk/src/index.ts'
import { fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import {
  addPerson,
  connectNode,
  createGate,
  createHome,
  e2eClock,
  eventually,
  type Keith,
  nextEvent,
  scriptedLlm,
  scriptedProvider,
  startKeith,
  systemOf,
  TEST_TIMEOUT_MS,
  transcriptOf,
} from './harness.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const GOAL = 'Research venue options for the Stark Expo'
const RESULT = 'Venue shortlist: Flushing Meadows, Javits Center, Pier 94.'
const ASK = 'Keith, research venue options for the Expo.'
const NEXT_DAY = 'What did you find yesterday about the venues?'
const HOURS_12 = 12 * 60 * 60_000

function report(req: LlmRequest) {
  return fakeText(systemOf(req).includes(RESULT) ? `Sir, the shortlist is ready. ${RESULT}` : 'Nothing yet.')
}

/** Stops `keith` once, even when the test also stops it by hand. */
function stopLater(keith: Keith) {
  cleanups.push(() => keith.stop())
}

describe('S-3: remembered the next day', () => {
  test(
    'S-3: history and the task result survive a core restart, and the next turn sees them',
    async () => {
      const home = await createHome()
      cleanups.push(() => home.remove())
      const clock = e2eClock()

      // Day 1: research runs and the report is delivered.
      const day1 = await startKeith({
        home,
        clock,
        provider: scriptedProvider({
          chat: {
            llm: scriptedLlm([
              [fakeToolCall('task.start', { goal: GOAL, notify: 'when-done', promise: 'I will report' })],
              fakeText("I'll get on it, sir."),
              report,
            ]),
          },
          researcher: { llm: scriptedLlm([fakeText(RESULT)]) },
        }),
      })
      stopLater(day1.keith)
      const tony = await addPerson(day1.keith, clock, { name: 'Tony', tier: 'owner' })
      const evening = await connectNode(day1.keith, tony)
      cleanups.push(() => evening.close())
      const { threadId } = await evening.openMain()
      const taskStarted = nextEvent(day1.keith, 'task.started')
      evening.say(threadId, ASK)
      expect((await evening.reply(threadId)).content).toBe("I'll get on it, sir.")
      const { taskId } = await taskStarted
      const proactive = await evening.next('message.started', (f) => f.data.proactive)
      const delivered = await evening.reply(threadId)
      expect(delivered.id).toBe(proactive.data.messageId)
      await day1.keith.threads.idle()
      await day1.keith.stop()

      // The next morning, a fresh core process on the same KEITH_HOME.
      clock.advance(HOURS_12)
      const chat = scriptedLlm([
        [fakeToolCall('task.status', { id: taskId })],
        (req) => fakeText(transcriptOf(req).includes(RESULT) ? `Yesterday I found: ${RESULT}` : 'No idea.'),
      ])
      const day2 = await startKeith({
        home,
        clock,
        provider: scriptedProvider({ chat: { llm: chat }, researcher: { llm: scriptedLlm() } }),
      })
      stopLater(day2.keith)
      const morning = await connectNode(day2.keith, tony)
      cleanups.push(() => morning.close())
      const reopened = await morning.openMain()
      expect(reopened.threadId).toBe(threadId)
      expect(reopened.messages.map((m) => [m.role, m.content])).toEqual([
        ['user', ASK],
        ['assistant', "I'll get on it, sir."],
        ['assistant', `Sir, the shortlist is ready. ${RESULT}`],
      ])
      expect(reopened.messages.at(-1)?.meta?.proactive).toBe(true)

      const task = await day2.keith.repos.tasks.get(taskId)
      expect(task?.status).toBe('completed')
      expect(task?.detail).toBe(RESULT)

      morning.say(threadId, NEXT_DAY)
      const answer = await morning.reply(threadId)
      expect(answer.content).toBe(`Yesterday I found: ${RESULT}`)

      // The first model call of the turn already had yesterday's report in its history...
      const first = chat.requests[0]
      expect(transcriptOf(first)).toContain(`assistant: Sir, the shortlist is ready. ${RESULT}`)
      expect(first?.messages.at(-1)).toEqual({ role: 'user', content: NEXT_DAY })
      // ...and task.status still returns the stored result after the restart.
      const toolResult = chat.requests[1]?.messages.at(-1)
      expect(toolResult?.role).toBe('tool')
      expect(toolResult?.content).toContain(RESULT)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'S-3: a task interrupted by a restart is recovered (attempt 2) and still reports back',
    async () => {
      const home = await createHome()
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const never = createGate()
      cleanups.push(() => never.open())

      const day1 = await startKeith({
        home,
        clock,
        provider: scriptedProvider({
          chat: {
            llm: scriptedLlm([
              [fakeToolCall('task.start', { goal: GOAL, notify: 'when-done', promise: 'I will report' })],
              fakeText("I'll get on it, sir."),
            ]),
          },
          researcher: { llm: scriptedLlm([fakeText('never sent')]), before: () => never.promise },
        }),
      })
      stopLater(day1.keith)
      const tony = await addPerson(day1.keith, clock, { name: 'Tony', tier: 'owner' })
      const node = await connectNode(day1.keith, tony)
      cleanups.push(() => node.close())
      const { threadId } = await node.openMain()
      const taskStarted = nextEvent(day1.keith, 'task.started')
      node.say(threadId, ASK)
      await node.reply(threadId)
      const { taskId } = await taskStarted
      await day1.keith.stop()
      await node.close()

      // Restart shortly after: the task is recovered and completes; Tony is back below the arrival
      // threshold, so the pending report flushes right after the thread opens.
      clock.advance(10_000)
      const day2 = await startKeith({
        home,
        clock,
        provider: scriptedProvider({
          chat: { llm: scriptedLlm([report]) },
          researcher: { llm: scriptedLlm([fakeText(RESULT)]) },
        }),
      })
      stopLater(day2.keith)
      await eventually(async () => (await day2.keith.repos.tasks.get(taskId))?.status === 'completed')
      const task = await day2.keith.repos.tasks.get(taskId)
      expect(task?.attempt).toBe(2)
      expect(task?.detail).toBe(RESULT)

      const back = await connectNode(day2.keith, tony)
      cleanups.push(() => back.close())
      await back.openMain()
      const started = await back.next('message.started')
      expect(started.data.proactive).toBe(true)
      expect((await back.reply(threadId)).content).toBe(`Sir, the shortlist is ready. ${RESULT}`)
    },
    TEST_TIMEOUT_MS,
  )
})
