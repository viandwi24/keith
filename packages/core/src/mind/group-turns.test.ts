// Group turns (P5-C2, S-6 step 3): human-to-human fan-out without an LLM turn, addressing, live
// participants. The addressing detector is a scripted fake (the real one is P5-D1's, tested in P5-I1).

import { afterEach, describe, expect, jest, test } from 'bun:test'
import type { CoreFrame } from '@keith/protocol'
import { fakeDelay, fakeText } from '@keith/sdk/testing'
import type { NodeId, PersonId, ThreadId } from '../shared/types.ts'
import { createFakeAddressing } from './testing/fakes.ts'
import {
  createGate,
  createHarness,
  flushMicrotasks,
  type Harness,
  type HarnessOptions,
  LAPTOP,
  PEPPER,
  PEPPER_PHONE,
  RHODEY,
  RHODEY_PHONE,
  TONY,
} from './testing/harness.ts'

afterEach(() => {
  jest.useRealTimers()
})

function framesOfType<T extends CoreFrame['type']>(h: Harness, node: NodeId, type: T) {
  return h.sink.framesOf(node).filter((f): f is Extract<CoreFrame, { type: T }> => f.type === type)
}

function say(h: Harness, threadId: ThreadId, personId: PersonId, nodeId: NodeId, text: string) {
  return h.tm.input({ threadId, personId, nodeId, modality: 'text', text })
}

/** Stored user/assistant rows of the thread, as `[role, content]`. */
function history(h: Harness, threadId: ThreadId) {
  return h.repos.all.messages
    .filter((m) => m.threadId === threadId && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => [m.role, m.content])
}

const MEMBERS: [PersonId, NodeId][] = [
  [TONY, LAPTOP],
  [PEPPER, PEPPER_PHONE],
  [RHODEY, RHODEY_PHONE],
]

/** Tony, Pepper and Rhodey attached to a group thread, with a scripted detector. */
async function groupOfThree(opts: HarnessOptions = {}) {
  const addressing = createFakeAddressing()
  const h = await createHarness({ addressing, ...opts })
  await h.addPerson(RHODEY, 'Rhodey', 'member')
  await h.repos.nodes.upsert({
    id: RHODEY_PHONE,
    name: 'test',
    kind: 'attended',
    capabilities: ['chat.text@1'],
    lastSeenAt: null,
  })
  const { threadId, opened } = await h.openGroup(MEMBERS, { purpose: 'Plan the Expo launch.' })
  await h.settle()
  return { h, addressing, threadId, opened }
}

describe('group input (S-6 step 3)', () => {
  test('a non-addressed input fans out and is stored, with no turn, no state change and no LLM call', async () => {
    const { h, addressing, threadId } = await groupOfThree({ fallback: fakeText('unused') })
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Rhodey, are you on your way?')
    await h.settle()

    for (const node of [LAPTOP, RHODEY_PHONE]) {
      expect(h.sink.typesOf(node)).toEqual(['message.user'])
      expect(framesOfType(h, node, 'message.user')[0]?.data.message).toMatchObject({
        role: 'user',
        content: 'Rhodey, are you on your way?',
        authorPersonId: PEPPER,
      })
    }
    expect(h.sink.typesOf(PEPPER_PHONE)).toEqual([])
    expect(history(h, threadId)).toEqual([['user', 'Rhodey, are you on your way?']])
    expect(h.llm.calls).toBe(0)
    expect(h.bus.named('thread.state_changed')).toEqual([])
    expect(h.bus.named('turn.started')).toEqual([])
    expect(h.bus.named('thread.message_added')).toMatchObject([
      { threadId, role: 'user', authorPersonId: PEPPER },
    ])
    expect(h.tm.state(threadId)).toBe('idle')

    expect(addressing.calls).toHaveLength(1)
    expect(addressing.calls[0]).toMatchObject({
      threadId,
      input: { authorPersonId: PEPPER, text: 'Rhodey, are you on your way?' },
      recent: [],
      participantNames: ['Tony', 'Pepper', 'Rhodey'],
    })
    // The verdict is logged at debug with its rule, never the text.
    const logged = h.log.entries.filter((e) => e.msg === 'addressing verdict')
    expect(logged).toMatchObject([{ level: 'debug', fields: { addressed: false, by: 'unsure' } }])
    expect(JSON.stringify(logged)).not.toContain('on your way')
  })

  test('an addressed input runs a turn as its author, with all three participants', async () => {
    const { h, addressing, threadId } = await groupOfThree({ script: [fakeText('On schedule.')] })
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Rhodey, are you on your way?')
    await h.settle()
    await say(h, threadId, TONY, LAPTOP, "Keith, what's the status?")
    await h.settle()

    expect(h.llm.calls).toBe(1)
    expect(h.bus.named('turn.started')).toMatchObject([{ threadId, kind: 'user' }])
    expect(history(h, threadId)).toEqual([
      ['user', 'Rhodey, are you on your way?'],
      ['user', "Keith, what's the status?"],
      ['assistant', 'On schedule.'],
    ])
    // The detector saw the earlier human message as recent history.
    expect(addressing.calls[1]?.recent.map((m) => m.content)).toEqual(['Rhodey, are you on your way?'])
    for (const node of [LAPTOP, PEPPER_PHONE, RHODEY_PHONE]) {
      expect(framesOfType(h, node, 'message.completed')[0]?.data.message.content).toBe('On schedule.')
    }
    expect(h.runCtxs.at(-1)?.participants).toEqual([TONY, PEPPER, RHODEY])
    expect(h.runCtxs.at(-1)?.personId).toBe(TONY)
  })

  test('two non-addressed inputs during a running turn are stored after the reply, without a second turn', async () => {
    const gate = createGate()
    const { h, threadId } = await groupOfThree({
      llmSleep: gate.sleep,
      script: [[...fakeText('Working'), fakeDelay(1), ...fakeText(' on it.')]],
      fallback: fakeText('unexpected'),
    })
    await say(h, threadId, TONY, LAPTOP, 'Keith, book the venue.')
    await flushMicrotasks()
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Nice.')
    await say(h, threadId, RHODEY, RHODEY_PHONE, 'Agreed.')
    gate.release()
    await h.settle()

    expect(h.llm.calls).toBe(1)
    expect(history(h, threadId)).toEqual([
      ['user', 'Keith, book the venue.'],
      ['assistant', 'Working on it.'],
      ['user', 'Nice.'],
      ['user', 'Agreed.'],
    ])
    expect(h.tm.state(threadId)).toBe('idle')
  })

  test('one addressed input among queued ones gives exactly one next turn, with all of them', async () => {
    const gate = createGate()
    const { h, addressing, threadId } = await groupOfThree({
      llmSleep: gate.sleep,
      script: [[...fakeText('Working'), fakeDelay(1), ...fakeText(' on it.')], fakeText('Friday works.')],
      fallback: fakeText('unexpected'),
    })
    await say(h, threadId, TONY, LAPTOP, 'Keith, book the venue.')
    await flushMicrotasks()
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Nice.')
    await say(h, threadId, RHODEY, RHODEY_PHONE, 'Keith, which day?')
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Good question.')
    gate.release()
    await h.settle()

    expect(h.llm.calls).toBe(2)
    expect(h.bus.named('turn.started')).toHaveLength(2)
    expect(history(h, threadId)).toEqual([
      ['user', 'Keith, book the venue.'],
      ['assistant', 'Working on it.'],
      ['user', 'Nice.'],
      ['user', 'Keith, which day?'],
      ['user', 'Good question.'],
      ['assistant', 'Friday works.'],
    ])
    // Decided in order after the reply; the first addressed one settles the batch.
    expect(addressing.calls.map((c) => c.input.text)).toEqual([
      'Keith, book the venue.',
      'Nice.',
      'Keith, which day?',
    ])
    expect(addressing.calls[2]?.recent.map((m) => m.content)).toEqual([
      'Keith, book the venue.',
      'Working on it.',
      'Nice.',
    ])
    // The turn acts as the author of its latest input.
    expect(h.runCtxs.at(-1)?.personId).toBe(PEPPER)
  })

  test('an input that arrives while an earlier one is being decided waits its turn, in order', async () => {
    const { h, addressing, threadId } = await groupOfThree({ script: [fakeText('Yes.')] })
    addressing.gated = true
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Morning all.')
    await flushMicrotasks()
    expect(addressing.waiting).toBe(1)
    // input() does not wait for the decision.
    await say(h, threadId, TONY, LAPTOP, 'Keith, are we on?')
    expect(framesOfType(h, PEPPER_PHONE, 'message.user')).toHaveLength(1)
    addressing.gated = false
    addressing.release()
    await h.settle()

    expect(history(h, threadId)).toEqual([
      ['user', 'Morning all.'],
      ['user', 'Keith, are we on?'],
      ['assistant', 'Yes.'],
    ])
    expect(addressing.calls[1]?.recent.map((m) => m.content)).toEqual(['Morning all.'])
  })

  test('a group with one current participant runs a turn for every input, without the detector', async () => {
    const addressing = createFakeAddressing()
    const h = await createHarness({ addressing, fallback: fakeText('Noted.') })
    const { threadId } = await h.openGroup([[PEPPER, PEPPER_PHONE]])
    await h.settle()
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Just thinking out loud.')
    await h.settle()
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Another thought.')
    await h.settle()
    expect(h.llm.calls).toBe(2)
    expect(addressing.calls).toEqual([])
    const logged = h.log.entries.filter((e) => e.msg === 'addressing verdict')
    expect(logged.map((e) => e.fields?.by)).toEqual(['single_human', 'single_human'])
  })

  test('without a detector every group input is addressed (phase 4)', async () => {
    const h = await createHarness({ fallback: fakeText('Hi.') })
    const { threadId } = await h.openGroup([
      [TONY, LAPTOP],
      [PEPPER, PEPPER_PHONE],
    ])
    await h.settle()
    await say(h, threadId, PEPPER, PEPPER_PHONE, 'Tony, lunch?')
    await h.settle()
    expect(h.llm.calls).toBe(1)
  })

  test('direct threads never ask the detector', async () => {
    const addressing = createFakeAddressing()
    const h = await createHarness({ addressing, fallback: fakeText('Sir.') })
    const { thread } = await h.open(TONY, LAPTOP)
    await say(h, thread.id, TONY, LAPTOP, 'no names here')
    await h.settle()
    expect(h.llm.calls).toBe(1)
    expect(addressing.calls).toEqual([])
  })
})

describe('live participants', () => {
  test('after thread.participant_left the leaver is FORBIDDEN and the next turn leaves him out', async () => {
    const { h, addressing, threadId } = await groupOfThree({ fallback: fakeText('Sure.') })
    await h.repos.threads.removeParticipant(threadId, RHODEY, h.clock.now())
    h.bus.emit('thread.participant_left', { threadId, personId: RHODEY })
    await h.settle()

    await expect(say(h, threadId, RHODEY, RHODEY_PHONE, 'Still here?')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await say(h, threadId, TONY, LAPTOP, 'Keith, summarize.')
    await h.settle()
    expect(addressing.calls.at(-1)?.participantNames).toEqual(['Tony', 'Pepper'])
    expect(h.runCtxs.at(-1)?.participants).toEqual([TONY, PEPPER])
    // The leaver shows up as a former participant on open.
    const reopened = await h.tm.open({ personId: TONY, nodeId: LAPTOP, threadId, arrival: null })
    expect(reopened.thread.participants.map((p) => p.id)).toEqual([TONY, PEPPER])
    expect(reopened.thread.formerParticipants).toEqual([{ id: RHODEY, name: 'Rhodey', tier: 'member' }])
    await h.settle()
  })

  test("a leaver's queued input stays queued and is stored", async () => {
    const gate = createGate()
    const { h, threadId } = await groupOfThree({
      llmSleep: gate.sleep,
      script: [[...fakeText('One'), fakeDelay(1), ...fakeText(' moment.')]],
      fallback: fakeText('unexpected'),
    })
    await say(h, threadId, TONY, LAPTOP, 'Keith, check the list.')
    await flushMicrotasks()
    await say(h, threadId, RHODEY, RHODEY_PHONE, 'Gotta go, bye.')
    await h.repos.threads.removeParticipant(threadId, RHODEY, h.clock.now())
    h.bus.emit('thread.participant_left', { threadId, personId: RHODEY })
    await h.bus.idle()
    gate.release()
    await h.settle()
    expect(history(h, threadId)).toEqual([
      ['user', 'Keith, check the list.'],
      ['assistant', 'One moment.'],
      ['user', 'Gotta go, bye.'],
    ])
  })

  test('after thread.participant_joined a new participant can send input without reloading', async () => {
    const addressing = createFakeAddressing()
    const h = await createHarness({ addressing, fallback: fakeText('Welcome.') })
    await h.addPerson(RHODEY, 'Rhodey', 'member')
    const { threadId } = await h.openGroup([
      [TONY, LAPTOP],
      [PEPPER, PEPPER_PHONE],
    ])
    await h.settle()
    await expect(say(h, threadId, RHODEY, RHODEY_PHONE, 'Hi')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await h.repos.threads.addParticipant(threadId, RHODEY, h.clock.now())
    h.bus.emit('thread.participant_joined', { threadId, personId: RHODEY, invitedBy: TONY })
    await h.settle()
    await say(h, threadId, RHODEY, RHODEY_PHONE, 'Keith, catch me up.')
    await h.settle()
    expect(h.llm.calls).toBe(1)
    expect(addressing.calls.at(-1)?.participantNames).toEqual(['Tony', 'Pepper', 'Rhodey'])
    expect(h.runCtxs.at(-1)?.personId).toBe(RHODEY)
  })

  test('a left participant whose group drops to one human makes every input addressed', async () => {
    const { h, addressing, threadId } = await groupOfThree({ fallback: fakeText('OK.') })
    for (const personId of [RHODEY, PEPPER]) {
      await h.repos.threads.removeParticipant(threadId, personId, h.clock.now())
      h.bus.emit('thread.participant_left', { threadId, personId })
    }
    await h.settle()
    await say(h, threadId, TONY, LAPTOP, 'anyone?')
    await h.settle()
    expect(h.llm.calls).toBe(1)
    expect(addressing.calls).toEqual([])
  })
})

describe('group thread.opened and deliveries', () => {
  test('thread.opened carries purpose and formerParticipants for a group', async () => {
    const { opened } = await groupOfThree()
    expect(opened.thread).toMatchObject({
      kind: 'group',
      title: 'Mission',
      purpose: 'Plan the Expo launch.',
      formerParticipants: [],
    })
    expect(opened.thread.participants.map((p) => p.name)).toEqual(['Tony', 'Pepper', 'Rhodey'])
  })

  test('a delivery in a group flushes at once (no arrival hold) and acts as the owner', async () => {
    const { h, threadId } = await groupOfThree({ script: [fakeText('The report is in.')] })
    // Arrival in a group starts no hold: the delivery flushes right away.
    await h.tm.open({ personId: TONY, nodeId: LAPTOP, threadId, arrival: { awayMs: 9_000_000 } })
    await h.deliveries.enqueue({ personId: TONY, threadId, kind: 'task_result', content: 'report' })
    await h.settle()
    expect(h.bus.named('turn.started')).toMatchObject([{ threadId, kind: 'delivery' }])
    expect(h.runCtxs.at(-1)?.personId).toBe(TONY)
  })

  test('a delivery turn acts as the first participant once the owner left', async () => {
    const { h, threadId } = await groupOfThree({ script: [fakeText('Done.')] })
    await h.repos.threads.removeParticipant(threadId, TONY, h.clock.now())
    h.bus.emit('thread.participant_left', { threadId, personId: TONY })
    await h.settle()
    await h.deliveries.enqueue({ personId: PEPPER, threadId, kind: 'task_result', content: 'report' })
    await h.settle()
    expect(h.bus.named('turn.started')).toMatchObject([{ kind: 'delivery' }])
    expect(h.runCtxs.at(-1)?.personId).toBe(PEPPER)
  })
})
