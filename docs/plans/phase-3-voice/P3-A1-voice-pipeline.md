---
id: P3-A1
title: "Core voice pipeline: VAD → STT per stream, TTS per reply"
phase: 3
wave: 2
lane: A
status: todo
owner: null
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

- [ ] A synthetic utterance (PCM16 speech between silences, with a fake VAD) produces exactly one `ThreadManager.input` with `modality: 'audio'` and the fake STT's text.
- [ ] `speech.start` / `speech.end` map to `voiceActivity` calls, and an empty transcript produces no input.
- [ ] `maxUtteranceMs` forces an STT run.
- [ ] TTS output: sentences are sent in order, each chunk is a valid kind-2 binary frame with increasing `sequence`, between `audio.start` and `audio.end`.
- [ ] `stop()` mid-reply: the fake TTS signal is aborted, `audio.stop` is sent, and `spokenChars` equals the characters of the sentences fully sent.
- [ ] Voice off (no `config.voice`): `begin` returns null, and input streams are refused with a logged warning.
- [ ] `bun run check` passes.

## Notes

- Sentence splitting: keep it simple (`.`, `!`, `?`, newline, plus a length cap). Don't add an NLP dependency.
- Resampling: if the VAD or STT needs 16 kHz and the node sends another rate, resample in `voice/` (linear is fine for v1). Record this in voice.md.

## Outcome

_Filled by the agent when finishing._
