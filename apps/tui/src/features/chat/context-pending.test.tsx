import { afterEach, describe, expect, test } from 'bun:test'
import { CONTEXT_HOLD_TEXT } from '@keith/app-model'
import { chatReady, frameUntil, typeLine } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

const SESSION = 'front:owner'
const pending = (state: 'start' | 'end', kind: 'new' | 'compact' = 'compact') => ({
  type: 'chat.context.pending',
  sessionId: SESSION,
  payload: state === 'end' ? { kind, state, ok: true } : { kind, state },
})

const until = async (check: () => boolean, what: string, ms = 15_000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(15)
  }
}

describe('a context change in progress', () => {
  test('the person feed shows its row; a plain message waits in the input until the change ends', async () => {
    const { lastFrame, stdin, core, unmount } = await setupApp({ reply: 'Here you go.' })
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    core.emit(pending('start'))
    await frameUntil(lastFrame, (f) => f.includes('compacting the conversation…'))
    await typeLine(stdin, 'hello')
    const held = await frameUntil(lastFrame, (f) => f.includes(CONTEXT_HOLD_TEXT))
    expect(held).toContain('hello')
    expect(held).not.toContain('Here you go.')
    core.emit(pending('end'))
    await frameUntil(lastFrame, (f) => !f.includes('compacting the conversation…'))
    // the draft is still there: the person presses Enter again and the message goes out
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => f.includes('● Here you go.'))
    unmount()
  })

  test('the draft survives a new generation: the view remounts, the typed text stays', async () => {
    let generations = [{ generation: 0, startedAt: 1, messages: 0 }]
    const { lastFrame, stdin, core, unmount } = await setupApp({
      rpc: { 'chat/generations': () => generations },
    })
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    for (const ch of 'keep this draft') {
      stdin.write(ch)
      await Bun.sleep(2)
    }
    await frameUntil(lastFrame, (f) => f.includes('keep this draft'))
    generations = [...generations, { generation: 1, startedAt: 2, messages: 0 }]
    core.emit({ type: 'chat.context.changed', sessionId: SESSION, payload: { generation: 1 } })
    await frameUntil(lastFrame, (f) => f.includes('new context'))
    expect(lastFrame()).toContain('keep this draft')
    unmount()
  })

  test('a finished /compact of the person re-reads the messages: the stored marker shows as a divider', async () => {
    const marker = {
      id: 'c1',
      role: 'user',
      parts: [{ type: 'data-eh.compaction', data: { summary: 'x' } }],
      metadata: { eharness: { kind: 'eh.compaction' } },
    }
    const { lastFrame, core, unmount } = await setupApp({ history: [] })
    await chatReady(lastFrame)
    await until(() => core.streams() > 0, 'the activity stream')
    core.pushHistory(marker as never)
    core.emit(pending('end'))
    await frameUntil(lastFrame, (f) => f.includes('conversation compacted'))
    unmount()
  })
})
