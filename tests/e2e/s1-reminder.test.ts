// S-1 with reminders (P4-I2): on day 1 Tony asks for a reminder at 09:00 the next day (`at` without
// an offset, read in `mind.timezone`). The core restarts overnight. On day 2 the reminder arrives on
// time as an unsolicited message while Tony is present, or, when he arrives later with
// `briefing = "auto"`, inside the briefing, whose context offers the `morning_briefing` skill.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ReminderId } from '../../packages/protocol/src/index.ts'
import type { LlmRequest } from '../../packages/sdk/src/index.ts'
import { type FakeClock, fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import {
  addPerson,
  connectNode,
  createHome,
  type E2eConfig,
  type E2eHome,
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

/** UTC+7 all year (no DST), so 09:00 there is 02:00Z. */
const TIMEZONE = 'Asia/Jakarta'
const OFFSET = '+07:00'
const TEXT = 'Pick up Maria at the airport'
const ASK = 'Remind me at 9 tomorrow morning to pick up Maria at the airport.'
const SET_REPLY = 'I will remind you at 09:00 tomorrow, sir.'
const DELIVERED = `Sir, it is 09:00: ${TEXT.toLowerCase()}.`
const TICK_MS = 30_000
const HINT = 'If the skills index lists `morning_briefing`, load it first.'

/** The date (YYYY-MM-DD) in `TIMEZONE` at `instant`. */
function dateIn(instant: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, dateStyle: 'short' }).format(instant)
}

/** Tomorrow's date in `TIMEZONE`, as `reminder.set`'s `at` expects it. */
function tomorrow(now: number): string {
  return dateIn(now + 24 * 60 * 60_000)
}

function stopLater(keith: Keith) {
  cleanups.push(() => keith.stop())
}

/** A utility model that finds nothing, in case a tick reflects the thread. */
function quietUtility() {
  return { llm: scriptedLlm([], fakeText('{"facts":[],"notes":[]}')) }
}

/** Replies with the reminder when it is in the turn's context (the deliveries section). */
function deliverReminder(req: LlmRequest) {
  return fakeText(systemOf(req).includes(`(reminder) ${TEXT}`) ? DELIVERED : 'Nothing to report.')
}

/**
 * Day 1 in the evening: Tony asks, the model calls `reminder.set` with a wall-clock `at` for 09:00
 * tomorrow. Returns the due instant; the core is stopped afterwards.
 */
async function day1(
  home: E2eHome,
  clock: FakeClock,
): Promise<{ tony: E2ePerson; dueAt: number; reminderId: ReminderId }> {
  const at = `${tomorrow(clock.now())}T09:00`
  const dueAt = Date.parse(`${at}:00${OFFSET}`)
  const chat = scriptedLlm([[fakeToolCall('reminder.set', { text: TEXT, at })], fakeText(SET_REPLY)])
  const { keith } = await startKeith({
    home,
    clock,
    provider: scriptedProvider({ chat: { llm: chat }, utility: quietUtility() }),
  })
  stopLater(keith)
  const tony = await addPerson(keith, clock, { name: 'Tony', tier: 'owner' })
  const node = await connectNode(keith, tony)
  cleanups.push(() => node.close())
  const { threadId } = await node.openMain()
  node.say(threadId, ASK)
  expect((await node.reply(threadId)).content).toBe(SET_REPLY)
  await keith.threads.idle()

  const pending = await keith.repos.reminders.listPending(tony.id)
  expect(pending.map((r) => [r.text, r.dueAt, r.status, r.threadId])).toEqual([
    [TEXT, dueAt, 'pending', threadId],
  ])
  const toolRow = chat.requests[1]?.messages.find((m) => m.role === 'tool')
  expect(toolRow?.content).toContain(`Reminder ${pending[0]?.id} set for`)

  const [reminder] = pending
  if (!reminder) throw new Error('no reminder stored')
  await keith.stop()
  await node.close()
  return { tony, dueAt, reminderId: reminder.id }
}

async function newHome(c: E2eConfig): Promise<{ home: E2eHome; clock: FakeClock }> {
  const home = await createHome(e2eConfig({ timezone: TIMEZONE, ...c }))
  cleanups.push(() => home.remove())
  return { home, clock: e2eClock() }
}

describe('S-1 (phase 4): a reminder set yesterday arrives on time', () => {
  test(
    'Tony is present at 09:00: after a restart overnight, the next tick delivers the reminder unsolicited',
    async () => {
      const { home, clock } = await newHome({})
      const { tony, dueAt, reminderId } = await day1(home, clock)

      // Overnight restart; Tony is back at 08:55 and says good morning (nothing is pending yet).
      clock.advance(dueAt - 5 * 60_000 - clock.now())
      const chat = scriptedLlm([fakeText('Good morning, sir.'), deliverReminder])
      const { keith } = await startKeith({
        home,
        clock,
        provider: scriptedProvider({ chat: { llm: chat }, utility: quietUtility() }),
      })
      stopLater(keith)
      const node = await connectNode(keith, tony)
      cleanups.push(() => node.close())
      const { threadId } = await node.openMain()
      node.say(threadId, 'Good morning, Keith.')
      expect((await node.reply(threadId)).content).toBe('Good morning, sir.')
      await keith.threads.idle()

      // A tick just before 09:00 fires nothing.
      clock.advance(dueAt - 1_000 - clock.now())
      tick(keith, clock)
      await keith.events.idle()
      await keith.threads.idle()
      expect((await keith.repos.reminders.listPending(tony.id)).length).toBe(1)
      expect(chat.calls).toBe(1)

      // 09:00 plus one tick: the reminder becomes a high-urgency delivery, delivered unsolicited.
      clock.advance(dueAt + TICK_MS - clock.now())
      const enqueued = nextEvent(keith, 'delivery.enqueued', (d) => d.kind === 'reminder')
      const delivered = nextEvent(keith, 'delivery.delivered', (d) => d.threadId === threadId)
      tick(keith, clock)
      const item = await enqueued
      expect(item).toMatchObject({ threadId, kind: 'reminder', urgency: 'high' })
      const started = await node.next('message.started', (f) => f.data.proactive)
      const message = await node.reply(threadId)
      expect(message.content).toBe(DELIVERED)
      expect(message.id).toBe(started.data.messageId)
      expect((await delivered).deliveryId).toBe(item.deliveryId)
      expect(systemOf(chat.requests[1])).toContain(`(reminder) ${TEXT}`)

      expect(await keith.repos.reminders.get(reminderId)).toMatchObject({
        status: 'fired',
        deliveryId: item.deliveryId,
      })
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'briefing = "auto": Tony arrives after 09:00 and the briefing includes the reminder and offers morning_briefing',
    async () => {
      const { home, clock } = await newHome({ briefing: 'auto' })
      const { tony, dueAt, reminderId } = await day1(home, clock)

      // Overnight restart; at 09:00 plus one tick the reminder fires while nobody is attached.
      clock.advance(dueAt + TICK_MS - clock.now())
      const chat = scriptedLlm([
        [fakeToolCall('skill.load', { name: 'morning_briefing' })],
        (req) => {
          const system = systemOf(req)
          return fakeText(
            system.includes(`(reminder) ${TEXT}`) ? `Good morning, sir. ${DELIVERED}` : 'Good morning, sir.',
          )
        },
      ])
      const { keith } = await startKeith({
        home,
        clock,
        provider: scriptedProvider({ chat: { llm: chat }, utility: quietUtility() }),
      })
      stopLater(keith)
      const enqueued = nextEvent(keith, 'delivery.enqueued', (d) => d.kind === 'reminder')
      tick(keith, clock)
      const item = await enqueued
      expect(item).toMatchObject({ kind: 'reminder', urgency: 'high' })
      await keith.events.idle()
      expect(chat.calls).toBe(0)
      expect(await keith.repos.reminders.get(reminderId)).toMatchObject({ status: 'fired' })

      // Tony arrives at 09:30: the briefing turn runs on its own and carries the reminder.
      clock.advance(30 * 60_000)
      const delivered = nextEvent(keith, 'delivery.delivered', (d) => d.deliveryId === item.deliveryId)
      const node = await connectNode(keith, tony)
      cleanups.push(() => node.close())
      const { threadId } = await node.openMain()
      const started = await node.next('message.started', (f) => f.data.proactive)
      const briefing = await node.reply(threadId)
      expect(briefing.id).toBe(started.data.messageId)
      expect(briefing.content).toBe(`Good morning, sir. ${DELIVERED}`)
      expect((await delivered).threadId).toBe(threadId)

      const system = systemOf(chat.requests[0])
      expect(system).toContain(`(reminder) ${TEXT}`)
      expect(system).toContain(HINT)
      expect(system).toContain('- morning_briefing: ')
      const loaded = chat.requests[1]?.messages.at(-1)
      expect(loaded?.role).toBe('tool')
      expect(loaded?.content).toContain('# Morning briefing')
    },
    TEST_TIMEOUT_MS,
  )
})
