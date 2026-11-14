import { afterEach, describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { frameUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const SESSION = 'front:owner'
const MESSAGES = 'GET /sessions/front%3Aowner/messages'

const until = async (check: () => boolean, what: string, ms = 15_000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(15)
  }
}

const proactive = (id: string, text: string): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      { type: 'data-keith.proactive', data: { reason: 'subagent-report' } },
      { type: 'text', text },
    ],
  }) as UIMessage

const started = (turnId: string) => ({
  type: 'turn-started',
  sessionId: SESSION,
  payload: { turnId, kind: 'wake', source: 'wake', queued: false },
})
const ended = (turnId: string, messageId: string) => ({
  type: 'turn-ended',
  sessionId: SESSION,
  payload: { turnId, kind: 'wake', stop: 'end', messageId, steps: 1, durationMs: 5, usage: {} },
})

describe('a turn the core starts on its own', () => {
  test('a wake turn shows its message in an idle chat without any input', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await until(() => core.streams() > 0, 'the activity stream')
    await until(() => core.seen.filter((l) => l === MESSAGES).length > 0, 'the first history')
    core.emit(started('t1'))
    core.setRunning(true)
    await Bun.sleep(30)
    core.pushHistory(proactive('w1', 'The research is in, here it is.'))
    core.setRunning(false)
    core.emit(ended('t1', 'w1'))
    const frame = await frameUntil(lastFrame, (f) => f.includes('The research is in'))
    expect(frame.match(/The research is in/g)).toHaveLength(1)
    unmount()
  })

  test('several wake turns in a row all show', async () => {
    const { lastFrame, core, unmount } = await setupApp()
    await until(() => core.streams() > 0, 'the activity stream')
    await until(() => core.seen.filter((l) => l === MESSAGES).length > 0, 'the first history')
    for (const n of [1, 2, 3]) {
      core.emit(started(`t${n}`))
      core.pushHistory(proactive(`w${n}`, `laporan nomor ${n}`))
      core.emit(ended(`t${n}`, `w${n}`))
    }
    const frame = await frameUntil(
      lastFrame,
      (f) =>
        f.includes('laporan nomor 1') &&
        f.includes('laporan nomor 2') &&
        f.includes('laporan nomor 3'),
    )
    expect(frame.match(/laporan nomor 2/g)).toHaveLength(1)
    unmount()
  })
})
