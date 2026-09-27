// Phase 4 integration (P4-I1): `reminder.set` through a real turn, fired by a scheduler tick as a
// proactive delivery turn, also across a restart.

import { afterEach, describe, expect, test } from 'bun:test'
import type { FakeClock } from '@keith/sdk/testing'
import { createFakeLlm, createFakeLlmPlugin, fakeText, fakeToolCall } from '@keith/sdk/testing'
import { bootstrap, type Keith } from '../src/bootstrap.ts'
import { connect, type TestClient } from '../src/server/test-fakes.ts'
import type { PersonId, ThreadId } from '../src/shared/types.ts'
import {
  createOwner,
  createSplitFake,
  createTestHome,
  login,
  nextEvent,
  quietLogger,
  type SplitFake,
  splitModelConfig,
  type TestHome,
  testClock,
  tick,
  wsUrl,
} from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function newHome(): Promise<{ home: TestHome; clock: FakeClock; owner: PersonId }> {
  const home = await createTestHome(splitModelConfig())
  cleanups.push(() => home.remove())
  const clock = testClock()
  const owner = await createOwner(home.dir, clock)
  return { home, clock, owner }
}

async function start(home: TestHome, clock: FakeClock, fake: SplitFake): Promise<Keith> {
  const keith = await bootstrap({
    home: home.dir,
    env: {},
    plugins: [createFakeLlmPlugin(fake)],
    clock,
    log: quietLogger(clock),
  })
  cleanups.push(() => keith.stop())
  return keith
}

async function openMain(keith: Keith): Promise<{ client: TestClient; threadId: ThreadId }> {
  const client = await connect(wsUrl(keith.url, await login(keith.url)))
  cleanups.push(() => client.close())
  await client.hello()
  client.send('thread.open', {})
  const opened = await client.next('thread.opened')
  return { client, threadId: (opened.data.thread as { id: ThreadId }).id }
}

/** A chat script: the model sets a reminder in a minute, confirms, then phrases the delivery. */
function reminderChat() {
  return createFakeLlm([
    [fakeToolCall('reminder.set', { text: 'Call Pepper', inMinutes: 1 })],
    fakeText('Reminder set.'),
    fakeText('Time to call Pepper!'),
  ])
}

async function setReminder(keith: Keith, client: TestClient, threadId: ThreadId, owner: PersonId) {
  client.send('input.text', { threadId, text: 'Remind me to call Pepper in a minute.' })
  await client.next('message.completed')
  await keith.threads.idle()
  return keith.repos.reminders.listPending(owner)
}

/** Whether the message began with a `proactive: true` `message.started` (I-11). */
function isProactive(client: TestClient, messageId: string): boolean {
  return client.frames.some(
    (f) => f.type === 'message.started' && f.data.messageId === messageId && f.data.proactive === true,
  )
}

describe('reminders on the real core', () => {
  test('reminder.set, then a tick past the due time delivers it proactively', async () => {
    const { home, clock, owner } = await newHome()
    const fake = createSplitFake(reminderChat())
    const keith = await start(home, clock, fake)
    const { client, threadId } = await openMain(keith)

    const pending = await setReminder(keith, client, threadId, owner)
    expect(pending.map((r) => [r.text, r.dueAt, r.threadId])).toEqual([
      ['Call Pepper', clock.now() + 60_000, threadId],
    ])
    const toolRow = fake.chat.requests[1]?.messages.find((m) => m.role === 'tool')
    expect(toolRow?.content).toContain(`Reminder ${pending[0]?.id} set for`)

    // Not due yet.
    clock.advance(30_000)
    tick(keith.events, clock)
    await keith.events.idle()
    expect(fake.chat.calls).toBe(2)

    clock.advance(31_000)
    const enqueued = nextEvent(keith.events, 'delivery.enqueued', (d) => d.kind === 'reminder')
    const delivered = nextEvent(keith.events, 'delivery.delivered', (d) => d.threadId === threadId)
    tick(keith.events, clock)
    const item = await enqueued
    expect(item).toMatchObject({ threadId, kind: 'reminder', urgency: 'high' })
    const done = await delivered
    expect(done.deliveryId).toBe(item.deliveryId)

    const completed = await client.next('message.completed')
    const message = completed.data.message as { id: string; content: string }
    expect(message.content).toBe('Time to call Pepper!')
    expect(done.messageId).toBe(message.id as never)
    expect(isProactive(client, message.id)).toBe(true)
    expect(fake.chat.requests[2]?.system).toContain('(reminder) Call Pepper')

    const [first] = pending
    if (!first) throw new Error('no reminder stored')
    expect(await keith.repos.reminders.get(first.id)).toMatchObject({
      status: 'fired',
      deliveryId: item.deliveryId,
    })
    expect(fake.utility.calls).toBe(0)
  })

  test('a restart between set and due still fires it', async () => {
    const { home, clock, owner } = await newHome()
    const first = await start(home, clock, createSplitFake(reminderChat()))
    const { client, threadId } = await openMain(first)
    const [reminder] = await setReminder(first, client, threadId, owner)
    if (!reminder) throw new Error('no reminder stored')
    client.close()
    await first.stop()

    // Down past the due time.
    clock.advance(5 * 60_000)
    const chat = createFakeLlm([fakeText('You wanted to call Pepper.')])
    const second = await start(home, clock, createSplitFake(chat))
    const delivered = nextEvent(second.events, 'delivery.delivered', (d) => d.threadId === threadId)
    const again = await openMain(second)
    tick(second.events, clock)
    await delivered

    const completed = await again.client.next('message.completed')
    const message = completed.data.message as { id: string; content: string }
    expect(message.content).toBe('You wanted to call Pepper.')
    expect(isProactive(again.client, message.id)).toBe(true)
    expect(chat.requests[0]?.system).toContain('(reminder) Call Pepper')
    expect(await second.repos.reminders.get(reminder.id)).toMatchObject({ status: 'fired' })
  })
})
