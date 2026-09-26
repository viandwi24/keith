import { describe, expect, test } from 'bun:test'
import { SseDecoder } from './sse.ts'

describe('SseDecoder', () => {
  test('yields data payloads and skips comments', () => {
    const sse = new SseDecoder()
    const out = sse.push(': OPENROUTER PROCESSING\n\ndata: {"a":1}\n\ndata: [DONE]\n\n')
    expect(out).toEqual(['{"a":1}', '[DONE]'])
  })

  test('reassembles events split across pieces, including a split CRLF', () => {
    const sse = new SseDecoder()
    expect(sse.push('da')).toEqual([])
    expect(sse.push('ta: hel')).toEqual([])
    expect(sse.push('lo\r')).toEqual([])
    expect(sse.push('\n\r\n')).toEqual(['hello'])
  })

  test('joins multi-line data and ignores other fields', () => {
    const sse = new SseDecoder()
    expect(sse.push('event: message\nid: 7\ndata: one\ndata:two\n\n')).toEqual(['one\ntwo'])
  })

  test('delivers an unterminated last event at the end', () => {
    const sse = new SseDecoder()
    expect(sse.push('data: tail')).toEqual([])
    expect(sse.end()).toEqual(['tail'])
  })
})
