import { describe, expect, test } from 'bun:test'
import { FrameEnvelope, makeFrame, parseFrameWith } from './envelope.ts'
import { parseCoreFrame } from './frames/core-to-node.ts'
import { parseNodeFrame } from './frames/node-to-core.ts'

describe('FrameEnvelope', () => {
  const base = { v: 1, type: 'ping', id: 'f1', ts: 1790000000000, data: {} }

  test('accepts a minimal envelope', () => {
    expect(FrameEnvelope.safeParse(base).success).toBe(true)
  })
  test.each([
    ['v is 2', { ...base, v: 2 }],
    ['id is empty', { ...base, id: '' }],
    ['id is longer than 64', { ...base, id: 'x'.repeat(65) }],
    ['ts is negative', { ...base, ts: -1 }],
    ['ts is fractional', { ...base, ts: 1.5 }],
    ['data is an array', { ...base, data: [] }],
    ['data is missing', { v: 1, type: 'ping', id: 'f1', ts: 1 }],
    ['type is empty', { ...base, type: '' }],
  ])('rejects when %s', (_name, value) => {
    expect(FrameEnvelope.safeParse(value).success).toBe(false)
  })
})

describe('makeFrame', () => {
  test('uses the given id and ts and omits re when not given', () => {
    expect(makeFrame('pong', {}, { id: 'a', ts: 5 })).toEqual({
      v: 1,
      type: 'pong',
      id: 'a',
      ts: 5,
      data: {},
    })
  })
  test('sets re when given', () => {
    const frame = makeFrame('error', { code: 'UNKNOWN_FRAME', message: 'x' }, { id: 'b', ts: 6, re: 'a' })
    expect(frame.re).toBe('a')
  })
})

describe('parse failures', () => {
  test('text that is not JSON → INVALID_FRAME', () => {
    expect(parseNodeFrame('{nope')).toEqual({
      ok: false,
      code: 'INVALID_FRAME',
      message: 'frame is not valid JSON',
    })
  })
  test('JSON that is not an object → INVALID_FRAME', () => {
    expect(parseNodeFrame('[1]')).toMatchObject({ ok: false, code: 'INVALID_FRAME' })
    expect(parseCoreFrame('null')).toMatchObject({ ok: false, code: 'INVALID_FRAME' })
  })
  test('envelope v other than 1 → UNSUPPORTED_PROTOCOL', () => {
    expect(parseNodeFrame({ v: 2, type: 'pong', id: 'x', ts: 1, data: {} })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_PROTOCOL',
      frameId: 'x',
    })
  })
  test('broken envelope keeps the frame id for the error reply', () => {
    expect(parseNodeFrame({ v: 1, type: 'pong', id: 'x', data: {} })).toMatchObject({
      ok: false,
      code: 'INVALID_FRAME',
      frameId: 'x',
    })
  })
  test('type names from Object.prototype are unknown, not crashes', () => {
    expect(parseFrameWith({ v: 1, type: 'toString', id: 'x', ts: 1, data: {} }, {})).toMatchObject({
      ok: false,
      code: 'UNKNOWN_FRAME',
    })
  })
})
