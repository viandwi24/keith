---
id: P3-E1
title: "Web and client: mic capture, playback queue, audio.in@1 / audio.out@1"
phase: 3
wave: 2
lane: E
status: review
owner: agent-P3-E1
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

- [x] Client tests: `sendAudio` produces frames that `decodeAudioFrame` reads back. `audio.stop` clears queued chunks. Capabilities depend on the option.
- [x] App unit tests: the PCM16 downsampler (48 kHz float → 16 kHz int16) against known vectors, and the playback queue ordering and stop.
- [x] A browser test (Playwright, fake media via `--use-fake-device-for-media-stream`) opens the mic and sees binary frames sent over a mocked or real WS.
- [x] Existing web and TUI tests still pass. The TUI never declares audio.
- [x] `bun run check` passes.

## Outcome

The web app can talk to Keith and play the answer. The browser only captures and plays PCM. The client side is UI-free and tested in Bun.

**`@keith/client`** (`src/audio.ts`, `src/chat.ts`):
- `createChatClient({ audio: { input, output }, onAudio })`. `clientCapabilities` adds `audio.in@1` / `audio.out@1` only from the `audio` option and drops any `audio.*` passed in `capabilities`, so the TUI (which passes neither) stays `chat.text@1`.
- `startAudio()` sends `audio.start` (`pcm16`, 16 000 Hz, a new bare-ULID `streamId` from `newStreamId`). `sendAudio(streamId, sequence, pcm16)` sends a kind-1 binary frame via `encodeAudioFrame` (little-endian `pcm16ToBytes`). `endAudio(streamId)` sends `audio.end`. Results are typed (`unsupported`, `offline`, `unknown-stream`, `invalid`). Streams are forgotten when the socket closes, because the core forgets them too.
- The socket uses `binaryType = 'arraybuffer'`. Kind-2 frames, the core's `audio.start` / `audio.end` and `audio.stop` become `onAudio` events (`start`, `chunk`, `end`, `stop`). `send()` also emits `flush` (a new user input).
- `createPlaybackQueue({ sink })` is a platform-free queue. It plays each stream in `sequence` order with no gaps, holds an early chunk until the missing one arrives (or the stream ends, or 64 are waiting), stops at once on `stop` / `flush` / `stop()`, and ignores late chunks of a stopped stream. It plays only `pcm16`.
- Fake core (`test/fake-core.ts`): `receivedAudio` (decoded binary frames), `pushAudio`, `stopAudio`, `setTurnState`, and a `serve` option for non-`/v1` paths (serving a built app).

**Web app** (`plugins/web/app/`):
- `lib/pcm.ts`: `floatToInt16`, `Downsampler` (box-filter mean per output window, with integer window bounds so there is no drift, streaming), `Pcm16Chunker` (exact 320-sample chunks) and `Pcm16Encoder`.
- `lib/mic.ts`: `getUserMedia` with echo cancellation, noise suppression and AGC, and an inline AudioWorklet loaded from a Blob URL (no extra bundler entry) that posts 20 ms float batches. `micErrorMessage` maps `NotAllowedError`, `NotFoundError` and similar errors to one sentence.
- `lib/web-audio.ts`: a `PlaybackSink` over an `AudioContext` (`AudioBufferSourceNode` per chunk at the announced rate). The context is created on first use and resumed on the mic click (autoplay policy).
- `lib/voice.ts`: `VoiceEnv` (`unavailable`, `openMic`, `createOutput`). `browserVoice()` is the real one. It is unavailable without `AudioContext`, outside a secure context, or without `AudioWorkletNode` / `getUserMedia`. `App` takes an optional `voice` prop for tests.
- `hooks/use-voice.ts` (`usePlayback`, `useMic`) and `components/chat/voice-controls.tsx`: a "Mic on/off" toggle (open mic), a "Hold to talk" button (pointer and Space/Enter; pressing stops playback), "Listening…" when the mic is on and `thread.state` is `listening`, "Speaking" while audio plays, and one inline line for errors or the reason voice is unavailable.

**Tests:** `packages/client/src/audio.test.ts` and `chat-audio.test.ts` cover the capabilities option, frames that `decodeAudioFrame` reads back, typed incoming events, `audio.stop` and a new input clearing the queue, and reconnects. `lib/pcm.test.ts` tests the downsampler on known vectors, including 44.1 kHz with no drift. `lib/web-audio.test.ts` covers queue order, back-to-back timing and stop against a fake `AudioContext`. `components/chat/voice.test.tsx` runs the app against the fake core with a fake mic: open mic, hold-to-talk, listening and speaking, denied permission while text chat still works, and no-support. `test/voice-browser.test.ts` builds the app and runs Chromium with `--use-fake-device-for-media-stream`. It checks `hello` capabilities, 75 consecutive 661-byte binary frames (640 B PCM + 21 B header) of one stream with non-silent samples, `audio.end` on toggle-off, and the speaking indicator on until `audio.stop`. It skips when no Chromium is found, using the same lookup as `tests/e2e/browser.ts`. `bun run check`: 980 pass, 3 skip, 0 fail.

**Decisions and deviations:**
- The playback queue lives in `@keith/client` (platform-free, behind a `PlaybackSink`). The acceptance criteria test it from both sides, and the TUI or another TS node can reuse it. The Web Audio part stays in the app.
- Downsampling runs on the main thread (`Pcm16Encoder`), not inside the worklet, so the same code is unit-tested in Bun. The worklet only batches 20 ms of raw samples. The anti-alias filter is a box filter. That is enough for STT, and a windowed-sinc FIR is a possible follow-up.
- Hold-to-talk opens the mic on each press, so there is a short `getUserMedia` delay after the first grant.
- The browser test lives in `plugins/web/app/test/` because `tests/e2e/**` belongs to the integration task. It imports `playwright` from the root devDependency, since `plugins/web/package.json` is outside `owns`. On this macOS host, the very first run once saw `getUserMedia` hang with the fake device. Every later run passed in about 3 s.
- `packages/client/src/chat.test.ts` has a pre-existing flaky assertion (`turnState` read right after `message.completed`, before `thread.state idle` arrives). It failed once in about 7 runs and was not changed.

**Follow-ups (docs outside `updates`):** `docs/architecture/voice.md` says the browser side is "built by the phase-3 lanes". The P3 integration task should mark it built. `docs/architecture/repository.md` (the `@keith/client` API) should list `startAudio` / `sendAudio` / `endAudio`, `onAudio`, `clientCapabilities` and `createPlaybackQueue`.
