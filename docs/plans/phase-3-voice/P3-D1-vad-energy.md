---
id: P3-D1
title: "@keith/vad-energy: a dependency-free energy VAD"
phase: 3
wave: 2
lane: D
status: todo
owner: null
depends: [P3-K1]
owns:
  - plugins/vad-energy/**
reads:
  - docs/contracts/providers.md
  - docs/contracts/plugin-api.md
  - docs/architecture/voice.md
  - docs/decisions/0013-voice-v1-transport-and-providers.md
updates: []
scenarios: [S-7]
---

# P3-D1: Energy VAD plugin

## Goal

A `VadProvider` with id `energy` that turns PCM16 frames into `speech.start` / `speech.end` events reliably enough for push-to-talk-free conversation in a quiet room. It is pure TypeScript and deterministic in tests.

## Scope

**In:**
- `plugins/vad-energy` (`bun init`, `kind: 'provider'`), which registers `vad` provider `energy`.
- Algorithm: 20–30 ms frames, RMS in dBFS, an adaptive noise floor (slow EMA while not speaking), start when the level is above floor + `startDb` for `minSpeechMs`, end after `hangoverMs` below floor + `endDb`. `atMs` is measured from the stream's first sample. All thresholds are in the plugin's zod config, with defaults.
- Accepts any sample rate. Frames are sized by time, not by sample count.
- Test fixtures are generated in code (silence, a tone or noise burst, silence), so no binary files are committed.

**Out:** Silero or any ONNX runtime (ADR-0013 follow-up), resampling (the core does it).

## Acceptance criteria

- [ ] Silence → no events. Silence, 600 ms of speech-level noise, then silence → exactly one start and one end, with `atMs` within ±40 ms of the synthetic boundaries.
- [ ] A 60 ms click does not trigger a start (`minSpeechMs`).
- [ ] A short pause shorter than `hangoverMs` does not end speech.
- [ ] A slowly rising noise floor (fan noise) does not trigger a start.
- [ ] `push` with chunks of arbitrary sizes gives the same events as one large push.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
