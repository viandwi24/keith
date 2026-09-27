import { describe, expect, test } from 'bun:test'
import { KeithError } from '@keith/sdk'
import { parseConfig } from './load.ts'

function caught(fn: () => unknown): KeithError {
  try {
    fn()
  } catch (error) {
    if (error instanceof KeithError) return error
    throw error
  }
  throw new Error('expected a throw')
}

describe('[voice] config (phase 3)', () => {
  test('a missing [voice] section gives voice: undefined (voice off)', () => {
    const c = parseConfig({}, { env: {} })
    expect(c.voice).toBeUndefined()
  })

  test('defaults apply when the section names its providers', () => {
    const c = parseConfig({ voice: { vad: 'energy', stt: 'groq', tts: 'openai' } }, { env: {} })
    expect(c.voice).toEqual({
      vad: 'energy',
      stt: 'groq',
      tts: 'openai',
      maxUtteranceMs: 30_000,
      bargeIn: true,
      bargeInMinMs: 300,
    })
  })

  test('every key can be set', () => {
    const voice = {
      vad: 'energy',
      stt: 'speaches',
      tts: 'speaches',
      language: 'en',
      maxUtteranceMs: 15_000,
      bargeIn: false,
      bargeInMinMs: 0,
    }
    expect(parseConfig({ voice }, { env: {} }).voice).toEqual(voice)
  })

  test('a section without its provider ids is an error naming the key', () => {
    const e = caught(() => parseConfig({ voice: { vad: 'energy', stt: 'groq' } }, { env: {} }))
    expect(e.code).toBe('CONFIG_INVALID')
    expect(e.message).toContain('voice.tts')
  })

  test('unknown keys and invalid values are errors naming the key', () => {
    const base = { vad: 'energy', stt: 'groq', tts: 'openai' }
    expect(
      caught(() => parseConfig({ voice: { ...base, wakeWord: 'keith' } }, { env: {} })).message,
    ).toContain('voice.wakeWord')
    expect(
      caught(() => parseConfig({ voice: { ...base, bargeInMinMs: -1 } }, { env: {} })).message,
    ).toContain('voice.bargeInMinMs')
    expect(
      caught(() => parseConfig({ voice: { ...base, maxUtteranceMs: 0 } }, { env: {} })).message,
    ).toContain('voice.maxUtteranceMs')
  })

  test('KEITH__VOICE__ overrides are not supported (the section has no defaults to override)', () => {
    const e = caught(() => parseConfig({}, { env: { KEITH__VOICE__STT: 'groq' } }))
    expect(e.message).toContain('KEITH__VOICE__STT')
  })
})
