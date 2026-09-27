---
id: P3-E1
title: "Web and client: mic capture, playback queue, audio.in@1 / audio.out@1"
phase: 3
wave: 2
lane: E
status: todo
owner: null
depends: [P3-K1]
owns:
  - packages/client/**
  - plugins/web/app/**
reads:
  - docs/architecture/voice.md
  - docs/architecture/ui.md
  - docs/contracts/protocol.md
  - docs/decisions/0013-voice-v1-transport-and-providers.md
  - docs/decisions/0012-web-bundler.md
updates:
  - docs/architecture/ui.md
scenarios: [S-7]
---

# P3-E1: Browser voice

## Goal

In the web app, the owner can talk to Keith and hear the answer. The same thread keeps showing text on every other node. The browser only captures and plays audio. VAD, STT and TTS stay in the core.

## Scope

**In (`@keith/client`, UI-free and testable in Bun):**
- `connection.sendAudio(streamId, seq, pcm16)`, which sends binary kind-1 frames using `encodeAudioFrame` from `@keith/protocol`. Helpers to send `audio.start` / `audio.end`.
- Incoming: `audio.start` (core → node), binary kind-2 chunks, `audio.end`, and `audio.stop` surface as typed client events. `audio.stop` and a new user input flush the playback queue.
- `hello` declares `audio.in@1` / `audio.out@1` only when the embedding app says it can (a constructor option), so the TUI stays `chat.text@1`.

**In (web app):**
- An AudioWorklet mic capture with `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`. It downsamples to 16 kHz PCM16 and sends 20 ms chunks while the mic is open.
- UI: a mic toggle (open mic, where the core's VAD decides turns) and a hold-to-talk mode. Show the `listening` state from `thread.state`, and a speaking indicator while playing.
- Playback: an AudioWorklet or scheduled `AudioBufferSourceNode` queue at the announced `sampleRate`. It stops instantly on `audio.stop`. Audio plays only when the core sends it, which it does only to the focus node.
- Permission denied or no mic → a clear inline message, and text chat keeps working.

**Out:** Opus / WebCodecs (ADR-0013 follow-up), wake word, any VAD in the browser.

## Acceptance criteria

- [ ] Client tests: `sendAudio` produces frames that `decodeAudioFrame` reads back. `audio.stop` clears queued chunks. Capabilities depend on the option.
- [ ] App unit tests: the PCM16 downsampler (48 kHz float → 16 kHz int16) against known vectors, and the playback queue ordering and stop.
- [ ] A browser test (Playwright, fake media via `--use-fake-device-for-media-stream`) opens the mic and sees binary frames sent over a mocked or real WS.
- [ ] Existing web and TUI tests still pass. The TUI never declares audio.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
