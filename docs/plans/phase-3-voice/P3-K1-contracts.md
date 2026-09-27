---
id: P3-K1
title: Phase-3 contract additions and core voice interfaces
phase: 3
wave: 1
lane: K
status: todo
owner: null
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

- [ ] Doc example and table tests still pass. New frames have schema tests. Binary header encode/decode round-trips, and rejects short buffers and a bad kind.
- [ ] Provider types in providers.md match `providers/types.ts` (the sdk test).
- [ ] core.md interface blocks match the changed `types.ts`.
- [ ] Config: a missing `[voice]` section gives `voice: undefined`, and defaults apply when it is present.
- [ ] `bun run plans --lint` is clean, and `bun run plans --ready` lists the wave-2 tasks once this is done.
- [ ] `bun run check` passes.

## Outcome

_Filled by the coordinator when finishing._
