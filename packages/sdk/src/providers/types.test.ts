import { describe, expect, test } from 'bun:test'
import type { OpenAICompatibleSttOptions, OpenAICompatibleTtsOptions } from './openai-audio.ts'
import type { AudioChunk, SttOptions, TtsOptions } from './types.ts'

const doc = () => Bun.file(new URL('../../../../docs/contracts/providers.md', import.meta.url)).text()

/** Field names of the `{ … }` that follows `marker` in the doc (top level only, comments dropped). */
function docFields(markdown: string, marker: string): string[] {
  const at = markdown.indexOf(marker)
  if (at < 0) throw new Error(`providers.md has no ${marker}`)
  const open = markdown.indexOf('{', at)
  let depth = 0
  let parens = 0
  let body = ''
  for (let i = open; i < markdown.length; i++) {
    const ch = markdown[i]
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === '(') parens++
    if (ch === ')') parens--
    if (depth === 0) break
    // Function parameter lists, e.g. `(form: FormData, opts: SttOptions)`, are not fields.
    if (depth === 1 && parens === 0 && ch !== ')' && i > open) body += ch
  }
  const withoutComments = body.replace(/\/\/[^\n]*/g, '')
  return [...withoutComments.matchAll(/(?:^|[\s;])(\w+)\??:/g)].map((m) => m[1] ?? '').sort()
}

const noop = () => undefined as never

// `satisfies Required<T>` makes each sample list exactly the type's fields.
const codeFields = {
  'type AudioChunk =': Object.keys({
    data: new Uint8Array(),
    codec: 'pcm16',
    sampleRate: 16_000,
  } satisfies Required<AudioChunk>),
  'type SttOptions =': Object.keys({ language: 'en', prompt: 'Keith' } satisfies Required<SttOptions>),
  'type TtsOptions =': Object.keys({ voice: 'alloy', language: 'en' } satisfies Required<TtsOptions>),
  'function createOpenAICompatibleStt(opts:': Object.keys({
    id: 'groq',
    baseUrl: 'https://example.com/v1',
    apiKey: 'k',
    model: 'm',
    headers: {},
    fetch,
    mapRequest: noop,
  } satisfies Required<OpenAICompatibleSttOptions>),
  'function createOpenAICompatibleTts(opts:': Object.keys({
    id: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    sampleRate: 24_000,
    headers: {},
    fetch,
    mapRequest: noop,
  } satisfies Required<OpenAICompatibleTtsOptions>),
}

describe('voice provider types match providers.md', () => {
  for (const [marker, fields] of Object.entries(codeFields)) {
    test(marker, async () => {
      expect(docFields(await doc(), marker)).toEqual([...fields].sort())
    })
  }
})
