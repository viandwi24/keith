---
id: P3-A1
title: "Core voice pipeline: VAD → STT per stream, TTS per reply"
phase: 3
wave: 2
lane: A
status: review
owner: agent-P3-A1
depends: [P3-K1]
owns:
  - packages/core/src/voice/**
reads:
  - docs/architecture/voice.md
  - docs/contracts/providers.md
  - docs/contracts/protocol.md
  - docs/architecture/core.md
  - docs/decisions/0013-voice-v1-transport-and-providers.md
updates:
  - docs/architecture/voice.md
scenarios: [S-7]
---

# P3-A1: Core voice pipeline

## Goal

`packages/core/src/voice/` implements the `VoiceInput` and `VoiceOutput` interfaces that P3-K1 wrote in `voice/types.ts`. Audio from a node becomes a transcript that goes to the Thread, and an assistant reply becomes audio chunks sent to the focus node. The pipeline knows providers only through the SDK interfaces and the Mind only through `ThreadManager`.

## Scope

**In:**
- `createVoice(deps)` in `voice/index.ts`, returning `{ input: VoiceInput; output: VoiceOutput }`. Deps: provider registries (the `stt`/`tts`/`vad` lists), `config.voice`, the `ThreadManager` (the `input` and `voiceActivity` members), a binary sink (`AttachmentRegistry.sendBinary` + `send`), ids, clock, log.
- **Input, per `streamId`:** decode the payload for the declared codec to PCM16 (ADR-0013 says which codecs v1 accepts), push to a `VadStream`. `speech.start` → `ThreadManager.voiceActivity({ speaking: true })`. `speech.end`, or `audio.end`, or `voice.maxUtteranceMs` → STT (`transcribe` on the buffered utterance, or `stream` when the provider has only that) → `ThreadManager.input({ modality: 'audio', text })`. An empty transcript produces no input and sends `voiceActivity({ speaking: false })`.
- **Output:** `begin({ threadId, nodeId, messageId })` returns a `SpeechHandle`. It is `null` when voice is off or the node lacks `audio.out@1`. Text deltas are cut into sentences, TTS runs on them in order, and each audio chunk goes to the node as a binary frame (kind 2) framed by `audio.start` / `audio.end` core frames (P3-K1). `stop()` cancels TTS, sends `audio.stop`, and returns `spokenChars`: the characters whose audio was fully sent. It never counts text that was still queued.
- Out-of-order or unknown `streamId` chunks are dropped and logged at debug. They never throw into the server.
- Tests use fake VAD/STT/TTS providers and a fake `ThreadManager` built from the `types.ts` interfaces, in `packages/core/src/voice/*.test.ts`.

**Out:** frame parsing and routing in the server, and Mind state changes (P3-A2). Real provider adapters (P3-B1, C1, D1). Bootstrap wiring (P3-I1).

## Acceptance criteria

- [x] A synthetic utterance (PCM16 speech between silences, with a fake VAD) produces exactly one `ThreadManager.input` with `modality: 'audio'` and the fake STT's text.
- [x] `speech.start` / `speech.end` map to `voiceActivity` calls, and an empty transcript produces no input.
- [x] `maxUtteranceMs` forces an STT run.
- [x] TTS output: sentences are sent in order, each chunk is a valid kind-2 binary frame with increasing `sequence`, between `audio.start` and `audio.end`.
- [x] `stop()` mid-reply: the fake TTS signal is aborted, `audio.stop` is sent, and `spokenChars` equals the characters of the sentences fully sent.
- [x] Voice off (no `config.voice`): `begin` returns null, and input streams are refused with a logged warning.
- [x] `bun run check` passes.

## Notes

- Sentence splitting: keep it simple (`.`, `!`, `?`, newline, plus a length cap). Don't add an NLP dependency.
- Resampling: if the VAD or STT needs 16 kHz and the node sends another rate, resample in `voice/` (linear is fine for v1). Record this in voice.md.

## Outcome

**Built** (`packages/core/src/voice/`):

- `index.ts`: `createVoice(deps)` → `{ input, output }`; re-exports the `types.ts` interfaces and `AUDIO_OUT_CAPABILITY`.
- `deps.ts`: `VoiceDeps` (provider lists, `config.voice`, `ThreadManager` `input`/`voiceActivity`, `AttachmentRegistry` `send`/`sendBinary`, `capabilities(nodeId)`, ids, clock, log).
- `input.ts`: `VoiceInput`. Per `(nodeId, streamId)`: PCM16LE decode, linear resample to 16 kHz, `VadStream`, 300 ms pre-roll, STT on `speech.end` / `audio.end` / `maxUtteranceMs`, `voiceActivity` mapping, per-stream serialized STT, `detach` aborts.
- `output.ts`: `VoiceOutput` / `SpeechHandle`. Sentence pieces → `TtsProvider.stream` in order → `audio.start` (announcing the TTS rate), kind-2 frames split at 64 KiB with increasing `sequence`, `audio.end`; `stop()` aborts, sends `audio.stop`, returns `spokenChars`.
- `sentences.ts` (splitter: `.!?` + whitespace, newline, 240-char cap; pieces partition the text) and `pcm.ts` (bytes ↔ samples, linear resampler).
- Tests: `input.test.ts`, `output.test.ts`, `helpers.test.ts`, with fakes in `test-fakes.ts` built from `mind/types.ts`, `server/types.ts` and the SDK provider interfaces (26 tests).

**Decisions:**

- **`capabilities(nodeId)` dep (addition to the listed deps).** `begin` must return null for a node without `audio.out@1`, and nothing in the listed deps knows a node's capabilities synchronously. P3-I1 supplies it (e.g. from the server connection's `hello` data or a `repos.nodes` cache).
- **`voice.bargeInMinMs` is applied here**, as a delay before `voiceActivity({ speaking: true })`: the pipeline is the only place that measures speech duration. Shorter speech sends no activity but still goes to STT (a short "yes" is not lost). `voice.bargeIn` (on/off) is left to the Mind (P3-A2), which knows the turn state.
- After a `maxUtteranceMs` cut the activity stays on (no second `speaking: true`), so a long utterance is not read as a barge-in of the turn its first half started.
- Providers are looked up by id on every `start` / `begin`, not at construction, so plugin registration order does not matter. A missing provider refuses the stream / returns null with a warning; P3-I1 still validates ids at startup.
- Sequence gaps (a higher `sequence` than expected) are logged at debug and accepted; only lower sequences are dropped. WS is ordered, so a gap means lost data, not reordering, and dropping everything after it would lose the utterance.
- `spokenChars` is in `String.length` units (UTF-16 code units), so the Mind can cut with `content.slice(0, spokenChars)`.
- A TTS error ends the speech with `audio.end` (the node plays what it has), not `audio.stop`.
- Stream and frame ids are bare ULIDs taken from `ids.next('trn')`, as `mind/thread-manager.ts` already does for frame ids.

**Deviations:** none from the acceptance criteria. `docs/architecture/voice.md` got a "Pipeline (`voice/`)" section (resampling, pre-roll, bargeInMinMs, sentence rules, `spokenChars`).

**Follow-ups:** P3-I1 must pass `capabilities` in `createVoice` deps. TTS runs one piece at a time (no prefetch of the next sentence); fine for v1, a latency improvement later.

`bun run check`: 969 pass, 3 skip, 0 fail.
