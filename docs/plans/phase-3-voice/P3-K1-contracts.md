---
id: P3-K1
title: Phase-3 contract additions and core voice interfaces
phase: 3
wave: 1
lane: K
status: done
owner: agent-P3-K1
depends: [P2-I1]
owns:
  - docs/contracts/**
  - packages/protocol/**
  - packages/sdk/src/providers/**
  - packages/sdk/src/index.ts
  - packages/core/src/voice/types.ts
  - packages/core/src/mind/types.ts
  - packages/core/src/server/types.ts
  - packages/core/src/storage/types.ts
  - packages/core/src/config/**
  - packages/core/src/mind/thread-manager.ts
  - packages/core/src/server/test-fakes.ts
  - packages/core/src/server/attachments.ts
  - packages/client/src/state.ts
  - scripts/**
  - docs/decisions/0013-voice-v1-transport-and-providers.md
reads:
  - docs/plans/phase-3-voice.md
  - docs/architecture/voice.md
  - docs/contracts/protocol.md
  - docs/contracts/providers.md
  - docs/architecture/core.md
updates:
  - docs/architecture/core.md
  - docs/architecture/config.md
  - docs/architecture/voice.md
  - docs/architecture/providers.md
scenarios: [S-7]
---

# P3-K1: Phase-3 contract additions and core voice interfaces

## Goal

Every wave-2 lane can build against types: the audio frames, the finalized voice provider types, the OpenAI-compatible audio helper signatures, the `[voice]` config section, and the core's `VoiceInput` / `VoiceOutput` interfaces. Runs before the parallel lanes, like P2-K1. Done by the coordinator after ADR-0013 is accepted.

## Scope

**In (all additive, contracts rule 3):**
- `@keith/protocol`: schemas for `audio.start` / `audio.end` (node → core, as in the table) and `audio.stop`. A new core → node `audio.start { threadId, messageId, streamId, codec, sampleRate }` and `audio.end { streamId }`. `AudioCodec = 'pcm16' | 'opus'`. `encodeAudioFrame` / `decodeAudioFrame` for the binary header (kind, streamId as 16 raw ULID bytes, uint32 BE sequence), with round-trip tests. `MessageDto.meta.spokenChars?: number`. Update protocol.md (tables, examples, code map).
- `@keith/sdk` providers: finalize `AudioChunk { data; codec; sampleRate }`, `AudioInput`, `SttOptions`, `TtsOptions` in providers.md and `providers/types.ts`. Declare `createOpenAICompatibleStt` / `createOpenAICompatibleTts` (options mirror `createOpenAICompatibleLlm`) with placeholder bodies that throw, which P3-B1 replaces.
- `packages/core/src/voice/types.ts` (new): `VoiceInput` (`start`, `chunk`, `end`, `detach`), `VoiceOutput` (`begin` → `SpeechHandle | null`), `SpeechHandle` (`push`, `end`, `stop(): number`, `done`).
- `mind/types.ts`: `ThreadManager.voiceActivity({ threadId, nodeId, speaking })`. `server/types.ts`: `AttachmentRegistry.sendBinary(nodeId, bytes)`. `storage/types.ts`: `MessageMeta.spokenChars`. Placeholders in the implementers, so `bun run check` stays green (`voiceActivity` is a no-op, `sendBinary` drops the bytes and logs at debug).
- `config/`: an optional `[voice]` section (`vad`, `stt`, `tts` provider ids; `language?`; `maxUtteranceMs` default 30000; `bargeIn` default true; `bargeInMinMs` default 300), in types, the zod schema, and tests.
- `scripts/check-deps.ts`: nothing expected. Confirm that the new plugins `plugins/voice-*` and `plugins/vad-energy` fall under the plugin rule.
- Mirror every changed interface in core.md. Remove `> Planned` wording from providers.md only where the contract is now fixed.

**Out:** any implementation beyond placeholders.

## Acceptance criteria

- [x] Doc example and table tests still pass. New frames have schema tests. Binary header encode/decode round-trips, and rejects short buffers and a bad kind.
- [x] Provider types in providers.md match `providers/types.ts` (the sdk test).
- [x] core.md interface blocks match the changed `types.ts`.
- [x] Config: a missing `[voice]` section gives `voice: undefined`, and defaults apply when it is present.
- [x] `bun run plans --lint` is clean, and `bun run plans --ready` lists the wave-2 tasks once this is done.
- [x] `bun run check` passes.

## Outcome

Done by the coordinator's agent after [ADR-0013](../../decisions/0013-voice-v1-transport-and-providers.md) was accepted. Everything is additive (contracts rule 3); no existing frame, field or interface member changed meaning.

**Built**
- `@keith/protocol`:
  - `src/audio.ts`: `AudioCodec` (`'pcm16' | 'opus'`), `SampleRate` (8 000..48 000), `AudioStreamId` (a bare ULID), `AUDIO_FRAME_KIND` (`in: 1`, `out: 2`), `AUDIO_FRAME_HEADER_BYTES` (21), `AUDIO_FRAME_MAX_BYTES` (64 KiB), `AudioFrame`, `encodeAudioFrame`, `decodeAudioFrame` (→ `{ ok, frame }` or `{ ok: false, code: 'INVALID_FRAME', message }`). Tests: round trip, header layout, short buffer, bad kind, oversized frame, `Int16Array`-ready payload, encoder `RangeError`s.
  - Node → core `audio.start` (`AudioStartFrame`) / `audio.end` (`AudioEndFrame`). Core → node `audio.start` (`AudioOutStartFrame`, with `messageId`), `audio.end` (`AudioOutEndFrame`), `audio.stop` (`AudioStopFrame`). Schema tests for valid and invalid payloads.
  - `makeCoreFrame` / `makeNodeFrame`: `makeFrame` for one direction, needed because `audio.start` / `audio.end` exist in both.
  - `MessageDto.meta.spokenChars?: number` (integer ≥ 0).
  - `protocol.md`: DTO, both frame tables, a new "Audio (phase 3)" section (stream rules, three examples, binary header, size limit, helpers), code map. The table test now covers phase-3 rows too.
- `@keith/sdk`: `AudioChunk { data, codec, sampleRate }`, `AudioInput` (= `AudioChunk`, one utterance), `SttOptions { language?, prompt? }`, `TtsOptions { voice?, language? }`. `createOpenAICompatibleStt` / `createOpenAICompatibleTts` with their option types in `providers/openai-audio.ts`, exported from the index; the bodies throw "not implemented yet (task P3-B1)" when called. `providers.md` has "Voice types" and "OpenAI-compatible audio" sections; the new `providers/types.test.ts` checks the field lists of those five types against the doc.
- Core:
  - `voice/types.ts` (new): `VoiceInput` (`start` → `VoiceStartResult`, `chunk` → boolean, `end` → boolean, `detach`), `VoiceOutput.begin` → `SpeechHandle | null`, `SpeechHandle` (`push`, `end`, `stop(): number`, `done: Promise<void>`).
  - `ThreadManager.voiceActivity({ threadId, nodeId, speaking })`: a no-op in `MindThreadManager`, recorded in the server test fake (`calls.voiceActivity`).
  - `AttachmentRegistry.sendBinary(nodeId, bytes)`: drops the bytes and logs at debug.
  - `MessageMeta.spokenChars`.
  - `KeithConfig.voice?: VoiceConfig` (`vad`, `stt`, `tts` required; `language?`; `maxUtteranceMs` 30000; `bargeIn` true; `bargeInMinMs` 300) in the type and the zod schema, with tests (`config/voice.test.ts`).
  - `core.md`: config, storage, server and mind blocks updated, and a new "Voice" block, all checked chunk by chunk against the code.
- `scripts/check-deps.ts`: unchanged. A test confirms `plugins/voice-*` and `plugins/vad-energy` get the plugin rule.
- Docs: `config.md` (`[voice]`), `voice.md` (v1 transport, core interfaces, adapters), `architecture/providers.md` (seams table, audio helpers, plugin table).

**Decisions**
- `streamId` is a **bare ULID**, not a prefixed id: the binary header carries its 16 raw bytes, and a stream is never stored. The sender of `audio.start` generates it.
- Same type names both ways (`audio.start`, `audio.end`), as the task and the table say. The schemas are separate per direction; the core's `audio.start` adds `messageId`.
- `decodeAudioFrame` returns a **copy** of the payload at byte offset 0, so PCM16 can be viewed as an `Int16Array` without alignment errors (the header is 21 bytes, which is odd).
- A 64 KiB limit per binary frame, header included, so a node can't push unbounded frames and the core rejects them at the boundary (R-9).
- `VoiceInput` never throws into the server. `start` returns `{ ok: false, code: 'INVALID_FRAME', message }` (voice off, `opus`, reused stream id), and `chunk` / `end` return false for a stream the node doesn't have open, so the server can reply `INVALID_FRAME` without tracking streams itself.
- `start` also takes `personId`, because `ThreadManager.input` needs it.
- `SpeechHandle.done` is `Promise<void>` and never rejects. `spokenChars` comes from `stop()`.
- `apiKey` is optional in both audio helpers (a local speaches has no key). Both helpers take a `mapRequest`, like the LLM helper.
- The `[voice]` section has no `KEITH__` overrides, because the overridable keys come from the defaults and the section has none.

**Deviations**
- `packages/client/src/state.ts` is outside the original `owns`. Its `applyFrame` switch is exhaustive over `CoreFrame`, so the new core frames broke typecheck. I added a no-op `case` for `audio.start` / `audio.end` / `audio.stop` and widened this task's `owns` for that file, as P2-K1 did for its placeholders. P3-E1 owns `packages/client/**` and replaces it.
- The frames test's `samples` map was split into `nodeSamples` and `coreSamples`, because one map keyed by type can't hold both `audio.start` payloads.

**Notes for the lanes**
- **P3-A2 (server/mind):**
  - Until you handle them, a node's `audio.start` / `audio.end` now parse and fall through the server's `switch` without a reply. Before, they were `UNKNOWN_FRAME`.
  - `server/dto.ts` `toMessageDto` copies only `cancelled` and `proactive`. Copy `spokenChars` too.
  - **Gap:** `storage/messages.ts` reads `meta` with a zod object that has only `cancelled` and `proactive`, so `spokenChars` is **dropped when a message is read back** (history, `thread.opened`). Neither P3-A2 nor any other phase-3 task owns `packages/core/src/storage/**`. The coordinator should widen P3-A2's `owns` to `packages/core/src/storage/messages.ts`, or give it to P3-I1. The change is one line: `spokenChars: z.number().int().nonnegative().optional()` in `MessageMetaSchema`.
  - `sendBinary` needs a binary path on `FrameOutlet` (today it only has `sendText`).
  - Use `makeCoreFrame('audio.start', …)` when sending, because `makeFrame('audio.start', …)` returns the union of both directions, which isn't assignable to `CoreFrame`.
- **P3-A1 (voice):** Split TTS output into frames of at most `AUDIO_FRAME_MAX_BYTES - AUDIO_FRAME_HEADER_BYTES` bytes of payload. Chunks from `TtsProvider.stream` hold whole samples (the contract says so). `stop()` should send `audio.stop` only if `audio.start` went out.
- **P3-B1 (adapters):** Re-align streamed PCM bodies to whole samples before yielding (contract: even byte length). Omit `authorization` when `apiKey` is undefined.
- **P3-E1 (client):** Use `makeNodeFrame` for `audio.start` / `audio.end`, and `encodeAudioFrame` with `AUDIO_FRAME_KIND.in`. Generate `streamId` as a bare ULID.
- **P3-D1:** nothing beyond `VadProvider` / `VadStream`, which are unchanged.
