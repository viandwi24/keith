import { describe, expect, test } from 'bun:test'
import type { ClientRecord } from '@keith/contracts'
import { chooseMode, type ModeChoice, type ModeInput, modeForClients, pickChannel } from './mode.ts'
import {
  CHAT_PLAIN_TEXT,
  CHAT_TEXT,
  modeText,
  REPORT_TEXT,
  SCREEN_TEXT,
  SPEECH_TEXT,
} from './mode-text.ts'

const SPEECH = { capabilities: ['render.speech-only'] }
const MARKDOWN = { capabilities: ['render.markdown'] }
const PLAIN = { capabilities: ['notify'] }

describe('chooseMode (the table of P33 "Modes")', () => {
  const cases: Array<{ name: string; input: ModeInput } & ModeChoice> = [
    {
      name: 'speech channel answers in speech',
      input: { requestKind: 'chat' as const, channel: SPEECH, hasScreen: false },
      mode: 'speech',
      plain: true,
      speech: true,
      screen: false,
    },
    {
      name: 'speech person with a second screen: the detail goes to the screen',
      input: { requestKind: 'chat' as const, channel: SPEECH, hasScreen: true },
      mode: 'speech',
      plain: true,
      speech: true,
      screen: true,
    },
    {
      name: 'report on a speech channel is report, and still speakable',
      input: { requestKind: 'report' as const, channel: SPEECH, hasScreen: false },
      mode: 'report',
      plain: true,
      speech: true,
      screen: false,
    },
    {
      name: 'report on a markdown channel',
      input: { requestKind: 'report' as const, channel: MARKDOWN, hasScreen: false },
      mode: 'report',
      plain: false,
      speech: false,
      screen: false,
    },
    {
      name: 'markdown channel is chat with Markdown allowed',
      input: { requestKind: 'chat' as const, channel: MARKDOWN, hasScreen: false },
      mode: 'chat',
      plain: false,
      speech: false,
      screen: false,
    },
    {
      name: 'channel without render ids is chat in plain text',
      input: { requestKind: 'chat' as const, channel: PLAIN, hasScreen: false },
      mode: 'chat',
      plain: true,
      speech: false,
      screen: false,
    },
    {
      name: 'no channel at all is chat in plain text',
      input: { requestKind: 'chat' as const, channel: undefined, hasScreen: false },
      mode: 'chat',
      plain: true,
      speech: false,
      screen: false,
    },
    {
      name: 'a screen does not change a chat answer',
      input: { requestKind: 'chat' as const, channel: MARKDOWN, hasScreen: true },
      mode: 'chat',
      plain: false,
      speech: false,
      screen: false,
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const { name: _name, input, ...expected } = c
      expect(chooseMode(input)).toEqual(expected)
    })
  }
})

describe('mode text', () => {
  test('the speech, chat and report blocks are the fixed plan text', () => {
    expect(SPEECH_TEXT).toStartWith('Imagine this is read aloud over the phone.')
    expect(SPEECH_TEXT).toContain('offer to show the details on screen or in a document.')
    expect(CHAT_TEXT).toBe('Be brief. Use Markdown only when a client renders it and it helps.')
    expect(REPORT_TEXT).toBe(
      'Start with a conclusion of one to three sentences. Then offer the details.',
    )
  })

  test('each mode gives its block; a plain chat channel never gets the Markdown line', () => {
    expect(modeText(chooseMode({ requestKind: 'chat', channel: SPEECH, hasScreen: false }))).toBe(
      SPEECH_TEXT,
    )
    expect(modeText(chooseMode({ requestKind: 'chat', channel: SPEECH, hasScreen: true }))).toBe(
      `${SPEECH_TEXT}\n${SCREEN_TEXT}`,
    )
    expect(
      modeText(chooseMode({ requestKind: 'report', channel: MARKDOWN, hasScreen: false })),
    ).toBe(REPORT_TEXT)
    expect(modeText(chooseMode({ requestKind: 'chat', channel: MARKDOWN, hasScreen: false }))).toBe(
      CHAT_TEXT,
    )
    expect(modeText(chooseMode({ requestKind: 'chat', channel: PLAIN, hasScreen: false }))).toBe(
      CHAT_PLAIN_TEXT,
    )
    expect(CHAT_PLAIN_TEXT).toContain('Plain text only')
  })
})

function client(id: string, over: Partial<ClientRecord>): ClientRecord {
  return {
    id,
    kind: 'tui',
    label: id,
    capabilities: [],
    version: '1',
    personId: 'ana',
    firstSeenAt: 0,
    lastSeenAt: 100,
    lastActiveAt: null,
    online: true,
    ...over,
  } as ClientRecord
}

describe('channel lookup from the client list (read only)', () => {
  test('the most recently active online client is the channel', () => {
    const tui = client('11111111-1111-4111-8111-111111111111', { lastActiveAt: 500 })
    const phone = client('22222222-2222-4222-8222-222222222222', {
      kind: 'mobile',
      capabilities: ['render.speech-only'],
      lastActiveAt: 900,
    })
    const picked = pickChannel([tui, phone])
    expect(picked.channel?.capabilities).toEqual(['render.speech-only'])
    expect(picked.hasScreen).toBe(false)
  })

  test('a speech channel with an online Markdown screen has a screen', () => {
    const phone = client('22222222-2222-4222-8222-222222222222', {
      capabilities: ['render.speech-only'],
      lastActiveAt: 900,
    })
    const tui = client('11111111-1111-4111-8111-111111111111', {
      capabilities: ['render.markdown'],
      lastActiveAt: 100,
    })
    expect(pickChannel([phone, tui]).hasScreen).toBe(true)
    expect(modeForClients([phone, tui]).screen).toBe(true)
  })

  test('an offline client is never the channel; no client gives plain chat', () => {
    const gone = client('11111111-1111-4111-8111-111111111111', {
      online: false,
      capabilities: ['render.speech-only'],
      lastActiveAt: 999,
    })
    expect(modeForClients([gone])).toEqual({
      mode: 'chat',
      plain: true,
      speech: false,
      screen: false,
    })
    expect(modeForClients([])).toEqual({ mode: 'chat', plain: true, speech: false, screen: false })
  })

  test('a client that declares no render id gets plain text', () => {
    const tui = client('11111111-1111-4111-8111-111111111111', { capabilities: ['notify'] })
    expect(modeForClients([tui])).toEqual({
      mode: 'chat',
      plain: true,
      speech: false,
      screen: false,
    })
  })
})
