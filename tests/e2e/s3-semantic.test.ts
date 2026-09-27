// S-3, phase 4 (P4-I2): a fact stated on day 1 is recalled on day 2 through semantic memory, after
// a core restart, without the raw message in the context. Reflection runs on a scheduler tick with a
// separate scripted utility model; thread summaries are off, so only semantic memory can carry the
// fact. A member in her own thread can't recall it (I-4).

import { afterEach, describe, expect, test } from 'bun:test'
import type { LlmRequest } from '../../packages/sdk/src/index.ts'
import { fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import {
  addPerson,
  connectNode,
  createHome,
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
  tick,
} from './harness.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const RAW = 'By the way, my sister Maria lands in Surabaya on Friday.'
const FACT = "Tony's sister Maria arrives in Surabaya on Friday"
const SMALL_TALK = ['How is the weather in the lab?', 'Run the suit diagnostics.', 'Thanks, that is all.']
const QUESTION = 'When does my sister arrive?'
const RECALL_QUERY = 'sister arrive'
const IDLE_MINUTES = 1
const HOURS_20 = 20 * 60 * 60_000

/** The day-2 answer, from the recall result the model got back. */
function answerFromRecall(req: LlmRequest) {
  const result = req.messages.at(-1)
  const found = result?.role === 'tool' && result.content.includes(FACT)
  return fakeText(found ? 'Maria arrives in Surabaya on Friday, sir.' : 'I do not know.')
}

/** Every text the model saw in a request: the system prompt and each message. */
function allTextOf(req: LlmRequest | undefined): string[] {
  return [systemOf(req), ...(req?.messages ?? []).map((m) => m.content)]
}

function stopLater(keith: Keith) {
  cleanups.push(() => keith.stop())
}

async function tonyMemories(keith: Keith, tony: E2ePerson) {
  return keith.repos.memories.list({
    allowHousehold: true,
    allowOwner: true,
    subjectPersonId: tony.id,
    threadIds: [],
  })
}

describe('S-3 (phase 4): remembered the next day through semantic memory', () => {
  test(
    "a day-1 fact is reflected into memory and recalled on day 2 after a restart; Pepper can't recall it",
    async () => {
      const home = await createHome(
        e2eConfig({
          recentMessages: 4,
          summary: { enabled: false },
          reflect: { idleMinutes: IDLE_MINUTES },
        }),
      )
      cleanups.push(() => home.remove())
      const clock = e2eClock()

      // Day 1: the fact, then small talk that pushes it out of the 4-message window.
      let tony: E2ePerson | undefined
      const utility = scriptedLlm(
        [() => fakeText(JSON.stringify({ facts: [{ content: FACT, about: tony?.id ?? null }], notes: [] }))],
        fakeText('{"facts":[],"notes":[]}'),
      )
      const day1Chat = scriptedLlm([
        fakeText('Noted, sir. Shall I arrange a car?'),
        fakeText('Clear skies.'),
        fakeText('Diagnostics are green.'),
        fakeText('Very well, sir.'),
      ])
      const day1 = await startKeith({
        home,
        clock,
        provider: scriptedProvider({ chat: { llm: day1Chat }, utility: { llm: utility } }),
      })
      stopLater(day1.keith)
      tony = await addPerson(day1.keith, clock, { name: 'Tony', tier: 'owner' })
      const evening = await connectNode(day1.keith, tony)
      cleanups.push(() => evening.close())
      const { threadId } = await evening.openMain()
      for (const text of [RAW, ...SMALL_TALK]) {
        evening.say(threadId, text)
        await evening.reply(threadId)
        clock.advance(10_000)
      }
      await day1.keith.threads.idle()
      // The last day-1 turn's window no longer holds the fact.
      expect(allTextOf(day1Chat.requests.at(-1)).some((t) => t.includes(RAW))).toBe(false)
      expect(utility.calls).toBe(0)

      // Reflection: not before idleMinutes, then on the next tick.
      tick(day1.keith, clock)
      await day1.keith.events.idle()
      expect(utility.calls).toBe(0)
      clock.advance((IDLE_MINUTES + 1) * 60_000)
      const reflected = nextEvent(day1.keith, 'memory.reflected', (d) => d.threadId === threadId)
      tick(day1.keith, clock)
      expect(await reflected).toMatchObject({ threadId, throughSeq: 8, written: 1, merged: 0 })
      expect(utility.calls).toBe(1)
      const extract = utility.requests[0]
      expect(extract?.tools ?? []).toEqual([])
      expect(allTextOf(extract).join('\n')).toContain(RAW)

      const memories = await tonyMemories(day1.keith, tony)
      expect(memories.map((m) => [m.content, m.visibility, m.source, m.subjectPersonId, m.pinned])).toEqual([
        [FACT, 'subject', 'inferred', tony.id, false],
      ])
      await day1.keith.stop()
      await evening.close()

      // Day 2: a fresh core on the same home, 20 hours later.
      clock.advance(HOURS_20)
      const day2Chat = scriptedLlm([
        [fakeToolCall('memory.recall', { query: RECALL_QUERY })],
        answerFromRecall,
        [fakeToolCall('memory.recall', { query: RECALL_QUERY })],
        answerFromRecall,
      ])
      const day2 = await startKeith({
        home,
        clock,
        provider: scriptedProvider({ chat: { llm: day2Chat }, utility: { llm: utility } }),
      })
      stopLater(day2.keith)
      const morning = await connectNode(day2.keith, tony)
      cleanups.push(() => morning.close())
      expect((await morning.openMain()).threadId).toBe(threadId)
      morning.say(threadId, QUESTION)
      const answer = await morning.reply(threadId)
      expect(answer.content).toBe('Maria arrives in Surabaya on Friday, sir.')
      await day2.keith.threads.idle()

      // The day-2 context holds none of the day-1 raw message: not in the system prompt, not in any message.
      const first = day2Chat.requests[0]
      for (const text of allTextOf(first)) expect(text).not.toContain(RAW)
      expect(first?.messages.at(-1)).toEqual({ role: 'user', content: QUESTION })
      expect(first?.tools?.map((t) => t.name)).toContain('memory.recall')
      // The recall result the model got back holds the reflected fact.
      const recalled = day2Chat.requests[1]?.messages.at(-1)
      expect(recalled?.role).toBe('tool')
      expect(recalled?.content).toContain(FACT)
      // The final reply is stored.
      const stored = await day2.keith.repos.messages.page({ threadId, limit: 1 })
      expect(stored.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Maria arrives in Surabaya on Friday, sir.',
      })

      // Privacy (I-4): Pepper asks the same question in her own thread and recalls nothing.
      const pepper = await addPerson(day2.keith, clock, { name: 'Pepper', tier: 'member' })
      const phone = await connectNode(day2.keith, pepper)
      cleanups.push(() => phone.close())
      const own = await phone.openMain()
      expect(own.threadId).not.toBe(threadId)
      phone.say(own.threadId, QUESTION)
      expect((await phone.reply(own.threadId)).content).toBe('I do not know.')
      const pepperResult = day2Chat.requests[3]?.messages.at(-1)
      expect(pepperResult?.role).toBe('tool')
      expect(pepperResult?.content).toBe('No matching memories.')
      for (const req of day2Chat.requests.slice(2)) {
        for (const text of allTextOf(req)) {
          expect(text).not.toContain(FACT)
          expect(text).not.toContain(RAW)
        }
      }
      // Nothing on day 2 needed the utility model.
      expect(utility.calls).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )
})
