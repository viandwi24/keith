---
id: P3-D1
title: "@keith/vad-energy: a dependency-free energy VAD"
phase: 3
wave: 2
lane: D
status: review
owner: agent-P3-D1
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

- [x] Silence → no events. Silence, 600 ms of speech-level noise, then silence → exactly one start and one end, with `atMs` within ±40 ms of the synthetic boundaries.
- [x] A 60 ms click does not trigger a start (`minSpeechMs`).
- [x] A short pause shorter than `hangoverMs` does not end speech.
- [x] A slowly rising noise floor (fan noise) does not trigger a start.
- [x] `push` with chunks of arbitrary sizes gives the same events as one large push.
- [x] `bun run check` passes.

## Outcome

**Built:** `plugins/vad-energy` (`@keith/vad-energy`, namespace `vad_energy`, `kind: 'provider'`), scaffolded with `bun init -y` (generated `index.ts`, `README.md`, `CLAUDE.md`, `.gitignore` removed; `package.json`/`tsconfig.json` aligned with the other provider plugins) and `bun add @keith/sdk zod`. It registers the `vad` provider `energy`.

- `src/vad.ts`: `createEnergyVad(options)` → `VadProvider`, `energyVadOptions` (zod, all defaults), `levelDb`, `ENERGY_VAD_ID`.
- Algorithm: frames of `round(sampleRate * frameMs / 1000)` samples (default 20 ms), RMS in dBFS. The noise floor starts at the first frame's level, is clamped at `floorMinDb` (-70), and follows the level with an asymmetric EMA while not speaking (`floorRiseMs` 1500 up, `floorFallMs` 150 down); it is frozen while speaking. Start: level ≥ floor + `startDb` (12) for `minSpeechMs` (120). End: level < floor + `endDb` (8) for `hangoverMs` (500). `endDb <= startDb` is enforced by the schema.
- Samples are buffered across `push` calls into whole frames, so chunking never changes the result. `push` after `close` returns `[]`. `create` with a non-positive or non-finite `sampleRate` throws `ProviderError('bad_request')`; audio input never throws.
- Tests (`test/vad.test.ts`, 19 tests) use deterministic generated signals (`test/signal.ts`: seeded noise, tones, exponential noise ramps). They cover every acceptance criterion, plus off-grid boundaries, 8/24/44.1/48 kHz, a pause longer than the hangover, speech over an adapted fan-noise floor, per-stream state, option validation and plugin registration/config. The fan-noise test was checked to fail with a non-adapting floor.

**Decisions:**
- `atMs` is the boundary itself (first frame of the loud run for `speech.start`, first frame of the quiet run for `speech.end`), not the moment the event is confirmed. Events are therefore emitted `minSpeechMs` / `hangoverMs` after the time they report. This is what the ±40 ms criterion requires, and it lets the pipeline trim the utterance precisely.
- Initializing the floor from the first frame means speech that is already present in the very first frame is absorbed into the floor until it falls back. Nodes start streams before the person speaks, so this is accepted for v1.
- A single frame dipping below the start threshold resets the start candidate (no tolerance inside `minSpeechMs`). Simple and good enough for a quiet room; revisit with real audio if starts are missed.

**Deviations:** none. No docs in `updates`. Tests live in `test/` like the other plugins.

**Follow-ups:** Silero VAD (ADR-0013). The integration task wires `voice.vad = "energy"` and may tune defaults against real microphone audio.
