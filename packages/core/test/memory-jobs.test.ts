// Phase 4 integration (P4-I1): reflection and thread summaries on the real core, with the real
// storage (`listForReflection`, `range`, `setReflectedThrough`, `setSummary`), a scripted
// `fake:chat` for turns and a separate `fake:utility` for the memory jobs.

import { afterEach, describe, expect, test } from 'bun:test'
import { createFakeLlm, createFakeLlmPlugin, fakeText } from '@keith/sdk/testing'
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
  testClock,
  tick,
  wsUrl,
} from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function start(fake: SplitFake, extra = '') {
  const home = await createTestHome(splitModelConfig(extra))
  cleanups.push(() => home.remove())
  const clock = testClock()
  const owner = await createOwner(home.dir, clock)
  const log = quietLogger(clock)
  const keith = await bootstrap({
    home: home.dir,
    env: {},
    plugins: [createFakeLlmPlugin(fake)],
    clock,
    log,
  })
  cleanups.push(() => keith.stop())
  return { keith, clock, owner, log }
}

async function openMain(keith: Keith): Promise<{ client: TestClient; threadId: ThreadId }> {
  const client = await connect(wsUrl(keith.url, await login(keith.url)))
  cleanups.push(() => client.close())
  await client.hello()
  client.send('thread.open', {})
  const opened = await client.next('thread.opened')
  return { client, threadId: (opened.data.thread as { id: ThreadId }).id }
}

async function say(keith: Keith, client: TestClient, threadId: ThreadId, text: string): Promise<void> {
  client.send('input.text', { threadId, text })
  await client.next('message.completed')
  await keith.threads.idle()
}

function allMemories(keith: Keith, owner: PersonId, threadId: ThreadId) {
  return keith.repos.memories.list({
    allowHousehold: true,
    allowOwner: true,
    subjectPersonId: owner,
    threadIds: [threadId],
  })
}

describe('reflection on the real core', () => {
  test('an idle thread becomes an inferred memory after a tick', async () => {
    const fake = createSplitFake(createFakeLlm([fakeText('Nice, say hi to her.')]))
    const { keith, clock, owner } = await start(fake)
    const { client, threadId } = await openMain(keith)
    await say(keith, client, threadId, 'My sister Pepper visits every May.')

    // Not idle yet: a tick lists nothing and calls no model.
    tick(keith.events, clock)
    await keith.events.idle()
    expect(fake.utility.calls).toBe(0)

    fake.utility.push(
      fakeText(
        JSON.stringify({ facts: [{ content: "Tony's sister Pepper visits every May", about: owner }] }),
      ),
    )
    clock.advance((20 + 1) * 60_000)
    const reflected = nextEvent(keith.events, 'memory.reflected', (d) => d.threadId === threadId)
    tick(keith.events, clock)
    const event = await reflected

    // One utility extract call holding the thread's messages; no merge call (nothing matched).
    expect(fake.utility.calls).toBe(1)
    const input = fake.utility.requests[0]?.messages.map((m) => m.content).join('\n') ?? ''
    expect(input).toContain('My sister Pepper visits every May.')
    expect(input).toContain('Nice, say hi to her.')
    expect(fake.utility.requests[0]?.tools ?? []).toEqual([])
    expect(fake.chat.calls).toBe(1)

    expect(event).toMatchObject({ threadId, throughSeq: 2, written: 1, merged: 0 })
    const memories = await allMemories(keith, owner, threadId)
    expect(memories.map((m) => [m.content, m.source, m.subjectPersonId])).toEqual([
      ["Tony's sister Pepper visits every May", 'inferred', owner],
    ])
    expect((await keith.repos.threads.get(threadId))?.reflectedThroughSeq).toBe(2)

    // The cursor holds: the next tick finds nothing new.
    clock.advance(60_000)
    tick(keith.events, clock)
    await keith.events.idle()
    await Bun.sleep(20)
    expect(fake.utility.calls).toBe(1)
  })
})

describe('thread summaries on the real core', () => {
  test('a thread longer than recentMessages + minMessages gets a summary the next turn sees', async () => {
    const chat = createFakeLlm([], { fallback: (_req, call) => fakeText(`Reply ${call + 1}.`) })
    const utility = createFakeLlm([fakeText('Tony planned the garden: tomatoes in May, basil in June.')], {
      fallback: fakeText('Later summary.'),
    })
    const fake = createSplitFake(chat, utility)
    const { keith } = await start(
      fake,
      '\n[mind.context]\nrecentMessages = 4\n\n[memory.summary]\nminMessages = 2\n',
    )
    const { client, threadId } = await openMain(keith)

    await say(keith, client, threadId, 'Tomatoes go in in May.')
    await say(keith, client, threadId, 'Basil in June.')
    expect(utility.calls).toBe(0)
    // Six rows, four in the window: two left it, which is minMessages.
    const summarized = nextEvent(keith.events, 'thread.summarized', (d) => d.threadId === threadId)
    await say(keith, client, threadId, 'And the peppers?')
    expect(await summarized).toEqual({ threadId, throughSeq: 2 })

    expect(utility.calls).toBe(1)
    expect(utility.requests[0]?.messages.map((m) => m.content).join('\n')).toContain('Tomatoes go in in May.')
    const thread = await keith.repos.threads.get(threadId)
    expect(thread?.summary).toBe('Tony planned the garden: tomatoes in May, basil in June.')
    expect(thread?.summaryThroughSeq).toBe(2)

    await say(keith, client, threadId, 'What did we plan?')
    const last = chat.requests.at(-1)
    expect(last?.system).toContain(
      '# Earlier in this thread\nTony planned the garden: tomatoes in May, basil in June.',
    )
    // The window: the rows after the cursor (3..7), not the summarized ones.
    const contents = last?.messages.map((m) => m.content) ?? []
    expect(contents).not.toContain('Tomatoes go in in May.')
    expect(contents).toContain('Basil in June.')
    expect(contents.at(-1)).toBe('What did we plan?')
  })
})
