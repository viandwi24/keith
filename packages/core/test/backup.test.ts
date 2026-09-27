// Phase 4 integration (P4-I1): `keith backup` of a home the real core wrote (a stated memory, an
// inferred one from reflection, a pending reminder), `keith restore` into a new home, and a start
// on the restored home that finds the same state and still fires the reminder.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FakeClock } from '@keith/sdk/testing'
import { createFakeLlm, createFakeLlmPlugin, fakeText, fakeToolCall } from '@keith/sdk/testing'
import { bootstrap, type Keith } from '../src/bootstrap.ts'
import { type CliIo, runCli } from '../src/cli/index.ts'
import { connect } from '../src/server/test-fakes.ts'
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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function start(home: string, clock: FakeClock, fake: SplitFake): Promise<Keith> {
  const keith = await bootstrap({
    home,
    env: {},
    plugins: [createFakeLlmPlugin(fake)],
    clock,
    log: quietLogger(clock),
  })
  cleanups.push(() => keith.stop())
  return keith
}

function io(home: string, clock: FakeClock): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    env: { KEITH_HOME: home },
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    clock,
    lines,
    errors,
  }
}

async function state(keith: Keith, owner: PersonId, threadId: ThreadId) {
  const memories = await keith.repos.memories.list({
    allowHousehold: true,
    allowOwner: true,
    subjectPersonId: owner,
    threadIds: [threadId],
  })
  const thread = await keith.repos.threads.get(threadId)
  return {
    memories: memories.map((m) => [m.id, m.content, m.source]).sort(),
    reminders: (await keith.repos.reminders.listPending(owner)).map((r) => [r.id, r.text, r.dueAt, r.status]),
    messages: (await keith.repos.messages.page({ threadId, limit: 20 })).messages.map((m) => [
      m.role,
      m.content,
    ]),
    reflectedThroughSeq: thread?.reflectedThroughSeq,
  }
}

describe('backup and restore of a home the real core wrote', () => {
  test('restored into a new home, a started Keith has the same memories, cursor and pending reminder', async () => {
    const home = await createTestHome(splitModelConfig())
    cleanups.push(() => home.remove())
    const clock = testClock()
    const owner = await createOwner(home.dir, clock)
    const chat = createFakeLlm([
      [
        fakeToolCall('memory.remember', { content: 'Tony keeps bees' }, 'call_1'),
        fakeToolCall('reminder.set', { text: 'Check the hives', inMinutes: 60 }, 'call_2'),
      ],
      fakeText('Noted, and I will remind you.'),
    ])
    const utility = createFakeLlm([
      fakeText(JSON.stringify({ facts: [{ content: 'Tony has two hives in the garden', about: owner }] })),
      // The merge call: the stated "Tony keeps bees" is a match, but a different fact.
      fakeText(JSON.stringify({ decisions: [{ candidate: 1, action: 'new' }] })),
    ])
    const keith = await start(home.dir, clock, createSplitFake(chat, utility))

    const client = await connect(wsUrl(keith.url, await login(keith.url)))
    cleanups.push(() => client.close())
    await client.hello()
    client.send('thread.open', {})
    const threadId = ((await client.next('thread.opened')).data.thread as { id: ThreadId }).id
    client.send('input.text', {
      threadId,
      text: 'I keep bees, two hives in the garden. Remind me to check them in an hour.',
    })
    await client.next('message.completed')
    await keith.threads.idle()

    // Reflection writes an inferred memory and moves the cursor.
    clock.advance(21 * 60_000)
    const reflected = nextEvent(keith.events, 'memory.reflected', (d) => d.threadId === threadId)
    tick(keith.events, clock)
    await reflected
    expect(utility.calls).toBe(2)

    const before = await state(keith, owner, threadId)
    expect(before.memories.map(([, content, source]) => [content, source]).sort()).toEqual([
      ['Tony has two hives in the garden', 'inferred'],
      ['Tony keeps bees', 'stated'],
    ])
    expect(before.reminders).toHaveLength(1)
    expect(before.reflectedThroughSeq).toBeGreaterThan(0)

    // Backup while Keith runs, then stop it.
    const out = tempDir('keith-backups-')
    const backupIo = io(home.dir, clock)
    expect(await runCli(['backup', '--out', out], backupIo)).toBe(0)
    const [folder] = readdirSync(out)
    if (!folder) throw new Error('no backup folder')
    await client.close()
    await keith.stop()

    const target = join(tempDir('keith-restored-'), 'home')
    expect(await runCli(['restore', join(out, folder)], io(target, clock))).toBe(0)

    const restoredChat = createFakeLlm([fakeText('Time to check the hives.')])
    const restoredUtility = createFakeLlm()
    const restored = await start(target, clock, createSplitFake(restoredChat, restoredUtility))
    expect(await state(restored, owner, threadId)).toEqual(before)

    // The reminder still fires from the restored home; reflection has nothing new to read.
    const again = await connect(wsUrl(restored.url, await login(restored.url)))
    cleanups.push(() => again.close())
    await again.hello()
    again.send('thread.open', {})
    await again.next('thread.opened')
    clock.advance(40 * 60_000)
    const delivered = nextEvent(restored.events, 'delivery.delivered', (d) => d.threadId === threadId)
    tick(restored.events, clock)
    await delivered
    expect(restoredChat.requests[0]?.system).toContain('(reminder) Check the hives')
    expect((await restored.repos.reminders.listPending(owner)).length).toBe(0)
    expect(restoredUtility.calls).toBe(0)
  })
})
