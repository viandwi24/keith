/** M4: a graceful stop (SIGINT/SIGTERM path: server.stop + core.close) in the middle of a turn. */
import { afterAll, describe, expect, test } from 'bun:test'
import { interruptedTurn } from 'eharness/client'
import { boot, cleanup, connect, FAST, messagesOf, newDir, stop } from './testing/core-harness.ts'
import { createGate, testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const providers = (gate?: ReturnType<typeof createGate>, text = 'x') => [
  testProvider({
    id: 'front-p',
    models: { f: [{ text }] },
    ...(gate ? { gate } : {}),
  }),
  testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } }),
]

describe('M4: graceful stop in the middle of a turn', () => {
  test('the next boot shows the turn as interrupted with the notice, and the owner can continue', async () => {
    const config = newDir()
    const gate = createGate()
    const a = await boot(config, providers(gate, 'never finishes') as never[])
    await connect(a.client)
    const running = (async () => {
      for await (const _ of a.client.reply('hello')) {
        // the stream ends when the core stops
      }
    })().catch(() => undefined)
    await gate.whenStarted(1)

    // what SIGINT does: stop the server, then core.close()
    await stop(a)
    gate.release()
    await running

    // same data folder, so the same instance id: nothing else is needed
    const b = await boot(config, providers(undefined, 'I am back.') as never[], a.token, FAST)
    const messages = await until(
      'interrupted notice after a graceful stop',
      () => messagesOf(b.client),
      (list) =>
        list.some((m) =>
          m.parts.some(
            (p) => p.type === 'data-eh.notice' && JSON.stringify(p).includes('EH_TURN_INTERRUPTED'),
          ),
        ),
    )
    // the reply is the interrupted one, so the TUI offers /continue and /retry
    expect(interruptedTurn(messages)).toBeDefined()
    expect(messages.length).toBeGreaterThan(0)
    expect((await b.client.harness.sessions.get('front:owner')).running).toBe(false)
    await stop(b)
  })
})
