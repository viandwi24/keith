---
id: P3-I1
title: "Integration: wire voice into bootstrap, setup and config"
phase: 3
wave: 3
lane: I
status: done
owner: agent-P3-I1
depends: [P3-A1, P3-A2, P3-B1, P3-D1, P3-E1]
owns:
  - packages/core/**
  - packages/client/**
  - packages/sdk/**
  - packages/protocol/src/**
  - plugins/**
  - apps/tui/**
  - scripts/**
  - package.json
  - .github/**
reads:
  - docs/architecture/voice.md
  - docs/architecture/config.md
  - docs/plans/phase-3-voice.md
updates:
  - docs/architecture/voice.md
  - docs/architecture/config.md
  - docs/architecture/overview.md
  - docs/architecture/repository.md
  - docs/architecture/nodes.md
scenarios: [S-7]
---

# P3-I1: Voice integration

## Goal

A real `keith start` with a `[voice]` section runs the whole cascade: bootstrap builds the voice pipeline from the configured providers and hands it to the server and the Mind. `keith setup` can turn voice on.

## Scope

**In:**
- `bootstrap.ts`: after the plugin host starts, resolve `config.voice.{vad,stt,tts}` against the provider registries. An unknown id → `CONFIG_INVALID` naming the id and the registered ones. Build `createVoice(...)` and pass `input` to the server and `output` to the ThreadManager. No `[voice]` → nothing changes.
- `@keith/core` depends on the four new plugins (`bun add …@workspace:*`), so loading them by name works under the isolated linker (the lesson from P2-I1, fix 3).
- `keith setup`: optional voice question: none / cloud (Groq + OpenAI) / local (speaches) / mixed. It writes `[voice]`, enables the plugins, writes keys as `env:` references, and prints the speaches `docker run` hint for local.
- An integration test in `packages/core/test/`: the real core with `vad-energy` and fake-fetch voice plugins. A protocol node sends PCM16 speech → an audio-modality user message is persisted → the reply's audio frames arrive at that node only.
- Fix integration bugs in any lane's code, recorded per lane in the Outcome (as in P2-I1).
- **Known cross-lane fixes (from the wave-2 reviews):**
  - `voice.bargeInMinMs` is applied twice: P3-A1's pipeline holds `voiceActivity({ speaking: true })` until speech lasted `bargeInMinMs`, and P3-A2's Mind applies it again. Keep it in the Mind (only the Mind knows whether a turn is running). The pipeline reports raw VAD start/stop. Add a test through the real pipeline and Mind that a barge-in fires after about `bargeInMinMs`, not twice that.
  - `createVoice` needs `capabilities(nodeId)` (P3-A1). Supply it from the capabilities the server records at `hello`.
  - Pass `voice.output` to `createThreadManager({ voice })` with a `config` that includes `voice`, and `voice.input` to `createCoreServer({ voice })` (P3-A2).
  - Docs P3-E1 could not touch: `voice.md` (browser side is built now) and `repository.md` (the `@keith/client` audio API). Add both to this task's doc changes.
  - `packages/client/src/chat.test.ts` has a pre-existing race (reads `turnState` before the idle state arrives; about 1 failure in 7 runs). Make it deterministic.
  - P3-A2 keeps a spoken reply `speaking` until playback ends and sends `message.completed` only then, also to nodes without audio. Check that this is acceptable in the S-7 test (the text still streams live via `message.delta`), and record it in voice.md.
- Clear the coordinator notes from P2-I1: nodes.md (the "ui.action until phase 2" clause) and config.md (setup offers the optional plugins).

**Out:** the S-7 browser e2e (P3-I2).

## Acceptance criteria

- [x] Starting with a bad `voice.stt` id fails with a readable error. Starting without `[voice]` is exactly phase-2 behavior (existing tests are unchanged).
- [x] The integration test above passes, and so does barge-in through the real pipeline (fake providers).
- [x] Setup tests cover the three voice choices.
- [x] No `> Planned (phase 3)` markers remain in `docs/architecture`, except items ADR-0013 defers.
- [x] `bun run check` passes.

## Outcome

A real `keith start` with a `[voice]` section now runs the whole cascade. `packages/core/test/voice.test.ts` boots the real core with `@keith/vad-energy`, `@keith/voice-groq` and `@keith/voice-openai` loaded **by package name** from config. Their `baseUrl` points at a local fake Groq/OpenAI server (`Bun.serve`), so the real SDK audio helpers, real energy VAD and real pipeline, server and Mind all run. A text-only node and a voice node (`audio.in@1` + `audio.out@1`) share the main thread. The voice node streams PCM16 speech (400 ms silence, 600 ms tone, 800 ms silence, 20 ms kind-1 frames). The test checks four things:
- the transcript is persisted as a `user` message with `modality: 'audio'`;
- both nodes get the reply text, and the text-only node gets live `message.delta`s;
- only the voice node gets `audio.start`, kind-2 frames with sequence 0, 1, 2, … and `audio.end`, and the text-only node gets no audio frame at all;
- history holds `user/audio` then `assistant/audio`.

### Integration fixes (by lane)

| # | Lane | Fix |
|---|---|---|
| 1 | I (bootstrap) | `bootstrap.ts` builds `createVoice(...)` when `[voice]` is present. `voice.input` goes to `createCoreServer({ voice })`. `voice.output` goes to `createThreadManager({ voice })`, whose `config` already carries `voice`. The pipeline reaches the ThreadManager through a late binding, because each needs the other. After `plugins.startAll()`, the new `checkVoiceProviders` (`voice/check.ts`) fails with `CONFIG_INVALID` for an unknown `voice.vad/stt/tts` id, naming the key, the id and the registered ids. Without `[voice]`, nothing is built and every phase-2 test passes unchanged. |
| 2 | I (bootstrap) / A1 | `createVoice` needs `capabilities(nodeId)`. Bootstrap now keeps the capabilities from each node's latest `hello`, taken from the `node.connected` event. |
| 3 | I (core deps) | `bun add @keith/vad-energy@workspace:* @keith/voice-groq@workspace:* @keith/voice-openai@workspace:* @keith/voice-speaches@workspace:*` in `packages/core`, so the isolated linker resolves them by name. The integration test covers this. |
| 4 | A1 (voice pipeline) | `bargeInMinMs` was applied twice. `voice/input.ts` now sends `voiceActivity({ speaking: true })` at the VAD's `speech.start`, and only the Mind applies the minimum. `input.test.ts` has a new test for this. The barge-in test runs through the real pipeline and Mind with real-time 20 ms chunks and `bargeInMinMs = 500`. `audio.stop` must arrive between 500 and 950 ms after speech onset. With the old pipeline code, the same test measured 1115 ms and failed. The test also checks that the cut reply is stored with `meta.cancelled`, `spokenChars` > 0 and `content === reply.slice(0, spokenChars)`, and that the barge-in's own words become the next `audio` input. |
| 5 | A2 (Mind) | The speaking node never saw its own transcript: `message.user` was echoed only to the *other* nodes, and a node that spoke has no local text to show. `mind/thread-manager.ts` now echoes spoken input (`modality: 'audio'`) to the sender too, as it already did for UI clicks (`echoToSender`). The S-7 test checks this. |
| 6 | E1 (client) | `packages/client/src/chat.test.ts` race: the test now waits for both the finished assistant message and `turnState === 'idle'` before its final assertions. 8 extra runs in a row, plus the full suite, gave 0 failures. |
| 7 | I (setup) | `keith setup` asks about voice after the optional plugins: 1) none (default) 2) cloud (Groq STT + OpenAI TTS) 3) local (speaches) 4) mixed (Groq STT + speaches TTS). It writes `[voice]` (`vad = "energy"`), enables `@keith/vad-energy` and the voice plugins (not `required`), and writes keys as `env:GROQ_API_KEY` / `env:OPENAI_API_KEY`. It then prints the keys to export. For local and mixed, it also prints speaches' CPU `docker run` command (from speaches.ai/installation, checked 2026-09-27). On an existing config without `[voice]`, it prints how to turn voice on. `cli.test.ts` covers all three voice choices, and the existing answer scripts gained the voice answer. |

### Decisions
- **"mixed" = Groq STT + local speaches TTS.** Cloud STT is fast and cheap, and Kokoro TTS runs well on a CPU. People who want the other split can edit `[voice]`.
- A2's "`message.completed` only after playback" is kept. In the S-7 test the text-only node gets the full text live through `message.delta`, and `message.completed` arrives when the audio has been sent. This is recorded in voice.md (Turn-taking).
- The node capabilities for the pipeline are kept after a disconnect. The next `hello` for that node id replaces them, and speech sent to a node that is gone goes nowhere.

### Docs
- `voice.md`: the Planned banner is replaced by what is built, pointing to the items ADR-0013 defers. The pipeline's bargeInMinMs bullet is corrected. New sections: "Wiring (bootstrap)" and "Browser side". Turn-taking now covers the transcript echo to the speaker and playback-bound `message.completed`.
- `config.md`: the Planned note is replaced by the startup check, and `keith setup` describes the voice question.
- `overview.md`: the setup row mentions voice.
- `repository.md`: the voice plugins are in the tree, and `@keith/client` lists its audio API (`audio` / `onAudio` options, `startAudio` / `sendAudio` / `endAudio`, `audio.ts`, playback queue).
- `nodes.md`: spoken transcripts are echoed to the speaking node.
- The P2-I1 coordinator notes were already resolved on main. nodes.md has no "ui.action until phase 2" clause, and config.md already describes the optional plugins. Nothing was left to change.

### For the coordinator (outside `owns` / `updates`)
- `docs/architecture/providers.md:107` still has `> Planned (phase 3): @keith/vad-energy (P3-D1)`. P3-D1 is done, so this line should go. It is the only `Planned (phase 3)` marker left in `docs/architecture`, which is why that acceptance box is not ticked. providers.md is not in this task's `updates`.
- `docs/architecture/core.md:996` says every input is echoed to the *other* nodes. Since fix 5, spoken input also goes to the speaking node. `docs/contracts/protocol.md` describes `message.user` as input "from another node, or a relay". That was already loose for UI clicks (ui.md). A one-line contract clarification may be worth adding: "or the node's own spoken input".
- Tuning follow-up: with the energy VAD, `speech.end` arrives after `hangoverMs` (500 ms). A noise shorter than `bargeInMinMs` therefore still becomes a barge-in unless `bargeInMinMs` > `hangoverMs`, because the `speaking: false` that would cancel the pending barge-in comes too late. The default is 300 ms. Consider raising it, or tune it against real microphone audio in P3-I2 / a human run.

### Human run (not done here)
Run `KEITH_HOME=/tmp/keith-s7 bun packages/core/src/cli/main.ts setup` and pick voice 2 (cloud) or 3 (local, after the printed `docker run`). Then build the web app, `keith start`, open `http://127.0.0.1:4824/` and use Mic on / Hold to talk. Record the model, voices, latency and rough edges here.

`bun run check`: 1094 pass, 3 skip, 0 fail.
