---
id: P3-I1
title: "Integration: wire voice into bootstrap, setup and config"
phase: 3
wave: 3
lane: I
status: todo
owner: null
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
