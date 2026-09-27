// Phase 3: listening state, audio-modality replies and barge-in (docs/architecture/voice.md),
// against a fake VoiceOutput built from voice/types.ts.

import { describe, expect, test } from 'bun:test'
import type { CoreFrame } from '@keith/protocol'
import { fakeDelay, fakeText } from '@keith/sdk/testing'
import type { NodeId, ThreadId } from '../shared/types.ts'
import { createFakeVoiceOutput, type FakeVoiceOutput } from './testing/fakes.ts'
import {
  createGate,
  createHarness,
  flushMicrotasks,
  type Harness,
  type HarnessOptions,
  LAPTOP,
  PHONE,
  TONY,
} from './testing/harness.ts'

/** LAPTOP types only; PHONE has a mic and a speaker. */
const VOICE_CAPS = {
  [LAPTOP]: ['chat.text@1'],
  [PHONE]: ['chat.text@1', 'audio.in@1', 'audio.out@1'],
}

const VOICE_CONFIG = {
  vad: 'energy',
  stt: 'fake',
  tts: 'fake',
  maxUtteranceMs: 30_000,
  bargeIn: true,
  bargeInMinMs: 0,
}

async function voiceHarness(opts: HarnessOptions = {}): Promise<Harness & { voice: FakeVoiceOutput }> {
  const voice = createFakeVoiceOutput()
  const h = await createHarness({ voice, capabilities: VOICE_CAPS, voiceConfig: VOICE_CONFIG, ...opts })
  return { ...h, voice }
}

function framesOfType<T extends CoreFrame['type']>(h: Harness, node: NodeId, type: T) {
  return h.sink.framesOf(node).filter((f): f is Extract<CoreFrame, { type: T }> => f.type === type)
}

function states(h: Harness, node: NodeId): string[] {
  return framesOfType(h, node, 'thread.state').map((f) => f.data.state)
}

function speak(h: Harness, threadId: ThreadId, text: string, nodeId: NodeId = PHONE) {
  return h.tm.input({ threadId, personId: TONY, nodeId, modality: 'audio', text })
}

function type(h: Harness, threadId: ThreadId, text: string, nodeId: NodeId = LAPTOP) {
  return h.tm.input({ threadId, personId: TONY, nodeId, modality: 'text', text })
}

async function openBoth(h: Harness): Promise<ThreadId> {
  const { thread } = await h.open(TONY, LAPTOP)
  await h.open(TONY, PHONE)
  await h.settle()
  return thread.id
}

describe('listening', () => {
  test('voiceActivity moves idle → listening → thinking → speaking → idle', async () => {
    const h = await voiceHarness({ script: [fakeText('Yes sir.')] })
    const threadId = await openBoth(h)
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    expect(h.tm.state(threadId)).toBe('listening')
    await speak(h, threadId, 'what time is it')
    await h.settle()
    expect(states(h, PHONE)).toEqual(['listening', 'thinking', 'speaking', 'idle'])
    expect(states(h, LAPTOP)).toEqual(['listening', 'thinking', 'speaking', 'idle'])
  })

  test('speech that stops without an input returns to idle', async () => {
    const h = await voiceHarness()
    const threadId = await openBoth(h)
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: false })
    expect(states(h, PHONE)).toEqual(['listening', 'idle'])
    expect(h.llm.calls).toBe(0)
  })

  test('the listening node detaching returns the thread to idle', async () => {
    const h = await voiceHarness()
    const threadId = await openBoth(h)
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    h.tm.detach({ nodeId: PHONE })
    expect(h.tm.state(threadId)).toBe('idle')
  })
})

describe('audio-modality replies', () => {
  test('typed input gets no VoiceOutput.begin call', async () => {
    const h = await voiceHarness({ script: [fakeText('Typed reply.')] })
    const threadId = await openBoth(h)
    await type(h, threadId, 'hi', PHONE)
    await h.settle()
    expect(h.voice.speeches).toEqual([])
  })

  test('audio input from a node with audio.out@1 is spoken on that node only', async () => {
    const h = await voiceHarness({ script: [fakeText('Spoken reply.', 4)] })
    const threadId = await openBoth(h)
    await speak(h, threadId, 'hello')
    await h.settle()
    expect(h.voice.speeches).toHaveLength(1)
    const [speech] = h.voice.speeches
    const [started] = framesOfType(h, PHONE, 'message.started')
    expect(speech).toMatchObject({ nodeId: PHONE, pushed: 'Spoken reply.', ended: true, stopCalls: 0 })
    expect(speech?.messageId).toBe(started?.data.messageId)
    const stored = h.repos.all.messages.at(-1)
    expect(stored).toMatchObject({
      role: 'assistant',
      modality: 'audio',
      content: 'Spoken reply.',
      meta: null,
    })
  })

  test('audio input from a node without audio.out@1 is answered in text only', async () => {
    const h = await voiceHarness({
      script: [fakeText('Text only.')],
      capabilities: { ...VOICE_CAPS, [PHONE]: ['chat.text@1', 'audio.in@1'] },
    })
    const threadId = await openBoth(h)
    await speak(h, threadId, 'hello')
    await h.settle()
    expect(h.voice.speeches).toEqual([])
    expect(framesOfType(h, PHONE, 'message.completed')[0]?.data.message.content).toBe('Text only.')
  })

  test('S-7: A types, B speaks; B gets the audio, A gets the same text and no audio', async () => {
    const h = await voiceHarness({ script: [fakeText('Typed answer.'), fakeText('Spoken answer.')] })
    const threadId = await openBoth(h)
    await type(h, threadId, 'first', LAPTOP)
    await h.settle()
    expect(h.voice.speeches).toEqual([])
    await speak(h, threadId, 'second', PHONE)
    await h.settle()
    expect(h.voice.speeches.map((s) => [s.nodeId, s.pushed])).toEqual([[PHONE, 'Spoken answer.']])
    const onA = framesOfType(h, LAPTOP, 'message.completed').map((f) => f.data.message.content)
    const onB = framesOfType(h, PHONE, 'message.completed').map((f) => f.data.message.content)
    expect(onA).toEqual(['Typed answer.', 'Spoken answer.'])
    expect(onB).toEqual(onA)
    // A also sees B's spoken words, as a message.user with modality audio.
    const echoed = framesOfType(h, LAPTOP, 'message.user').map((f) => f.data.message)
    expect(echoed).toMatchObject([{ content: 'second', modality: 'audio' }])
  })

  test('without voice deps an audio input is answered in text, as in phase 2', async () => {
    const h = await createHarness({ script: [fakeText('Plain.')], capabilities: VOICE_CAPS })
    const { thread } = await h.open(TONY, PHONE)
    await h.settle()
    h.tm.voiceActivity({ threadId: thread.id, nodeId: PHONE, speaking: true })
    await speak(h, thread.id, 'hello')
    await h.settle()
    expect(h.repos.all.messages.at(-1)).toMatchObject({ content: 'Plain.', meta: null })
  })
})

describe('barge-in', () => {
  /** A spoken turn held by the gate after 'Hello there. How'. */
  async function speakingTurn(opts: HarnessOptions = {}) {
    const gate = createGate()
    const h = await voiceHarness({
      llmSleep: gate.sleep,
      script: [[...fakeText('Hello there. How'), fakeDelay(1), ...fakeText(' are you?')]],
      ...opts,
    })
    const threadId = await openBoth(h)
    await speak(h, threadId, 'hi')
    await flushMicrotasks()
    expect(gate.waiting).toBe(1)
    expect(h.tm.state(threadId)).toBe('speaking')
    const speech = h.voice.speeches[0]
    if (!speech) throw new Error('no speech')
    return { h, gate, threadId, speech }
  }

  test('speech on the focus node while speaking stops the audio and keeps only what was spoken', async () => {
    const { h, threadId, speech } = await speakingTurn()
    speech.spokenChars = 13 // 'Hello there. '
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    expect(speech.stopCalls).toBeGreaterThan(0)
    await h.settle()
    const expected = { content: 'Hello there. ', meta: { cancelled: true, spokenChars: 13 } }
    expect(h.repos.all.messages.at(-1)).toMatchObject({ role: 'assistant', ...expected })
    for (const node of [LAPTOP, PHONE]) {
      expect(framesOfType(h, node, 'message.completed')[0]?.data.message).toMatchObject(expected)
    }
    expect(h.bus.named('turn.completed')).toMatchObject([{ cancelled: true }])
    // The thread goes on listening to the speaker.
    expect(states(h, PHONE)).toEqual(['thinking', 'speaking', 'listening'])
    const reopened = await h.open(TONY, LAPTOP)
    expect(reopened.messages.at(-1)).toMatchObject(expected)
    await h.settle()
  })

  test('the next spoken input after a barge-in becomes the next turn', async () => {
    const { h, threadId, speech } = await speakingTurn({
      script: [[...fakeText('Hello there. How'), fakeDelay(1), ...fakeText(' are you?')], fakeText('Sure.')],
    })
    speech.spokenChars = 6
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    await h.settle()
    await speak(h, threadId, 'stop, tell me the time')
    await h.settle()
    expect(h.llm.requests[1]?.messages.slice(-3)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello ' },
      { role: 'user', content: 'stop, tell me the time' },
    ])
    expect(h.tm.state(threadId)).toBe('idle')
  })

  test('barge-in during playback, after the text is complete, still cuts the reply', async () => {
    const h = await voiceHarness({ script: [fakeText('One. Two. Three.')] })
    h.voice.autoFinish = false
    const threadId = await openBoth(h)
    await speak(h, threadId, 'count')
    await flushMicrotasks()
    const speech = h.voice.speeches[0]
    expect(speech?.ended).toBe(true)
    expect(h.tm.state(threadId)).toBe('speaking')
    expect(framesOfType(h, PHONE, 'message.completed')).toEqual([])
    if (speech) speech.spokenChars = 5
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    await h.settle()
    expect(h.repos.all.messages.at(-1)).toMatchObject({
      content: 'One. ',
      meta: { cancelled: true, spokenChars: 5 },
    })
  })

  test('a reply whose playback finishes is stored whole, without stopping the speech', async () => {
    const h = await voiceHarness({ script: [fakeText('All of it.')] })
    h.voice.autoFinish = false
    const threadId = await openBoth(h)
    await speak(h, threadId, 'go')
    await flushMicrotasks()
    h.voice.speeches[0]?.finish()
    await h.settle()
    expect(h.voice.speeches[0]?.stopCalls).toBe(0)
    expect(h.repos.all.messages.at(-1)).toMatchObject({ content: 'All of it.', meta: null })
  })

  test('input.cancel on a spoken reply also keeps only what was spoken', async () => {
    const { h, threadId, speech } = await speakingTurn()
    speech.spokenChars = 5
    h.tm.cancel({ threadId, nodeId: PHONE })
    await h.settle()
    expect(h.repos.all.messages.at(-1)).toMatchObject({
      content: 'Hello',
      meta: { cancelled: true, spokenChars: 5 },
    })
    expect(h.tm.state(threadId)).toBe('idle')
  })

  test('speech on another node is not a barge-in', async () => {
    const { h, gate, threadId, speech } = await speakingTurn()
    h.tm.voiceActivity({ threadId, nodeId: LAPTOP, speaking: true })
    expect(speech.stopCalls).toBe(0)
    expect(h.tm.state(threadId)).toBe('speaking')
    gate.release()
    await h.settle()
    expect(h.repos.all.messages.at(-1)).toMatchObject({ content: 'Hello there. How are you?', meta: null })
  })

  test('voice.bargeIn = false: speech on the focus node does not cut the reply', async () => {
    const { h, gate, threadId, speech } = await speakingTurn({
      voiceConfig: { ...VOICE_CONFIG, bargeIn: false },
    })
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    expect(speech.stopCalls).toBe(0)
    gate.release()
    await h.settle()
    expect(h.repos.all.messages.at(-1)).toMatchObject({ content: 'Hello there. How are you?' })
  })

  test('voice.bargeInMinMs: short speech is ignored, longer speech cuts the reply', async () => {
    const { h, threadId, speech } = await speakingTurn({
      voiceConfig: { ...VOICE_CONFIG, bargeInMinMs: 30 },
    })
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: false })
    await Bun.sleep(50)
    expect(speech.stopCalls).toBe(0)
    expect(h.tm.state(threadId)).toBe('speaking')
    h.tm.voiceActivity({ threadId, nodeId: PHONE, speaking: true })
    expect(speech.stopCalls).toBe(0)
    await Bun.sleep(50)
    expect(speech.stopCalls).toBeGreaterThan(0)
    await h.settle()
    expect(h.repos.all.messages.at(-1)).toMatchObject({ meta: { cancelled: true } })
  })
})
