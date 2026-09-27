---
id: P3-I2
title: "S-7 end to end: switch device and modality mid-conversation"
phase: 3
wave: 4
lane: I
status: done
owner: agent-P3-I2
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

- [x] `tests/e2e/s7-voice.test.ts` passes 5 runs in a row locally and in CI. (Locally: yes. CI: the workflow runs it 5 times; not yet observed on a CI run.)
- [x] The page has no JS errors. The TUI node never receives a binary frame.
- [ ] The human run is recorded in the Outcome (the coordinator asks the owner, because it needs real API keys). **Deferred by the owner on 2026-09-27**; see the phase-3 README exit notes.
- [x] `bun run check` passes.

## Human run (owner, real keys)

1. `KEITH_HOME=/tmp/keith-s7 keith setup`, choose cloud voice (or local plus `docker run` speaches), build the web app, then `keith start`.
2. Type in the TUI. Then open the browser on another device or tab, click the mic, and speak. Keith answers out loud in the browser, and the TUI shows the text.
3. Interrupt Keith mid-sentence. Playback stops, and the next reply answers the interruption.
4. Record models and voices, latency (end of speech → first audio), and any rough edges here.

## Outcome

S-7 now runs end to end in a real browser with synthetic audio. `tests/e2e/s7-voice.test.ts` boots the real core with `@keith/web` and `@keith/vad-energy` loaded **by package name** from config, a `[voice]` section (`energy` / `groq` / `openai`, `bargeInMinMs = 300`), and the real Groq STT and OpenAI TTS adapters (`createGroqStt`, `createOpenAITts`) registered by a test-local provider plugin with a fake `fetch`. The fake STT returns scripted transcripts in order. The fake TTS returns 300 ms of PCM at once, except for one sentence of the long reply, which trickles 100 ms chunks for 10 s and stops on abort. The LLM is the scripted fake.

The fake microphone is a WAV that the test generates in a temp dir (not committed). One 4 s loop holds 1.0 s of silence, a 0.9 s speech-like burst, and 2.1 s of silence. The burst is harmonics of a gliding ~140 Hz pitch plus a little noise, under a 4 Hz syllable envelope. Chromium runs with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav> --autoplay-policy=no-user-gesture-required` and loops the file. So the open mic sends one utterance every 4 s through the app's real capture path (getUserMedia with AEC/NS/AGC, AudioWorklet, 16 kHz downsampling), and the core's real energy VAD cuts them.

The scenario, in one test (about 11.7 s):
1. The TUI-like node (`chat.text@1`) and the browser (signed in, mic off) share the main thread. The TUI types. The reply is `modality: 'text'` and appears on both nodes. No node gets an `audio.*` frame or a binary frame, and TTS is never called.
2. The browser turns the mic on. The first burst becomes a `user` message with `modality: 'audio'` on the TUI, and the browser shows the transcript. Focus moves to the browser. The browser alone gets `audio.start` (with the reply's `messageId`, `pcm16`, 24 kHz), kind-2 frames with sequence 0, 1, 2, … and `audio.end`. The TUI gets the same `message.completed` text and no audio.
3. The second burst asks for a long reply. Its second sentence is still playing when the third burst arrives. That is a barge-in: the browser gets `audio.stop` for that stream (no `audio.end`). The reply is stored and sent with `meta.cancelled`, `0 < spokenChars < length` and `content === reply.slice(0, spokenChars)` (the first sentence). The third burst's transcript becomes the next input, and the fourth LLM request ends with it. Its reply is spoken to the browser again.
4. The mic is turned off. The TUI never received a binary frame or an `audio.*` frame, and the page had no JS errors.

**Robustness to the macOS `getUserMedia` hang (P3-E1):** `openMic` clicks the toggle and waits `MIC_OPEN_MS` (8 s) for the mic to be on, then for more than 10 sent binary frames. If that fails, it closes the browser context (bounded, so a stuck page cannot hang cleanup), signs in again in a fresh context and retries, up to 3 attempts. It logs a warning on each retry. I checked the retry path by forcing attempt 1 to fail: the test still passed. Every Playwright step and the test itself have explicit timeouts (UI 10 s, speech 15 s, test 90 s, `beforeAll` 120 s).

**Results:** `bun run check`: 1095 pass, 3 skip, 0 fail. `bun test tests/e2e/s7-voice.test.ts` passed 5 runs in a row on the final version (about 11.6 s each, no mic retry needed), plus once inside `bun run check`. Earlier revisions of the test passed 11 further runs. S-8 still passes.

### Integration fixes (by lane)

None needed. Every lane's behavior matched voice.md on the first run: the energy VAD with Chromium's processed capture, the pipeline, focus, barge-in, `spokenChars`, the transcript echo, the client's audio frames and the web app's mic.

### Test infrastructure changes (`tests/e2e/**`, `.github/**`)
- `harness.ts`: `E2eNode.binary` records every binary frame a protocol node receives (`binaryType = 'arraybuffer'`). Before, a binary frame would have failed `parseCoreFrame` and shown up as an "invalid core frame" problem. This is how the test asserts that the TUI never gets audio.
- `browser.ts`: `launchChromium(opts)` passes launch options through (the fake-media `args`).
- CI (`.github/workflows/ci.yml`): after S-8, it runs `bun test tests/e2e/s7-voice.test.ts` 5 times in a row. It uses the Chromium that CI already installs.

### Decisions and deviations
- The browser is open (mic off) **before** the TUI types, so "no audio anywhere" in step 1 is checked on a node that could play audio. The task text opens it in step 2. Nothing else changes.
- STT/TTS use the real adapters with an injected `fetch` through a test-local plugin (`@keith/e2e-voice`), not the published plugins with a `baseUrl` to a local server as P3-I1 does. The published plugins take no `fetch` from config, so this is the only way to satisfy "backed by a fake `fetch`" without changing them. P3-I1's `packages/core/test/voice.test.ts` already covers loading `@keith/voice-groq` / `@keith/voice-openai` by name.
- The roadmap's phase exit checklist is generic and has no S-7-specific items to tick. `docs/plans/roadmap.md` is outside this task's `owns` and `updates`, so it is unchanged. Status of that checklist for phase 3: integration e2e passes locally, and CI runs it (not yet observed); human run pending (below); no `Planned (phase 3)` markers left once the coordinator removes `providers.md:107` (P3-I1 note); next phase's task files are the coordinator's.

### Docs
- `docs/architecture/voice.md`: a new section "End-to-end test (S-7)" says what the test runs, how the fake mic works, what it checks, and the retry.

### Follow-ups (for the coordinator)
- **Barge-in threshold vs VAD hangover (from P3-I1, still open).** `bargeInMinMs` (default 300) is shorter than the energy VAD's `hangoverMs` (500), and `speaking: false` arrives only after the hangover. So any noise the VAD confirms (≥ 120 ms) cuts a reply. The S-7 bursts last 900 ms, so the test does not exercise this. The human run should check it with a real mic and room noise. If short noises cut replies, raise the default `bargeInMinMs` above `hangoverMs`, or let the pipeline cancel a pending barge-in at the VAD's quiet-run boundary.
- `docs/architecture/providers.md:107` still has the stale `Planned (phase 3)` marker (see P3-I1).

### Human run (not done here: needs real API keys; box above left unticked)
1. `bun install`, then `bun run --cwd plugins/web build`.
2. `KEITH_HOME=/tmp/keith-s7 bun packages/core/src/cli/main.ts setup`. Pick the LLM provider, enable `@keith/web`, and choose voice **2 (cloud: Groq STT + OpenAI TTS)**. Or choose **3 (local)** and first run the printed speaches `docker run` command. Export `GROQ_API_KEY` / `OPENAI_API_KEY` as printed.
3. `keith start` (`bun packages/core/src/cli/main.ts start`), then the TUI (`bun run --cwd apps/tui start`). Type a question. Expected: a text answer, and no audio anywhere.
4. Open `http://127.0.0.1:4824/` in a browser (another tab, or another device through HTTPS: voice needs a secure context), sign in, and click **Mic on** (or use Hold to talk). Speak a question. Expected: the browser shows your transcript and plays the answer. The TUI shows the transcript and the same answer text, and plays nothing.
5. Ask for something long, then talk over Keith mid-sentence. Expected: playback stops within about `bargeInMinMs` after you start talking. The stored reply is cut where playback stopped (it shows in the TUI when the turn ends), and the next answer responds to the interruption.
6. Also try a short cough or a tap during a reply. It should **not** cut the reply (see the barge-in follow-up above).
7. Record here: the LLM model, STT model, TTS model and voice, latency from the end of speech to the first audio, and any rough edges (echo, false barge-ins, clipped first words).
