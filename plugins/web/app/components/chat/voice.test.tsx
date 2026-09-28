import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { memorySessionStore, type PlaybackSink } from '@keith/client'
import { type FakeCore, startFakeCore, waitUntil } from '@keith/client/testing'
import type { MicCapture } from '../../lib/mic.ts'
import type { VoiceEnv } from '../../lib/voice.ts'
import { useDom } from '../../test/dom.ts'

useDom()
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { App } = await import('../app.tsx')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
})

let core: FakeCore | null = null
afterEach(async () => {
  cleanup()
  await core?.stop()
  core = null
})

/** A mic and speaker that the test drives: chunks are pushed by hand, playback is recorded. */
function fakeVoice(opts: { openError?: Error; unavailable?: string } = {}) {
  const mics: { onChunk: (pcm: Int16Array) => void; closed: boolean }[] = []
  const played: { stopped: boolean; ended: () => void }[] = []
  let resumed = 0
  const sink: PlaybackSink = {
    now: () => 0,
    play(_samples, _rate, _at, onEnded) {
      const entry = { stopped: false, ended: onEnded }
      played.push(entry)
      return { stop: () => (entry.stopped = true) }
    },
  }
  const env: VoiceEnv = {
    unavailable: opts.unavailable ?? null,
    async openMic(onChunk) {
      if (opts.openError) throw opts.openError
      const mic = { onChunk, closed: false }
      mics.push(mic)
      const capture: MicCapture = {
        sampleRate: 48_000,
        async close() {
          mic.closed = true
        },
      }
      return capture
    },
    createOutput: () => ({
      sink,
      resume: async () => {
        resumed += 1
      },
      close: async () => {},
    }),
  }
  return { env, mics, played, resumed: () => resumed }
}

type View = ReturnType<typeof render>

async function signedIn(fake: FakeCore, env: VoiceEnv): Promise<View> {
  const view = render(<App baseUrl={fake.url} store={memorySessionStore()} voice={env} />)
  const user = await waitFor(() => {
    const el = view.container.querySelector<HTMLInputElement>('input[name="username"]')
    if (!el) throw new Error('no login form')
    return el
  })
  const pass = view.container.querySelector<HTMLInputElement>('input[name="password"]')
  fireEvent.change(user, { target: { value: 'tony' } })
  if (pass) fireEvent.change(pass, { target: { value: 'jarvis' } })
  await act(async () => {
    const form = user.closest('form')
    if (form) fireEvent.submit(form)
  })
  await waitFor(() => {
    const box = view.container.querySelector('textarea')
    if (box?.getAttribute('placeholder') !== 'Message Keith') throw new Error('no thread yet')
  })
  return view
}

function slot(view: View, name: string): HTMLElement {
  const el = view.container.querySelector<HTMLElement>(`[data-slot="${name}"]`)
  if (!el) throw new Error(`no ${name}`)
  return el
}

describe('web app voice', () => {
  test('declares audio, opens the mic, streams 20 ms chunks and ends the stream', async () => {
    core = startFakeCore()
    const fake = fakeVoice()
    const view = await signedIn(core, fake.env)
    const hello = core.received.find((f) => f.type === 'hello')
    expect(hello?.type === 'hello' ? hello.data.capabilities : []).toEqual([
      'chat.text@1',
      'ui.render@1',
      'audio.in@1',
      'audio.out@1',
    ])

    await act(async () => {
      fireEvent.click(slot(view, 'mic-toggle'))
    })
    await waitFor(() => {
      if (slot(view, 'mic-toggle').getAttribute('data-state') !== 'on') throw new Error('mic not on')
    })
    expect(fake.resumed()).toBe(1)
    const started = core.received.find((f) => f.type === 'audio.start')
    expect(started).toMatchObject({ data: { threadId: core.thread.id, codec: 'pcm16', sampleRate: 16_000 } })

    const mic = fake.mics[0]
    for (let i = 0; i < 3; i++) mic?.onChunk(new Int16Array(320).fill(i))
    const fakeCore = core
    await waitUntil(() => fakeCore.receivedAudio.length === 3, 3000, 'audio frames')
    const streamId = started?.type === 'audio.start' ? started.data.streamId : ''
    expect(core.receivedAudio.map((f) => [f.kind, f.streamId, f.sequence, f.payload.byteLength])).toEqual([
      [1, streamId, 0, 640],
      [1, streamId, 1, 640],
      [1, streamId, 2, 640],
    ])

    await act(async () => {
      fireEvent.click(slot(view, 'mic-toggle'))
    })
    await waitUntil(() => fakeCore.received.some((f) => f.type === 'audio.end'), 3000, 'audio.end')
    expect(mic?.closed).toBe(true)
    expect(slot(view, 'mic-toggle').getAttribute('data-state')).toBe('off')
  })

  test('an open mic follows a thread switch: the old stream ends, the next chunk streams to the group', async () => {
    core = startFakeCore()
    const group = core.addGroup({ title: 'Mission' })
    const fake = fakeVoice()
    const view = await signedIn(core, fake.env)
    const fakeCore = core
    await act(async () => {
      fireEvent.click(slot(view, 'mic-toggle'))
    })
    await waitFor(() => {
      if (slot(view, 'mic-toggle').getAttribute('data-state') !== 'on') throw new Error('mic not on')
    })
    const item = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>(
        `[data-slot="sidebar"] [data-thread-id="${group.id}"]`,
      )
      if (!el) throw new Error('no group yet')
      return el
    })
    await act(async () => {
      fireEvent.click(item)
    })
    await waitFor(() => slot(view, 'group-header'))
    await waitUntil(() => fakeCore.received.some((f) => f.type === 'audio.end'), 3000, 'audio.end')
    fake.mics[0]?.onChunk(new Int16Array(320))
    await waitUntil(
      () => fakeCore.received.filter((f) => f.type === 'audio.start').length === 2,
      3000,
      'a second audio.start',
    )
    const starts = fakeCore.received.filter((f) => f.type === 'audio.start')
    expect(starts.map((f) => (f.type === 'audio.start' ? f.data.threadId : ''))).toEqual([
      fakeCore.thread.id,
      group.id,
    ])
    expect(slot(view, 'mic-toggle').getAttribute('data-state')).toBe('on')
  })

  test('hold to talk: pressing stops playback and opens a stream, releasing ends it', async () => {
    core = startFakeCore()
    const fake = fakeVoice()
    const view = await signedIn(core, fake.env)
    const fakeCore = core
    core.pushAudio({ chunks: [new Int16Array(240)], end: false })
    await waitFor(() => {
      if (slot(view, 'speaking').getAttribute('data-playing') !== 'true') throw new Error('not speaking')
    })

    await act(async () => {
      fireEvent.pointerDown(slot(view, 'push-to-talk'))
    })
    expect(fake.played[0]?.stopped).toBe(true)
    await waitFor(() => {
      if (slot(view, 'push-to-talk').getAttribute('data-state') !== 'on') throw new Error('not held')
    })
    expect(slot(view, 'speaking').getAttribute('data-playing')).toBe('false')
    fake.mics[0]?.onChunk(new Int16Array(320))
    await waitUntil(() => fakeCore.receivedAudio.length === 1, 3000, 'a frame')
    await act(async () => {
      fireEvent.pointerUp(slot(view, 'push-to-talk'))
    })
    await waitUntil(() => fakeCore.received.some((f) => f.type === 'audio.end'), 3000, 'audio.end')
    expect(fake.mics[0]?.closed).toBe(true)
  })

  test('shows listening from thread.state, and speaking while the core audio plays until audio.stop', async () => {
    core = startFakeCore()
    const fake = fakeVoice()
    const view = await signedIn(core, fake.env)
    await act(async () => {
      fireEvent.click(slot(view, 'mic-toggle'))
    })
    await waitFor(() => {
      if (slot(view, 'mic-toggle').getAttribute('data-state') !== 'on') throw new Error('mic not on')
    })
    core.setTurnState('listening')
    await waitFor(() => slot(view, 'listening'))

    const streamId = core.pushAudio({ chunks: [new Int16Array(240), new Int16Array(240)], end: false })
    await waitFor(() => {
      if (slot(view, 'speaking').getAttribute('data-playing') !== 'true') throw new Error('not speaking')
    })
    expect(fake.played).toHaveLength(2)
    core.stopAudio(streamId)
    await waitFor(() => {
      if (slot(view, 'speaking').getAttribute('data-playing') !== 'false') throw new Error('still speaking')
    })
    expect(fake.played.every((p) => p.stopped)).toBe(true)
  })

  test('a denied microphone shows an inline message and text chat keeps working', async () => {
    core = startFakeCore()
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    const fake = fakeVoice({ openError: denied })
    const view = await signedIn(core, fake.env)
    await act(async () => {
      fireEvent.click(slot(view, 'mic-toggle'))
    })
    await waitFor(() => {
      if (!slot(view, 'voice-error').textContent?.includes('denied')) throw new Error('no message')
    })
    expect(slot(view, 'mic-toggle').getAttribute('data-state')).toBe('off')
    expect(core.received.some((f) => f.type === 'audio.start')).toBe(false)

    const box = view.container.querySelector('textarea')
    if (!box) throw new Error('no composer')
    fireEvent.change(box, { target: { value: 'Typing instead.' } })
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    await waitFor(() => {
      const texts = [...view.container.querySelectorAll('[data-slot="message"]')].map((m) => m.textContent)
      if (!texts.some((t) => t?.includes('You said: Typing instead.'))) throw new Error('no reply')
    })
  })

  test('without voice support: no audio capability, disabled controls and the reason', async () => {
    core = startFakeCore()
    const fake = fakeVoice({ unavailable: 'Voice needs HTTPS or localhost. Text chat still works.' })
    const view = await signedIn(core, fake.env)
    const hello = core.received.find((f) => f.type === 'hello')
    expect(hello?.type === 'hello' ? hello.data.capabilities : []).toEqual(['chat.text@1', 'ui.render@1'])
    expect(slot(view, 'voice-unavailable').textContent).toContain('HTTPS')
    const toggle = slot(view, 'mic-toggle')
    expect(toggle.hasAttribute('disabled') || toggle.getAttribute('aria-disabled') === 'true').toBe(true)
  })
})
