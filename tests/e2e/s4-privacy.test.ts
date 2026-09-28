// S-4, phase 5 (P5-I2): two people, two conversations, one mind, and privacy between them. Tony
// (owner) tells Keith a private fact, which his model stores with `memory.remember` (`subject`), and
// starts a background task. Pepper (member) and Happy (guest), signed up through invite links, ask
// about it in their own threads: nothing of the fact or the task's goal reaches any request of
// theirs (I-3, I-4). Pepper's digest counts the task, Happy's digest is counts only, and Happy's
// tool list has no `member` tools (ADR-0017).

import { afterEach, describe, expect, test } from 'bun:test'
import type { LlmRequest } from '../../packages/sdk/src/index.ts'
import { fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import {
  addPerson,
  afterTool,
  connectNode,
  createGate,
  createHome,
  digestOf,
  e2eClock,
  e2eConfig,
  greet,
  type Keith,
  lastUser,
  nextEvent,
  requestText,
  routedChat,
  scriptedLlm,
  scriptedProvider,
  settle,
  signUp,
  startKeith,
  systemOf,
  TEST_TIMEOUT_MS,
  toolResult,
} from './harness.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const SECRET_WORD = 'Malibu'
const RAW = "Keep this between us: I'm buying the Malibu house next door as a surprise for Pepper."
const FACT = 'Tony is secretly buying the Malibu house next door as a surprise for Pepper'
const GOAL = 'Find the owner of the Malibu house next door and a fair price for it'
const RESULT = 'The Malibu house next door belongs to a retired pilot; a fair price is 14 million.'
const TONY_CONFIRMS = 'Your secret is safe with me, sir. I am looking into the house.'

const PEPPER_ASKS = 'What is Tony planning? Did he tell you anything?'
const PEPPER_ANSWER = 'I cannot tell you that, Pepper.'
const HAPPY_ASKS = 'Is the boss up to something?'
const HAPPY_ANSWER = 'Nothing I can share, Happy.'
const TONY_ASKS = 'What did I tell you earlier?'

/** A person's card line in a direct thread's context: which person a request was built for. */
const cardOf = (name: string, tier: string) => `- ${name} (tier: ${tier})`

/** Tools that need tier `member` (ADR-0017 and the phase 1–4 specs). */
function memberTools(names: string[]): string[] {
  return names.filter(
    (n) =>
      n.startsWith('task.') ||
      n.startsWith('reminder.') ||
      n === 'thread.start_group' ||
      n === 'thread.invite',
  )
}

const toolNames = (req: LlmRequest | undefined) => (req?.tools ?? []).map((t) => t.name)

function stopLater(keith: Keith) {
  cleanups.push(() => keith.stop())
}

describe('S-4 (phase 5): two people, two conversations, one mind', () => {
  test(
    "I-3 and I-4: Tony's private fact and task never reach Pepper's or Happy's requests; the guest gets counts and no member tools",
    async () => {
      const home = await createHome(e2eConfig())
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const chat = routedChat()
      // The research task waits at its first model call until the end, so it is running while
      // Pepper and Happy talk to Keith.
      const research = createGate()
      const researcher = scriptedLlm([], fakeText(RESULT))
      const utility = scriptedLlm()
      const { keith } = await startKeith({
        home,
        clock,
        provider: scriptedProvider({
          chat: { llm: chat },
          researcher: { llm: researcher, before: () => research.promise },
          utility: { llm: utility },
        }),
      })
      stopLater(keith)
      cleanups.push(() => research.open())

      // 1. Tony (owner) on his laptop; Pepper (member) and Happy (guest) sign up with invite links.
      const tony = await addPerson(keith, clock, {
        name: 'Tony',
        tier: 'owner',
        tone: 'Dry wit. Calls him sir.',
      })
      const laptop = await connectNode(keith, tony)
      cleanups.push(() => laptop.close())
      const tonyMain = (await laptop.openMain()).threadId

      const pepper = await signUp(keith, home, clock, { name: 'Pepper', tone: 'Warm and direct.' })
      const pepperPhone = await connectNode(keith, pepper, { token: pepper.token })
      cleanups.push(() => pepperPhone.close())
      const pepperMain = (await pepperPhone.openMain()).threadId
      await greet(pepperPhone, pepperMain)

      const happy = await signUp(keith, home, clock, { name: 'Happy', tier: 'guest', tone: 'Friendly.' })
      const happyPhone = await connectNode(keith, happy, { token: happy.token })
      cleanups.push(() => happyPhone.close())
      const happyMain = (await happyPhone.openMain()).threadId
      await greet(happyPhone, happyMain)
      expect(new Set([tonyMain, pepperMain, happyMain]).size).toBe(3)

      // 2. Tony's private fact: his model remembers it (subject, pinned) and starts a background task.
      chat.route(
        {
          name: 'tony tells',
          when: (r) => lastUser(r) === RAW,
          reply: () => [
            fakeToolCall('memory.remember', { content: FACT, pinned: true }),
            fakeToolCall('task.start', {
              goal: GOAL,
              notify: 'when-done',
              promise: 'I will tell you what I find about the house.',
            }),
          ],
        },
        {
          name: 'tony confirms',
          when: (r) => afterTool(r, 'task.start') && toolResult(r).startsWith('Started task'),
          reply: () => fakeText(TONY_CONFIRMS),
        },
      )
      const started = nextEvent(keith, 'task.started', (d) => d.personId === tony.id)
      laptop.say(tonyMain, RAW)
      expect((await laptop.reply(tonyMain)).content).toBe(TONY_CONFIRMS)
      const { taskId } = await started
      await settle(keith)
      const stored = await keith.repos.memories.list({
        allowHousehold: true,
        allowOwner: true,
        subjectPersonId: tony.id,
        threadIds: [],
      })
      expect(stored.map((m) => [m.content, m.visibility, m.subjectPersonId, m.pinned])).toEqual([
        [FACT, 'subject', tony.id, true],
      ])
      expect((await keith.repos.tasks.get(taskId))?.status).toBe('running')
      const chatCallsBefore = chat.calls

      // 3. Pepper asks in her own thread. Her model even tries memory.recall: nothing is found.
      chat.route(
        {
          name: 'pepper asks',
          when: (r) => lastUser(r) === PEPPER_ASKS,
          reply: () => [fakeToolCall('memory.recall', { query: 'Tony house surprise' })],
        },
        {
          name: 'pepper answer',
          when: (r) => afterTool(r, 'memory.recall') && systemOf(r).includes(cardOf('Pepper', 'member')),
          reply: () => fakeText(PEPPER_ANSWER),
        },
      )
      pepperPhone.say(pepperMain, PEPPER_ASKS)
      expect((await pepperPhone.reply(pepperMain)).content).toBe(PEPPER_ANSWER)
      await settle(keith)

      // Happy (guest) asks in his own thread, and also tries memory.recall.
      chat.route(
        {
          name: 'happy asks',
          when: (r) => lastUser(r) === HAPPY_ASKS,
          reply: () => [fakeToolCall('memory.recall', { query: 'Tony house next door' })],
        },
        {
          name: 'happy answer',
          when: (r) => afterTool(r, 'memory.recall') && systemOf(r).includes(cardOf('Happy', 'guest')),
          reply: () => fakeText(HAPPY_ANSWER),
        },
      )
      happyPhone.say(happyMain, HAPPY_ASKS)
      expect((await happyPhone.reply(happyMain)).content).toBe(HAPPY_ANSWER)
      await settle(keith)
      expect(chat.calls).toBe(chatCallsBefore + 4)

      // No request built for Pepper or Happy holds the fact, Tony's words or the task's goal:
      // not the system prompt, not a message, not a tool result (I-3, I-4).
      const pepperReqs = chat.requests.filter((r) => systemOf(r).includes(cardOf('Pepper', 'member')))
      const happyReqs = chat.requests.filter((r) => systemOf(r).includes(cardOf('Happy', 'guest')))
      expect(pepperReqs).toHaveLength(3) // greeting, question, after recall
      expect(happyReqs).toHaveLength(3)
      for (const req of [...pepperReqs, ...happyReqs]) {
        const text = requestText(req)
        for (const secret of [SECRET_WORD, FACT, RAW, GOAL, TONY_CONFIRMS]) expect(text).not.toContain(secret)
        expect(systemOf(req)).not.toContain(cardOf('Tony', 'owner'))
      }
      expect(toolResult(pepperReqs[2] as LlmRequest)).toBe('No matching memories.')
      expect(toolResult(happyReqs[2] as LlmRequest)).toBe('No matching memories.')

      // Pepper's digest mentions the task as a count only; Happy's digest is counts only.
      expect(digestOf(pepperReqs[1])).toEqual(['- Busy with 1 private background task for someone else.'])
      expect(digestOf(happyReqs[1])).toEqual([
        '- Also busy with 0 other conversations and 1 background task.',
      ])

      // 4. Happy's tool list has no member tools; Pepper's has them.
      expect(memberTools(toolNames(happyReqs[1]))).toEqual([])
      expect(toolNames(happyReqs[1])).toEqual(
        expect.arrayContaining(['memory.recall', 'relay.send', 'thread.join']),
      )
      expect(toolNames(pepperReqs[1])).toEqual(
        expect.arrayContaining(['task.start', 'reminder.set', 'thread.start_group', 'thread.invite']),
      )

      // The same mind still knows: Tony's own next turn has the pinned fact and the task in detail.
      let tonyReq: LlmRequest | undefined
      chat.route({
        name: 'tony asks',
        when: (r) => lastUser(r) === TONY_ASKS,
        reply: (r) => {
          tonyReq = r
          return fakeText('The house, sir.')
        },
      })
      laptop.say(tonyMain, TONY_ASKS)
      await laptop.reply(tonyMain)
      expect(systemOf(tonyReq)).toContain(FACT)
      expect(digestOf(tonyReq)).toEqual([`- Working on a background task for you: ${GOAL}`])

      // The task finishes and reports to Tony only.
      chat.route({
        name: 'tony hears',
        when: (r) => lastUser(r) === null && systemOf(r).includes(RESULT),
        reply: () => fakeText(`Sir, about the house: ${RESULT}`),
      })
      const completed = nextEvent(keith, 'task.completed', (d) => d.taskId === taskId)
      research.open()
      await completed
      const report = await laptop.next(
        'message.completed',
        (f) => f.data.message.threadId === tonyMain && f.data.message.content.includes(RESULT),
      )
      expect(report.data.message.role).toBe('assistant')
      await settle(keith)

      // Pepper's and Happy's nodes never got a frame about any of it.
      for (const node of [pepperPhone, happyPhone]) {
        const seen = JSON.stringify(node.frames)
        for (const secret of [SECRET_WORD, GOAL, RESULT, tonyMain]) expect(seen).not.toContain(secret)
      }
      expect(chat.unmatched.map((r) => lastUser(r))).toEqual([])
      expect(utility.calls).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )
})
