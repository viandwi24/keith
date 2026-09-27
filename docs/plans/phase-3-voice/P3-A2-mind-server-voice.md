---
id: P3-A2
title: "Core: audio frames in the server, listening state, barge-in and spokenChars in the Mind"
phase: 3
wave: 2
lane: A
status: done
owner: agent-P3-A2
depends: [P3-K1]
owns:
  - packages/core/src/mind/**
  - packages/core/src/server/**
  - packages/core/src/storage/messages.ts
  - packages/core/src/storage/messages.test.ts
reads:
  - docs/architecture/voice.md
  - docs/architecture/core.md
  - docs/architecture/nodes.md
  - docs/contracts/protocol.md
  - docs/decisions/0013-voice-v1-transport-and-providers.md
updates:
  - docs/architecture/core.md
  - docs/architecture/nodes.md
scenarios: [S-7]
---

# P3-A2: Audio frames, listening, barge-in

## Goal

The server accepts audio from nodes and routes it to `VoiceInput`, and the Mind speaks audio-modality replies through `VoiceOutput` on the focus node. Barge-in stops playback and keeps only what was spoken (`meta.spokenChars`). Everything is built against the `voice/types.ts` interfaces from P3-K1, with a fake voice in tests.

## Scope

**In (server):**
- `audio.start` / `audio.end` frames: check that the node has `audio.in@1` and has opened the thread (`FORBIDDEN` otherwise), then call `VoiceInput.start` / `end`. Binary frames: parse the header with `@keith/protocol` (P3-K1). Kind 1 goes to `VoiceInput.chunk`. A malformed header, kind 2 from a node, or an unknown stream → `error { INVALID_FRAME }`. Replaces the phase-1 "binary frames are not supported yet" reply.
- `AttachmentRegistry.sendBinary(nodeId, bytes)` (P3-K1 added a placeholder). Socket close ends the node's open streams (`VoiceInput.detach`).
- The server takes `voice?: VoiceInput`. Without it, audio frames get `error { INVALID_FRAME, "voice is not configured" }`.

**In (storage):**
- `storage/messages.ts` reads `meta` with a zod schema that drops `spokenChars`; add it (`z.number().int().nonnegative().optional()`) so history and `thread.opened` keep it. Also copy it in `server/dto.ts`. (Found by P3-K1; owns widened by the coordinator.)

**In (mind):**
- `ThreadManager.voiceActivity({ threadId, nodeId, speaking })` (interface from P3-K1): `idle` → `listening` on start, back to `idle` on stop without input. Speech start while `thinking` or `speaking` on the focus node is a **barge-in**: the turn is cancelled as `input.cancel` does, and speech output is stopped.
- Audio-modality turns: when the turn's latest input has `modality: 'audio'` and the focus node has `audio.out@1`, text deltas also go to `VoiceOutput.begin(...)`. Text still goes to every attached node (I-7). Audio goes to the focus node only.
- A cancelled spoken reply persists the text actually spoken (`content` cut to `spokenChars`), with `meta: { cancelled: true, spokenChars }`. The same meta is in `message.completed` and history.
- The Mind takes `voice?: VoiceOutput` in its deps. Without it, behavior is exactly phase 2.

**Out:** the pipeline itself (P3-A1), bootstrap wiring (P3-I1), the web app (P3-E1).

## Acceptance criteria

- [x] Server: `audio.start` without `audio.in@1` → `FORBIDDEN`. A valid binary chunk reaches the fake `VoiceInput.chunk` with the right streamId and sequence. Garbage binary → `INVALID_FRAME`, and the connection stays open.
- [x] Mind: `voiceActivity` moves the state `idle → listening → thinking` (input arrives) `→ speaking → idle`, visible as `thread.state` frames.
- [x] Typed input gets no `VoiceOutput.begin` call. Audio input from a node with `audio.out@1` does, on that node only.
- [x] S-7 shape: node A types, node B speaks; focus moves to B, B gets audio, A gets the same text (`message.completed`) and no audio.
- [x] Barge-in during `speaking`: the fake `SpeechHandle.stop` is called, and the persisted message has `meta.cancelled` and `meta.spokenChars`, with `content` cut to the spoken prefix.
- [x] Without `voice` deps, all existing mind and server tests pass unchanged.
- [x] `bun run check` passes.

## Outcome

**Built**

- Server (`server/connection.ts`, `server/server.ts`, `server/attachments.ts`): `audio.start` checks voice is configured, then `audio.in@1` and that the thread is open here (`FORBIDDEN`), then calls `VoiceInput.start`. A refusal becomes `error { INVALID_FRAME, message }`. `audio.end` → `VoiceInput.end` (an unknown stream gets `INVALID_FRAME`). Binary frames go through the same in-order chain as text frames, so a chunk never overtakes its `audio.start`. They are decoded with `decodeAudioFrame`, and kind 1 goes to `VoiceInput.chunk`. A malformed header, kind 2, an unknown stream, or a binary frame before `hello` gets `INVALID_FRAME`, and the socket stays open. `CoreServerDeps.voice?: VoiceInput`; without it every audio frame gets `INVALID_FRAME "voice is not configured"`. Socket close calls `VoiceInput.detach`. `FrameOutlet` and `Socket` gained `sendBinary`, and `AttachmentRegistry.sendBinary` now reaches the socket.
- Storage and DTOs: `MessageMetaSchema` keeps `spokenChars`, and both `server/dto.ts` and `mind/messages.ts` (the Mind's own `toMessageDto`) copy it.
- Mind (`mind/thread-manager.ts`): `ThreadManagerDeps.voice?: VoiceOutput`, and `config` may carry `voice`. `voiceActivity` does idle → `listening` and back to `idle` on `speaking: false`. The speaking node detaching also returns it to `idle`, and an input from that node clears it. Audio-modality turns open a `SpeechHandle` on the focus node when it has `audio.out@1`, and every delta is pushed to it. Barge-in on the focus node while `thinking`/`speaking` calls `stop()` and aborts the turn. A cancelled spoken reply (barge-in or `input.cancel`) is stored cut to `spokenChars` with `meta: { cancelled: true, spokenChars }`. After a barge-in the thread goes to `listening`.
- Tests: `server/audio.test.ts` (fake `VoiceInput` in `server/test-fakes.ts`; the test WS client now records binary frames), `mind/voice.test.ts` (fake `VoiceOutput` in `mind/testing/fakes.ts`; the harness takes `voice`, `voiceConfig` and per-node `capabilities`), a `sendBinary` test in `attachments.test.ts`, and a `spokenChars` round trip in `storage/messages.test.ts`. All existing mind and server tests pass unchanged.

**Decisions**

- **A spoken reply stays `speaking` until playback ends.** After the text is complete the Mind calls `end()` and waits for `done` (or an abort) before it persists the message and sends `message.completed`. A barge-in during playback can then still cut the stored text to what was heard. The cost: text-only nodes get `message.completed` when the audio finishes, not when the text does (the deltas still arrive live).
- **The Mind applies `voice.bargeIn` and `voice.bargeInMinMs`**, because only the Mind knows whether a turn is running. A barge-in happens `bargeInMinMs` after `speaking: true` unless `speaking: false` from that node arrives first. Without a `[voice]` section, barge-in is on with no minimum. **P3-A1 must not also delay** its `voiceActivity` calls by `bargeInMinMs`. It should report raw VAD start and stop. Documented in core.md.
- A spoken reply is stored with `modality: 'audio'` (I-6: modality is per message). Typed replies stay `'text'`.
- `speaking: false` returns `listening` to `idle` right away. If P3-A1 also sends `speaking: false` on `speech.end` just before a non-empty transcript's `input`, nodes see a brief `listening → idle → thinking`. Its task text says `speaking: false` is for the empty-transcript case, which gives the clean `listening → thinking`.
- The server checks voice-configured first, then the capability and the open thread. So without voice, `audio.start` gets `INVALID_FRAME` even from a node without `audio.in@1`.

**Deviations:** none from `owns`. Docs updated: core.md (turn-state rules: listening, spoken replies, barge-in) and nodes.md (audio frame handling table, binary ordering, `sendBinary`).

**Follow-ups for P3-I1:** pass `voice.output` to `createThreadManager({ voice })`, pass `voice.input` to `createCoreServer({ voice })`, and pass `config` with the `voice` section to the ThreadManager.
