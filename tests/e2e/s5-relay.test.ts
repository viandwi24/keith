// S-5, phase 5 (P5-I2): relay between people, on the real core over HTTP and WebSocket. Tony's
// model calls `relay.send`; Pepper's web-like node gets an unsolicited message that names Tony
// (`meta.relayFrom`), and the delivery is marked delivered. Pepper answers the same way. A block
// wins over every tier, a guest may relay only to the owner, and a relay to someone who is away
// waits for their arrival (I-11, I-13, ADR-0017).

import { afterEach, describe, expect, test } from 'bun:test'
import { RELAY_MESSAGES } from '../../packages/core/src/builtins/relay.ts'
import type { DeliveryId, MessageDto, ThreadId } from '../../packages/protocol/src/index.ts'
import { fakeText, fakeToolCall } from '../../packages/sdk/src/testing/index.ts'
import {
  addPerson,
  afterTool,
  connectNode,
  createHome,
  type E2eNode,
  type E2ePerson,
  e2eClock,
  e2eConfig,
  GREETING,
  greet,
  type Keith,
  lastUser,
  nextEvent,
  type RoutedChat,
  routedChat,
  scriptedLlm,
  scriptedProvider,
  settle,
  signUp,
  startKeith,
  systemOf,
  TEST_TIMEOUT_MS,
  toolResult,
} from './harness.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const AWAY_MINUTES = 1
/** A web-like node: text and UI blocks, like the web app. */
const WEB_CAPABILITIES = ['chat.text@1', 'ui.render@1']

type Actor = { person: E2ePerson; node: E2eNode; main: ThreadId }

/**
 * Scripts one relay request: `said` makes the model call `relay.send({ to, text })` (with a unique
 * call id), and the tool's answer `expected` makes it reply `reply`.
 */
function scriptRelay(
  chat: RoutedChat,
  s: { said: string; to: string; text: string; expected: string; reply: string },
): void {
  chat.route(
    {
      name: `send: ${s.said}`,
      when: (r) => lastUser(r) === s.said,
      reply: () => [fakeToolCall('relay.send', { to: s.to, text: s.text }, `call_${crypto.randomUUID()}`)],
    },
    {
      name: `sent: ${s.said}`,
      when: (r) => afterTool(r, 'relay.send') && toolResult(r) === s.expected,
      reply: () => fakeText(s.reply),
    },
  )
}

/** Scripts the recipient's delivery turn for a relay: its context labels the sender. */
function scriptHearing(
  chat: RoutedChat,
  s: { from: string; text: string; reply: string; onGreeting?: boolean },
) {
  chat.route({
    name: `hears: ${s.text}`,
    when: (r) =>
      lastUser(r) === (s.onGreeting ? GREETING : null) &&
      systemOf(r).includes(`(relay from ${s.from}) ${s.text}`),
    reply: () => fakeText(s.reply),
  })
}

/** Says `text` and waits for the assistant's answer in the same thread. */
async function ask(a: Actor, text: string): Promise<MessageDto> {
  a.node.say(a.main, text)
  return a.node.reply(a.main)
}

/** Collects the relays enqueued from now on. */
function watchRelays(keith: Keith) {
  const seen: { deliveryId: DeliveryId; threadId: ThreadId }[] = []
  const off = keith.events.on('delivery.enqueued', (e) => {
    if (e.data.kind === 'relay') seen.push({ deliveryId: e.data.deliveryId, threadId: e.data.threadId })
  })
  return { seen, off }
}

function assistantMessages(node: E2eNode, threadId: ThreadId): MessageDto[] {
  return node.frames.flatMap((f) =>
    f.type === 'message.completed' && f.data.message.threadId === threadId ? [f.data.message] : [],
  )
}

describe('S-5 (phase 5): relay between people', () => {
  test(
    'I-13: relays name the sender and are marked delivered; a block and the guest rule refuse; I-11: an away recipient gets it on arrival',
    async () => {
      const home = await createHome(e2eConfig({ awayAfterMinutes: AWAY_MINUTES }))
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const chat = routedChat()
      const utility = scriptedLlm()
      const { keith } = await startKeith({
        home,
        clock,
        provider: scriptedProvider({ chat: { llm: chat }, utility: { llm: utility } }),
      })
      cleanups.push(() => keith.stop())

      // The cast: Tony (owner), Pepper (member, web-like node), Rhodey (member), Happy (guest).
      const tonyP = await addPerson(keith, clock, { name: 'Tony', tier: 'owner' })
      const laptop = await connectNode(keith, tonyP)
      cleanups.push(() => laptop.close())
      const tony: Actor = { person: tonyP, node: laptop, main: (await laptop.openMain()).threadId }

      const join = async (
        name: string,
        tier: 'member' | 'guest',
        capabilities?: string[],
      ): Promise<Actor> => {
        const person = await signUp(keith, home, clock, { name, tier })
        const node = await connectNode(keith, person, { token: person.token, capabilities })
        cleanups.push(() => node.close())
        const main = (await node.openMain()).threadId
        await greet(node, main)
        return { person, node, main }
      }
      const pepper = await join('Pepper', 'member', WEB_CAPABILITIES)
      const rhodey = await join('Rhodey', 'member')
      const happy = await join('Happy', 'guest')
      await settle(keith)

      // 1–2. Tony: "Tell Pepper I'll be late." Pepper's node gets an unsolicited message naming Tony.
      scriptRelay(chat, {
        said: "Tell Pepper I'll be late.",
        to: 'Pepper',
        text: "I'll be late.",
        expected: RELAY_MESSAGES.sent('Pepper'),
        reply: "I'll tell her, sir.",
      })
      scriptHearing(chat, { from: 'Tony', text: "I'll be late.", reply: "Tony says he'll be late." })
      const enqueued = nextEvent(keith, 'delivery.enqueued', (d) => d.kind === 'relay')
      expect((await ask(tony, "Tell Pepper I'll be late.")).content).toBe("I'll tell her, sir.")
      const late = await enqueued
      expect(late.threadId).toBe(pepper.main)

      const heard = await pepper.node.reply(pepper.main)
      expect(heard.content).toBe("Tony says he'll be late.")
      expect(heard.meta?.relayFrom).toEqual([{ personId: tony.person.id, name: 'Tony' }])
      const started = await pepper.node.next('message.started', (f) => f.data.messageId === heard.id)
      expect(started.data.proactive).toBe(true)
      await settle(keith)
      const lateRow = await keith.repos.deliveries.get(late.deliveryId)
      expect(lateRow).toMatchObject({
        status: 'delivered',
        authorPersonId: tony.person.id,
        messageId: heard.id,
      })
      expect(await keith.repos.deliveries.pendingFor(pepper.main)).toEqual([])
      // Tony's node never sees Pepper's thread.
      expect(JSON.stringify(laptop.frames)).not.toContain(pepper.main)

      // 3. Pepper: "Tell him no problem." It relays back the same way.
      scriptRelay(chat, {
        said: 'Tell him no problem.',
        to: 'Tony',
        text: 'No problem.',
        expected: RELAY_MESSAGES.sent('Tony'),
        reply: "I'll let him know.",
      })
      scriptHearing(chat, { from: 'Pepper', text: 'No problem.', reply: 'Pepper says no problem, sir.' })
      expect((await ask(pepper, 'Tell him no problem.')).content).toBe("I'll let him know.")
      const back = await laptop.next(
        'message.completed',
        (f) =>
          f.data.message.threadId === tony.main && f.data.message.content === 'Pepper says no problem, sir.',
      )
      expect(back.data.message.meta?.relayFrom).toEqual([{ personId: pepper.person.id, name: 'Pepper' }])
      await settle(keith)

      // 4. Pepper blocks Rhodey. Rhodey's relay gets the generic refusal and Pepper gets nothing.
      chat.route(
        {
          name: 'pepper blocks',
          when: (r) => lastUser(r) === 'Stop passing me messages from Rhodey.',
          reply: () => [fakeToolCall('relay.block', { from: 'Rhodey' })],
        },
        {
          name: 'pepper blocked',
          when: (r) => afterTool(r, 'relay.block') && toolResult(r) === RELAY_MESSAGES.blocked('Rhodey'),
          reply: () => fakeText('Done.'),
        },
      )
      expect((await ask(pepper, 'Stop passing me messages from Rhodey.')).content).toBe('Done.')
      expect((await keith.repos.relationships.get(pepper.person.id))?.blockedRelayFrom).toEqual([
        rhodey.person.id,
      ])

      const refused = watchRelays(keith)
      const pepperMessagesBefore = assistantMessages(pepper.node, pepper.main).length
      scriptRelay(chat, {
        said: 'Tell Pepper the jet is fueled.',
        to: 'Pepper',
        text: 'The jet is fueled.',
        expected: RELAY_MESSAGES.notAllowed('Pepper'),
        reply: "I can't pass that on.",
      })
      expect((await ask(rhodey, 'Tell Pepper the jet is fueled.')).content).toBe("I can't pass that on.")

      // 5. Happy (guest) may not relay to Pepper, but may relay to Tony (the owner).
      scriptRelay(chat, {
        said: 'Tell Pepper the car is ready.',
        to: 'Pepper',
        text: 'The car is ready.',
        expected: RELAY_MESSAGES.notAllowed('Pepper'),
        reply: "Sorry, I can't pass that on.",
      })
      expect((await ask(happy, 'Tell Pepper the car is ready.')).content).toBe("Sorry, I can't pass that on.")
      await settle(keith)
      refused.off()
      expect(refused.seen).toEqual([])
      expect(await keith.repos.deliveries.pendingFor(pepper.main)).toEqual([])
      expect(assistantMessages(pepper.node, pepper.main)).toHaveLength(pepperMessagesBefore)
      const pepperSeen = JSON.stringify(pepper.node.frames)
      expect(pepperSeen).not.toContain('The jet is fueled.')
      expect(pepperSeen).not.toContain('The car is ready.')

      scriptRelay(chat, {
        said: 'Tell the boss the car is ready.',
        to: 'Tony',
        text: 'The car is ready.',
        expected: RELAY_MESSAGES.sent('Tony'),
        reply: "I'll tell him.",
      })
      scriptHearing(chat, {
        from: 'Happy',
        text: 'The car is ready.',
        reply: 'Happy says the car is ready, sir.',
      })
      expect((await ask(happy, 'Tell the boss the car is ready.')).content).toBe("I'll tell him.")
      const fromHappy = await laptop.next(
        'message.completed',
        (f) =>
          f.data.message.threadId === tony.main &&
          f.data.message.content === 'Happy says the car is ready, sir.',
      )
      expect(fromHappy.data.message.meta?.relayFrom).toEqual([{ personId: happy.person.id, name: 'Happy' }])
      await settle(keith)

      // 6. Pepper goes away. Tony's next relay waits for her, and is delivered on her arrival (I-11).
      // Her last-seen time is written when her last node detaches.
      const left = nextEvent(keith, 'person.left', (d) => d.personId === pepper.person.id)
      await pepper.node.close()
      await left
      clock.advance(AWAY_MINUTES * 60_000 + 1)
      scriptRelay(chat, {
        said: 'Tell Pepper dinner is at eight.',
        to: 'Pepper',
        text: 'Dinner is at eight.',
        expected: RELAY_MESSAGES.sent('Pepper'),
        reply: 'I will, sir.',
      })
      scriptHearing(chat, {
        from: 'Tony',
        text: 'Dinner is at eight.',
        reply: 'Welcome back, Pepper. Tony says dinner is at eight.',
        onGreeting: true,
      })
      const waiting = nextEvent(keith, 'delivery.enqueued', (d) => d.kind === 'relay')
      expect((await ask(tony, 'Tell Pepper dinner is at eight.')).content).toBe('I will, sir.')
      const dinner = await waiting
      await settle(keith)
      expect((await keith.repos.deliveries.get(dinner.deliveryId))?.status).toBe('pending')
      expect(chat.used).not.toContain('hears: Dinner is at eight.')

      const arrived = nextEvent(keith, 'person.arrived', (d) => d.personId === pepper.person.id)
      const phone = await connectNode(keith, pepper.person, { capabilities: WEB_CAPABILITIES })
      cleanups.push(() => phone.close())
      expect((await phone.openMain()).threadId).toBe(pepper.main)
      await arrived
      const welcome = await greet(phone, pepper.main)
      expect(welcome.content).toBe('Welcome back, Pepper. Tony says dinner is at eight.')
      expect(welcome.meta?.relayFrom).toEqual([{ personId: tony.person.id, name: 'Tony' }])
      await settle(keith)
      expect(await keith.repos.deliveries.get(dinner.deliveryId)).toMatchObject({
        status: 'delivered',
        messageId: welcome.id,
      })

      expect(chat.unmatched.map((r) => lastUser(r))).toEqual([])
      expect(utility.calls).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )
})
