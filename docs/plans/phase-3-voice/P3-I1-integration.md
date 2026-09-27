---
id: P3-I1
title: "Integration: wire voice into bootstrap, setup and config"
phase: 3
wave: 3
lane: I
status: in-progress
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

- [ ] Starting with a bad `voice.stt` id fails with a readable error. Starting without `[voice]` is exactly phase-2 behavior (existing tests are unchanged).
- [ ] The integration test above passes, and so does barge-in through the real pipeline (fake providers).
- [ ] Setup tests cover the three voice choices.
- [ ] No `> Planned (phase 3)` markers remain in `docs/architecture`, except items ADR-0013 defers.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
