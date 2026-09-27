import { describe, expect, test } from 'bun:test'
import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_FRAME_KIND,
  AUDIO_FRAME_MAX_BYTES,
  type AudioFrame,
  decodeAudioFrame,
  encodeAudioFrame,
} from './audio.ts'

const streamId = '01J8ZQ3K4M5N6P7Q8R9S0T1V50'

function frame(over: Partial<AudioFrame> = {}): AudioFrame {
  return {
    kind: AUDIO_FRAME_KIND.in,
    streamId,
    sequence: 7,
    payload: new Uint8Array([1, 2, 3, 4]),
    ...over,
  }
}

describe('binary audio frames', () => {
  test('encode → decode round-trips kind, streamId, sequence and payload', () => {
    for (const f of [
      frame(),
      frame({ kind: AUDIO_FRAME_KIND.out, sequence: 0 }),
      frame({ sequence: 0xffff_ffff, payload: new Uint8Array(0) }),
      frame({ streamId: '00000000000000000000000000' }),
      frame({ streamId: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ' }),
    ]) {
      expect(decodeAudioFrame(encodeAudioFrame(f))).toEqual({ ok: true, frame: f })
    }
  })

  test('the header layout is kind, 16 raw ULID bytes, uint32 big-endian sequence', () => {
    const bytes = encodeAudioFrame(frame({ streamId: '00000000000000000000000001', sequence: 0x01020304 }))
    expect(bytes.byteLength).toBe(AUDIO_FRAME_HEADER_BYTES + 4)
    expect(bytes[0]).toBe(1)
    expect([...bytes.subarray(1, 16)].every((b) => b === 0)).toBe(true)
    expect(bytes[16]).toBe(1)
    expect([...bytes.subarray(17, 21)]).toEqual([1, 2, 3, 4])
    expect([...bytes.subarray(21)]).toEqual([1, 2, 3, 4])
  })

  test('decodes a view into a larger buffer and returns a payload usable as Int16Array', () => {
    const encoded = encodeAudioFrame(frame({ payload: new Uint8Array(new Int16Array([1000, -1000]).buffer) }))
    const padded = new Uint8Array(encoded.byteLength + 3)
    padded.set(encoded, 3)
    const result = decodeAudioFrame(padded.subarray(3))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { payload } = result.frame
    expect(payload.byteOffset).toBe(0)
    expect([...new Int16Array(payload.buffer, 0, payload.byteLength >> 1)]).toEqual([1000, -1000])
  })

  test('accepts an ArrayBuffer', () => {
    const encoded = encodeAudioFrame(frame())
    const copy = encoded.slice().buffer
    expect(decodeAudioFrame(copy)).toEqual({ ok: true, frame: frame() })
  })

  test('rejects a buffer shorter than the header', () => {
    for (const size of [0, 1, AUDIO_FRAME_HEADER_BYTES - 1]) {
      expect(decodeAudioFrame(new Uint8Array(size))).toMatchObject({ ok: false, code: 'INVALID_FRAME' })
    }
  })

  test('rejects an unknown kind', () => {
    for (const kind of [0, 3, 255]) {
      const bytes = encodeAudioFrame(frame())
      bytes[0] = kind
      expect(decodeAudioFrame(bytes)).toMatchObject({ ok: false, code: 'INVALID_FRAME' })
    }
  })

  test('rejects a frame over the size limit', () => {
    expect(decodeAudioFrame(new Uint8Array(AUDIO_FRAME_MAX_BYTES + 1).fill(1))).toMatchObject({
      ok: false,
      code: 'INVALID_FRAME',
    })
  })

  test('encode throws on sender bugs', () => {
    expect(() => encodeAudioFrame(frame({ streamId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V50' }))).toThrow(RangeError)
    expect(() => encodeAudioFrame(frame({ sequence: -1 }))).toThrow(RangeError)
    expect(() => encodeAudioFrame(frame({ sequence: 2 ** 32 }))).toThrow(RangeError)
    expect(() => encodeAudioFrame(frame({ kind: 3 as AudioFrame['kind'] }))).toThrow(RangeError)
    expect(() => encodeAudioFrame(frame({ payload: new Uint8Array(AUDIO_FRAME_MAX_BYTES) }))).toThrow(
      RangeError,
    )
  })
})
