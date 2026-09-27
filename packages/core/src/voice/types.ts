// The voice pipeline's interfaces: audio in from nodes, speech out to the focus node.
// See docs/architecture/voice.md and ADR-0013. Implemented by voice/ (task P3-A1); the server
// calls VoiceInput (P3-A2), the Mind calls VoiceOutput (P3-A2).

import type { AudioCodec, AudioStreamId } from '@keith/protocol'
import type { MessageId, NodeId, PersonId, ThreadId } from '../shared/types.ts'

/** Why `VoiceInput.start` refused a stream. The server replies `error { INVALID_FRAME, message }`. */
export type VoiceStartResult = { ok: true } | { ok: false; code: 'INVALID_FRAME'; message: string }

/**
 * Audio from nodes, one stream per `audio.start` … `audio.end`. The server checks `audio.in@1`
 * and that the node has the thread open before calling `start`. No method throws.
 */
export interface VoiceInput {
  /**
   * An `audio.start` frame. Refused (not thrown) when voice is off, the codec or rate is not
   * supported (v1: `pcm16` only), or the stream id is already in use.
   */
  start(a: {
    nodeId: NodeId
    personId: PersonId
    threadId: ThreadId
    streamId: AudioStreamId
    codec: AudioCodec
    sampleRate: number
  }): VoiceStartResult
  /**
   * A kind-1 binary frame. Returns false when the node has no open stream with this id (the
   * server replies `INVALID_FRAME`). Out-of-order chunks of an open stream are dropped and
   * logged at debug, and still return true.
   */
  chunk(a: { nodeId: NodeId; streamId: AudioStreamId; sequence: number; payload: Uint8Array }): boolean
  /**
   * An `audio.end` frame: the buffered utterance, if any, goes to STT. Returns false when the node
   * has no open stream with this id.
   */
  end(a: { nodeId: NodeId; streamId: AudioStreamId }): boolean
  /** The node's socket closed: drop its open streams without running STT. */
  detach(nodeId: NodeId): void
}

/** Speaks assistant replies. The Mind calls it only for audio-modality turns (voice.md). */
export interface VoiceOutput {
  /**
   * Starts speaking `messageId` on `nodeId` (the focus node). Returns null when voice is off or
   * the node lacks `audio.out@1`; the reply is then text only.
   */
  begin(a: { threadId: ThreadId; nodeId: NodeId; messageId: MessageId }): SpeechHandle | null
}

/**
 * One spoken reply. Text is cut into sentences and spoken in order; the audio goes to the node as
 * `audio.start`, kind-2 binary frames, then `audio.end`.
 */
export interface SpeechHandle {
  /** A text delta of the assistant message, in order. Ignored after `end` or `stop`. */
  push(text: string): void
  /** No more text: speak what is buffered, then send `audio.end`. */
  end(): void
  /**
   * Barge-in or cancel: aborts TTS, sends `audio.stop` if audio was started, and returns
   * `spokenChars`, the characters of the pushed text whose audio was fully sent. Idempotent: a
   * later call returns the same number.
   */
  stop(): number
  /**
   * Settles when the last frame was sent after `end`, or right after `stop`. Never rejects: a TTS
   * error is logged and ends the speech early.
   */
  done: Promise<void>
}
