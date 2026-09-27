// Phase 4 integration (P4-I1): the default `morning_briefing` skill on the real core. A briefing
// turn (`briefing = "auto"`) lists it with the load hint, `skill.load` returns its instructions,
// and a plugin skill with the same name replaces it.

import { afterEach, describe, expect, test } from 'bun:test'
import { type AnyPluginDefinition, definePlugin } from '@keith/sdk'
import { createFakeLlm, createFakeLlmPlugin, type FakeLlm, fakeText, fakeToolCall } from '@keith/sdk/testing'
import { bootstrap } from '../src/bootstrap.ts'
import { connect } from '../src/server/test-fakes.ts'
import {
  createOwner,
  createSplitFake,
  createTestHome,
  login,
  quietLogger,
  splitModelConfig,
  testClock,
  wsUrl,
} from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const HINT = 'If the skills index lists `morning_briefing`, load it first.'
const DEFAULT_LINE =
  '- morning_briefing: How to brief a person on what they missed. Load at the start of a briefing or when someone asks what they missed.'

/** Boots with `briefing = "auto"`, attaches the owner (a first meeting is an arrival) and waits for the briefing. */
async function briefing(chat: FakeLlm, plugins: AnyPluginDefinition[] = []) {
  const home = await createTestHome(splitModelConfig('\n[mind.arrival]\nbriefing = "auto"\ngraceMs = 10\n'))
  cleanups.push(() => home.remove())
  const clock = testClock()
  await createOwner(home.dir, clock)
  const log = quietLogger(clock)
  const keith = await bootstrap({
    home: home.dir,
    env: {},
    plugins: [createFakeLlmPlugin(createSplitFake(chat)), ...plugins],
    clock,
    log,
  })
  cleanups.push(() => keith.stop())
  const client = await connect(wsUrl(keith.url, await login(keith.url)))
  cleanups.push(() => client.close())
  await client.hello()
  client.send('thread.open', {})
  await client.next('thread.opened')
  const completed = await client.next('message.completed')
  await keith.threads.idle()
  return { completed, log }
}

function briefingChat(final: string): FakeLlm {
  return createFakeLlm([[fakeToolCall('skill.load', { name: 'morning_briefing' })], fakeText(final)])
}

describe('the default briefing skill', () => {
  test('a briefing turn lists morning_briefing with the load hint, and skill.load returns it', async () => {
    const chat = briefingChat('Good morning, Tony.')
    const { completed } = await briefing(chat)
    expect((completed.data.message as { content: string }).content).toBe('Good morning, Tony.')

    const system = chat.requests[0]?.system ?? ''
    expect(system).toContain(HINT)
    expect(system).toContain(DEFAULT_LINE)
    const loaded = chat.requests[1]?.messages.find((m) => m.role === 'tool')?.content ?? ''
    expect(loaded).toContain('# Morning briefing')
  })

  test('a plugin skill with the same name replaces the default', async () => {
    const plugin = definePlugin({
      id: '@keith/test-briefing',
      namespace: 'test_briefing',
      version: '0.0.0',
      kind: 'tool',
      setup(ctx) {
        ctx.skills.register({
          name: 'morning_briefing',
          description: 'The house briefing: weather first, then news.',
          instructions: 'Start with the weather.',
        })
      },
    })
    const chat = briefingChat('Sunny today.')
    const { log } = await briefing(chat, [plugin])

    const system = chat.requests[0]?.system ?? ''
    expect(system).toContain(HINT)
    expect(system).toContain('- morning_briefing: The house briefing: weather first, then news.')
    expect(system).not.toContain(DEFAULT_LINE)
    expect(chat.requests[1]?.messages.find((m) => m.role === 'tool')?.content).toContain(
      'Start with the weather.',
    )
    // Bootstrap gives the skill registry a logger (P4-D1).
    expect(log.lines.some((l) => l.includes('plugin skill replaces the default'))).toBe(true)
  })
})
