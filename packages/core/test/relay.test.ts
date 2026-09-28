// Phase 5 integration (P5-I1): a relay on the real core. Tony's model calls `relay.send`, Pepper's
// attached node gets a proactive delivery turn that names the sender (I-13, D4); after Pepper
// blocks Tony, the next relay is refused with the generic text and enqueues nothing (ADR-0017).

import { afterEach, describe, expect, test } from 'bun:test'
import { fakeText, fakeToolCall } from '@keith/sdk/testing'
import { RELAY_MESSAGES } from '../src/builtins/relay.ts'
import { nextEvent } from './helpers.ts'
import {
  afterTool,
  attachOwner,
  type Cleanups,
  createWorld,
  greet,
  lastUser,
  say,
  settle,
  signUp,
  startKeith,
  toolResult,
  waitFrame,
} from './people-helpers.ts'

const cleanups: Cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

describe('relays on the real core', () => {
  test('relay.send reaches Pepper as a labelled delivery turn; after a block it is refused', async () => {
    const world = await createWorld(cleanups)
    const keith = await startKeith(world, cleanups)
    const tony = await attachOwner(keith, world, cleanups)
    const pepper = await signUp(keith, world, cleanups, 'Pepper')
    await greet(keith, pepper)
    const chat = world.fake.chat

    chat.route(
      {
        name: 'tony asks',
        when: (r) => lastUser(r) === 'Tell Pepper the suit is ready.',
        reply: () => [fakeToolCall('relay.send', { to: 'pepper', text: 'The suit is ready.' })],
      },
      {
        name: 'tony confirms',
        when: (r) => afterTool(r, 'relay.send') && toolResult(r) === RELAY_MESSAGES.sent('Pepper'),
        reply: () => fakeText('I will tell her.'),
      },
      {
        name: 'pepper hears',
        when: (r) => r.system.includes('(relay from Tony) The suit is ready.'),
        reply: () => fakeText('Tony says the suit is ready.'),
      },
    )

    const enqueued = nextEvent(keith.events, 'delivery.enqueued', (d) => d.kind === 'relay')
    say(tony, tony.main, 'Tell Pepper the suit is ready.')
    const item = await enqueued
    expect(item).toMatchObject({ threadId: pepper.main, kind: 'relay', urgency: 'normal' })

    const completed = await waitFrame(
      pepper.client,
      'message.completed',
      (f) => (f.data.message as { threadId: string }).threadId === pepper.main,
    )
    await settle(keith)
    const message = completed.data.message as {
      id: string
      content: string
      meta?: { relayFrom?: unknown }
    }
    expect(message.content).toBe('Tony says the suit is ready.')
    expect(message.meta?.relayFrom).toEqual([{ personId: tony.id, name: 'Tony' }])
    const started = pepper.client.frames.find(
      (f) => f.type === 'message.started' && f.data.messageId === message.id,
    )
    expect(started?.data.proactive).toBe(true)
    // The recipient's context labels the relay and says to name the sender.
    const heard = chat.requests.find((r) => r.system.includes('(relay from Tony)'))
    expect(heard?.system).toContain('Pass it on here, and say who it is from.')
    // Tony's node never sees Pepper's thread.
    expect(
      tony.client.frames.some(
        (f) =>
          f.type === 'message.completed' &&
          f.data.message &&
          (f.data.message as { threadId: string }).threadId === pepper.main,
      ),
    ).toBe(false)

    // Pepper blocks Tony; his next relay is refused with the generic text and enqueues nothing.
    chat.route(
      {
        name: 'pepper blocks',
        when: (r) => lastUser(r) === 'Stop passing me messages from Tony.',
        reply: () => [fakeToolCall('relay.block', { from: 'Tony' })],
      },
      {
        name: 'pepper blocked',
        when: (r) => afterTool(r, 'relay.block'),
        reply: () => fakeText('Done.'),
      },
      {
        name: 'tony asks again',
        when: (r) => lastUser(r) === 'Tell Pepper I am sorry.',
        reply: () => [fakeToolCall('relay.send', { to: 'Pepper', text: 'I am sorry.' }, 'call_relay_2')],
      },
      {
        name: 'tony refused',
        when: (r) => afterTool(r, 'relay.send') && toolResult(r) === RELAY_MESSAGES.notAllowed('Pepper'),
        reply: () => fakeText('I cannot pass that on.'),
      },
    )
    say(pepper, pepper.main, 'Stop passing me messages from Tony.')
    await waitFrame(
      pepper.client,
      'message.completed',
      (f) => (f.data.message as { content: string }).content === 'Done.',
    )
    await settle(keith)
    const card = await keith.repos.relationships.get(pepper.id)
    expect(card?.blockedRelayFrom).toEqual([tony.id])

    const relays: unknown[] = []
    const off = keith.events.on('delivery.enqueued', (e) => {
      if (e.data.kind === 'relay') relays.push(e.data)
    })
    say(tony, tony.main, 'Tell Pepper I am sorry.')
    await waitFrame(
      tony.client,
      'message.completed',
      (f) => (f.data.message as { content: string }).content === 'I cannot pass that on.',
    )
    await settle(keith)
    off()
    expect(relays).toEqual([])
    expect(await keith.repos.deliveries.pendingFor(pepper.main)).toEqual([])
    expect([...chat.used].filter((n) => n !== 'greeting').sort()).toEqual([
      'pepper blocked',
      'pepper blocks',
      'pepper hears',
      'tony asks',
      'tony asks again',
      'tony confirms',
      'tony refused',
    ])
    expect(chat.unmatched).toEqual([])
    expect(world.fake.utility.calls).toBe(0)
  })
})
