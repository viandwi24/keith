---
id: P3-I2
title: "S-7 end to end: switch device and modality mid-conversation"
phase: 3
wave: 4
lane: I
status: todo
owner: null
depends: [P3-I1]
owns:
  - tests/e2e/**
  - packages/core/**
  - packages/client/**
  - plugins/**
  - .github/**
reads:
  - docs/concept/scenarios.md
  - docs/architecture/voice.md
  - docs/plans/phase-3-voice.md
updates:
  - docs/architecture/voice.md
scenarios: [S-7]
---

# P3-I2: S-7 end to end

## Goal

S-7 runs in CI with synthetic audio. Then a human runs it with real providers.

## Scope

**In:**
- `tests/e2e/s7-voice.test.ts`: the real core with `@keith/web`, `vad-energy`, and STT/TTS plugins backed by a fake `fetch` (STT returns a scripted transcript; TTS returns a scripted PCM body), plus the scripted fake LLM.
  1. The TUI-like node types a question. The reply is text on both nodes, and no audio anywhere.
  2. Chromium with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<generated wav>` opens the same thread and speaks. Focus moves to the browser. The browser receives `audio.start`, kind-2 frames and `audio.end`. The TUI node receives the same `message.completed` text and **no** binary frames (I-6, I-7).
  3. Barge-in: the browser speaks again during playback. Check `audio.stop`, `meta.spokenChars` on the persisted reply, and the next turn answering the new input.
- A generated WAV fixture (speech-like noise between silences), created by the test and not committed.
- CI runs S-7 5 times in a row, like S-8.
- Human run instructions (below) and the exit checklist in roadmap.md.

**Out:** new features. Fixes only, recorded per lane.

## Acceptance criteria

- [ ] `tests/e2e/s7-voice.test.ts` passes 5 runs in a row locally and in CI.
- [ ] The page has no JS errors. The TUI node never receives a binary frame.
- [ ] The human run is recorded in the Outcome (the coordinator asks the owner, because it needs real API keys).
- [ ] `bun run check` passes.

## Human run (owner, real keys)

1. `KEITH_HOME=/tmp/keith-s7 keith setup`, choose cloud voice (or local plus `docker run` speaches), build the web app, then `keith start`.
2. Type in the TUI. Then open the browser on another device or tab, click the mic, and speak. Keith answers out loud in the browser, and the TUI shows the text.
3. Interrupt Keith mid-sentence. Playback stops, and the next reply answers the interruption.
4. Record models and voices, latency (end of speech → first audio), and any rough edges here.

## Outcome

_Filled by the agent when finishing._
