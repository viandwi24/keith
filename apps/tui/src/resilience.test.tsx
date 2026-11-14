import { afterEach, describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { frameUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const MESSAGES = 'GET /sessions/front%3Aowner/messages'
const REPLAY = 'GET /sessions/front%3Aowner/chat/stream'

const interrupted = (text = 'separuh jawaban'): UIMessage =>
  ({
    id: 'a0',
    role: 'assistant',
    parts: [{ type: 'text', text }],
    metadata: { eharness: { stop: 'interrupted' } },
  }) as UIMessage

const until = async (check: () => boolean, what: string, ms = 15_000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(15)
  }
}
const count = (seen: string[], line: string): number => seen.filter((l) => l === line).length

describe('a dropped answer', () => {
  test('is recovered by the replay and the full answer is shown once', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      reply: 'satu dua tiga empat lima enam',
    })
    core.dropNextAnswer(2, () => /^\s+\S\s+satu\b/m.test(lastFrame() ?? ''))
    await typeLine(stdin, 'hello')
    const frame = await frameUntil(lastFrame, (f) => f.includes('satu dua tiga empat lima enam'))
    expect(frame.match(/satu/g)).toHaveLength(1)
    expect(core.seen).toContain(REPLAY)
    // the turn is over on the core: the chat is idle again
    await frameUntil(lastFrame, (f) => f.includes('type a message, or /help'))
    unmount()
  })
})

describe('an answer cut before the first words', () => {
  test('is a failed send for eharness: the TUI still re-attaches, shows the answer once and clears the toast', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      reply: 'satu dua tiga empat lima enam',
    })
    core.dropNextAnswer(0)
    await typeLine(stdin, 'hello')
    const frame = await frameUntil(lastFrame, (f) => f.includes('satu dua tiga empat lima enam'))
    expect(frame.match(/satu/g)).toHaveLength(1)
    expect(core.seen).toContain(REPLAY)
    const done = await frameUntil(
      lastFrame,
      (f) => f.includes('type a message, or /help') && !f.includes('Cannot reach'),
    )
    // the user message the core stored replaced the optimistic one: no copy
    expect(done.match(/› hello/g)).toHaveLength(1)
    expect(done).not.toContain('reconnected')
    unmount()
  })
})

describe('a core restart', () => {
  test('refetches the history: the stored interrupted turn shows as a notice', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await until(() => count(core.seen, MESSAGES) > 0, 'the first history read')
    const before = count(core.seen, MESSAGES)
    core.pushHistory(interrupted())
    core.reboot('b2')
    await until(() => count(core.seen, MESSAGES) > before, 'the refetch after the restart')
    const frame = await frameUntil(lastFrame, (f) => f.includes('previous turn was interrupted'))
    expect(frame).toContain('separuh jawaban')
    unmount()
  })

  test('follows the turn when the core says it still runs', async () => {
    const { core, unmount } = await setupApp()
    await until(() => count(core.seen, MESSAGES) > 0, 'the first history read')
    core.setRunning(true)
    core.reboot('b2')
    await until(() => count(core.seen, REPLAY) > 0, 'the follow after the restart')
    core.setRunning(false)
    unmount()
  })
})

describe('an interrupted turn', () => {
  test('/continue sends the continue message and the notice goes away', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      history: [interrupted()],
      reply: 'the rest',
    })
    await frameUntil(lastFrame, (f) => f.includes('previous turn was interrupted'))
    await typeLine(stdin, '/continue')
    await frameUntil(lastFrame, (f) => f.includes('the rest'))
    expect(core.chats).toEqual([
      { trigger: 'submit-message', text: 'Continue where you left off.' },
    ])
    await frameUntil(lastFrame, (f) => !f.includes('previous turn was interrupted'))
    unmount()
  })

  test('/retry regenerates the interrupted reply', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({
      history: [interrupted()],
      reply: 'second answer',
    })
    await frameUntil(lastFrame, (f) => f.includes('previous turn was interrupted'))
    await typeLine(stdin, '/retry')
    await frameUntil(lastFrame, (f) => f.includes('second answer'))
    expect(core.chats).toEqual([{ trigger: 'regenerate-message', messageId: 'a0' }])
    unmount()
  })

  test('/continue and /retry with nothing interrupted say so and send nothing', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp()
    await typeLine(stdin, '/continue')
    await frameUntil(lastFrame, (f) => f.includes('No interrupted turn.'))
    expect(core.chats).toEqual([])
    unmount()
  })

  test('/help lists both commands', async () => {
    const { lastFrame, stdin, unmount } = await setupApp()
    await typeLine(stdin, '/help')
    await frameUntil(
      lastFrame,
      (f) => f.includes('/continue') && f.includes('/retry') && f.includes('/budget'),
    )
    unmount()
  })
})

describe('the connection in the header', () => {
  test('an outage says reconnecting and it goes away when the feed is back', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await frameUntil(lastFrame, (f) => f.includes('online') && !f.includes('menyambung'))
    core.feedDown(true)
    await frameUntil(lastFrame, (f) => f.includes('reconnecting'))
    core.feedDown(false)
    await frameUntil(lastFrame, (f) => !f.includes('reconnecting') && f.includes('online'))
    unmount()
  }, 60_000)

  test('a refused credential says logged out and stops the input', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    core.feedDown(true, 401)
    const frame = await frameUntil(lastFrame, (f) =>
      f.includes('This device is logged out or its credential was revoked.'),
    )
    expect(frame).toContain('logged out')
    expect(frame).toContain('Keith reconnects by itself after the login.')
    expect(frame).not.toContain('type a message')
    unmount()
  }, 60_000)
})
