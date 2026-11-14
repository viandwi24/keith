import { describe, expect, test } from 'bun:test'
import { templateToBody } from '../prefrontal/index.ts'
import { GUEST_ERROR_TEXT, scrubChunk, scrubEvent, scrubResponse } from './guest-scrub.ts'

describe('guest stream scrub', () => {
  test('usage, context, notices and warnings are dropped; the text and the stop reason stay', () => {
    expect(scrubChunk({ type: 'data-eh.usage', data: { costUsd: 1 } })).toBeUndefined()
    expect(scrubChunk({ type: 'data-eh.context', data: { window: 1 } })).toBeUndefined()
    expect(
      scrubChunk({ type: 'data-eh.notice', data: { text: 'provider x failed' } }),
    ).toBeUndefined()
    expect(scrubChunk({ type: 'data-eh.warning', data: {} })).toBeUndefined()
    expect(scrubChunk({ type: 'unknown-future-chunk' })).toBeUndefined()
    expect(scrubChunk({ type: 'text-delta', id: 't0', delta: 'hi' })).toEqual({
      type: 'text-delta',
      id: 't0',
      delta: 'hi',
    })
    expect(
      scrubChunk({
        type: 'message-metadata',
        messageMetadata: {
          eharness: { model: 'p/m', usage: { costUsd: 1 }, stop: 'complete', durationMs: 5 },
        },
      }),
    ).toEqual({ type: 'message-metadata', messageMetadata: { eharness: { stop: 'complete' } } })
    expect(
      scrubChunk({ type: 'start', messageId: 'm', messageMetadata: { eharness: { turnId: 't' } } }),
    ).toEqual({ type: 'start', messageId: 'm' })
  })

  test('an error chunk never carries the real message', () => {
    expect(scrubChunk({ type: 'error', errorText: 'openrouter: 401 bad key sk-x' })).toEqual({
      type: 'error',
      errorText: GUEST_ERROR_TEXT,
    })
  })

  test('after a template switch the visitor sees the new template line (read at the error)', async () => {
    let line = templateToBody('professional').lines.guestUnavailable
    const read = () => line
    expect(scrubChunk({ type: 'error', errorText: 'x' }, read)).toEqual({
      type: 'error',
      errorText: 'The assistant is unavailable. Please try again.',
    })
    line = templateToBody('friend').lines.guestUnavailable
    expect(scrubChunk({ type: 'error', errorText: 'x' }, read)).toEqual({
      type: 'error',
      errorText: "I can't help right now, try again in a bit.",
    })
    const source = `data: {"type":"error","errorText":"provider 500"}\n\n`
    const res = scrubResponse(
      new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
      read,
    )
    expect(await res.text()).toBe(
      `data: ${JSON.stringify({ type: 'error', errorText: "I can't help right now, try again in a bit." })}\n\n`,
    )
  })

  test('the default error text is the professional template line', () => {
    expect(GUEST_ERROR_TEXT).toBe('The assistant is unavailable. Please try again.')
  })

  test('events: [DONE] passes, keep-alive comments and garbage are dropped', () => {
    expect(scrubEvent('data: [DONE]')).toBe('data: [DONE]\n\n')
    expect(scrubEvent(': keep-alive')).toBeUndefined()
    expect(scrubEvent('data: {not json')).toBeUndefined()
  })

  test('a stream split at arbitrary byte boundaries is scrubbed whole', async () => {
    const events = [
      'data: {"type":"start","messageId":"m","messageMetadata":{"eharness":{"turnId":"t"}}}',
      'data: {"type":"data-eh.usage","data":{"costUsd":0.1}}',
      'data: {"type":"text-delta","id":"t0","delta":"hé"}',
      'data: {"type":"message-metadata","messageMetadata":{"eharness":{"model":"pricey/cheap","stop":"complete"}}}',
      'data: [DONE]',
    ]
    const bytes = new TextEncoder().encode(`${events.join('\n\n')}\n\n`)
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    })
    const res = scrubResponse(
      new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
    )
    const text = await res.text()
    expect(text).toContain('"delta":"hé"')
    expect(text).toContain('[DONE]')
    for (const secret of ['pricey', 'cheap', 'costUsd', 'turnId', 'data-eh.usage'])
      expect(text).not.toContain(secret)
  })

  test('a JSON answer is untouched', async () => {
    const res = scrubResponse(Response.json({ target: 'idle' }))
    expect(await res.json()).toEqual({ target: 'idle' })
  })
})
