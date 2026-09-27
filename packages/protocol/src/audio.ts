// Audio on the wire (phase 3): the codec enum, stream ids, and the binary frame header.
// See docs/contracts/protocol.md#audio-phase-3 and ADR-0013.

import { z } from 'zod'
import { Ulid } from './ids.ts'

/**
 * Audio codecs a stream may declare. v1 carries only `pcm16` (16-bit little-endian mono);
 * `opus` is reserved and the v1 core refuses it with `INVALID_FRAME` (ADR-0013).
 */
export const AUDIO_CODECS = ['pcm16', 'opus'] as const
export const AudioCodec = z.enum(AUDIO_CODECS)
export type AudioCodec = z.infer<typeof AudioCodec>

/** Sample rates a stream may declare, in Hz. Nodes send 16 000 in v1; the core sends the TTS rate. */
export const AUDIO_SAMPLE_RATE = { min: 8_000, max: 48_000 } as const
export const SampleRate = z.number().int().min(AUDIO_SAMPLE_RATE.min).max(AUDIO_SAMPLE_RATE.max)
export type SampleRate = z.infer<typeof SampleRate>

/**
 * An audio stream id: a bare ULID (no prefix), because the binary header carries its 16 raw
 * bytes. The sender of `audio.start` generates it; it lives only as long as the stream.
 */
export const AudioStreamId = Ulid
export type AudioStreamId = z.infer<typeof AudioStreamId>

/** Binary frame kinds: byte 0 of the header. */
export const AUDIO_FRAME_KIND = {
  /** node → core: a chunk of an `audio.start` stream sent by the node. */
  in: 1,
  /** core → node: a chunk of an `audio.start` stream sent by the core. */
  out: 2,
} as const
export type AudioFrameKind = (typeof AUDIO_FRAME_KIND)[keyof typeof AUDIO_FRAME_KIND]

/** kind (1) + streamId (16) + sequence (4). */
export const AUDIO_FRAME_HEADER_BYTES = 21
/** Largest binary frame, header included. Senders split bigger chunks. */
export const AUDIO_FRAME_MAX_BYTES = 64 * 1024
/** `sequence` is a uint32. */
export const AUDIO_SEQUENCE_MAX = 0xffff_ffff

/** A decoded binary frame. */
export type AudioFrame = {
  kind: AudioFrameKind
  streamId: AudioStreamId
  /** Per stream, starting at 0 and increasing by 1. */
  sequence: number
  /** The codec payload, e.g. PCM16LE samples. */
  payload: Uint8Array
}

export type AudioFrameParseResult =
  | { ok: true; frame: AudioFrame }
  | { ok: false; code: 'INVALID_FRAME'; message: string }

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_BYTES = 16

function ulidToBytes(ulid: string): Uint8Array {
  let value = 0n
  for (const char of ulid) value = (value << 5n) | BigInt(CROCKFORD.indexOf(char))
  const bytes = new Uint8Array(ULID_BYTES)
  for (let i = ULID_BYTES - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return bytes
}

function bytesToUlid(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let out = ''
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD.charAt(Number(value & 31n)) + out
    value >>= 5n
  }
  return out
}

function isFrameKind(kind: number): kind is AudioFrameKind {
  return kind === AUDIO_FRAME_KIND.in || kind === AUDIO_FRAME_KIND.out
}

/**
 * Builds a binary frame. Throws `RangeError` on an invalid kind, stream id or sequence, or when
 * the frame would exceed `AUDIO_FRAME_MAX_BYTES` (these are sender bugs, not wire input).
 */
export function encodeAudioFrame(frame: AudioFrame): Uint8Array {
  if (!isFrameKind(frame.kind)) throw new RangeError(`invalid audio frame kind ${frame.kind}`)
  if (!AudioStreamId.safeParse(frame.streamId).success) {
    throw new RangeError('audio frame streamId must be a ULID')
  }
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > AUDIO_SEQUENCE_MAX) {
    throw new RangeError('audio frame sequence must be a uint32')
  }
  const size = AUDIO_FRAME_HEADER_BYTES + frame.payload.byteLength
  if (size > AUDIO_FRAME_MAX_BYTES) throw new RangeError(`audio frame of ${size} bytes is too large`)
  const out = new Uint8Array(size)
  out[0] = frame.kind
  out.set(ulidToBytes(frame.streamId), 1)
  new DataView(out.buffer).setUint32(1 + ULID_BYTES, frame.sequence, false)
  out.set(frame.payload, AUDIO_FRAME_HEADER_BYTES)
  return out
}

/**
 * Parses a binary WS message. The returned `payload` is a copy that starts at byte offset 0 of
 * its own buffer, so `new Int16Array(payload.buffer, 0, payload.byteLength >> 1)` works for PCM16.
 */
export function decodeAudioFrame(input: ArrayBuffer | ArrayBufferView): AudioFrameParseResult {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (bytes.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    return { ok: false, code: 'INVALID_FRAME', message: 'binary frame is shorter than its header' }
  }
  if (bytes.byteLength > AUDIO_FRAME_MAX_BYTES) {
    return { ok: false, code: 'INVALID_FRAME', message: 'binary frame is too large' }
  }
  const kind = bytes[0] ?? 0
  if (!isFrameKind(kind)) {
    return { ok: false, code: 'INVALID_FRAME', message: `unknown binary frame kind ${kind}` }
  }
  const idBytes = bytes.subarray(1, 1 + ULID_BYTES)
  // A ULID holds 128 bits in 26 base32 characters; the top 2 of the 130 are always zero.
  const streamId = bytesToUlid(idBytes)
  const sequence = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    1 + ULID_BYTES,
    false,
  )
  const payload = bytes.slice(AUDIO_FRAME_HEADER_BYTES)
  return { ok: true, frame: { kind, streamId, sequence, payload } }
}
