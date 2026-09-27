---
id: P3-A2
title: "Core: audio frames in the server, listening state, barge-in and spokenChars in the Mind"
phase: 3
wave: 2
lane: A
status: in-progress
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

- [ ] Server: `audio.start` without `audio.in@1` → `FORBIDDEN`. A valid binary chunk reaches the fake `VoiceInput.chunk` with the right streamId and sequence. Garbage binary → `INVALID_FRAME`, and the connection stays open.
- [ ] Mind: `voiceActivity` moves the state `idle → listening → thinking` (input arrives) `→ speaking → idle`, visible as `thread.state` frames.
- [ ] Typed input gets no `VoiceOutput.begin` call. Audio input from a node with `audio.out@1` does, on that node only.
- [ ] S-7 shape: node A types, node B speaks; focus moves to B, B gets audio, A gets the same text (`message.completed`) and no audio.
- [ ] Barge-in during `speaking`: the fake `SpeechHandle.stop` is called, and the persisted message has `meta.cancelled` and `meta.spokenChars`, with `content` cut to the spoken prefix.
- [ ] Without `voice` deps, all existing mind and server tests pass unchanged.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
