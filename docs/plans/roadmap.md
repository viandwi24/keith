# Roadmap

Every phase ends with an integration task whose end-to-end tests play out its scenarios ([scenarios.md](../concept/scenarios.md)). A phase is done when those tests pass and a human has used the result for real.

Phase 1 deliberately proves what makes Keith different: promises, background work, speaking first, and remembering. It does this before any web UI, voice or multi-person polish (lesson [L-3](../concept/lessons.md)).

| Phase | Theme | Delivers | Scenarios | Parallel lanes |
|---|---|---|---|---|
| **0** | Foundation | Repo scaffold, frozen contracts (`@keith/protocol`, `@keith/sdk`), core internal interfaces | none (enables all) | Mostly sequential (4 small tasks) |
| **1** | Living core + TUI | Core process, plugin host, SQLite, server + auth, turn loop, tasks, commitments, deliveries, arrival briefing, memory v1, OpenRouter + DeepSeek, TUI | S-1, S-2, S-3, S-4 (concurrency) | 8 lanes in wave 1, then integration |
| **2** | Web + plugin UI | `@keith/client`, `@keith/web` client-app plugin, UI block rendering, files endpoint, reference tool plugin with UI | S-8 | ~4 lanes |
| **3** | Voice | Binary audio frames, VAD/STT/TTS seams, one local + one cloud adapter each, browser mic/speaker, barge-in | S-7 | ~5 lanes |
| **4** | Memory + proactivity | Reflection, thread summaries, relationship card updates, reminders, briefing skills, backups | S-3 (semantic) | ~4 lanes |
| **5** | People + collaboration | Members and guests, invites, visibility enforcement everywhere, relay, group threads, addressing | S-4 (privacy), S-5, S-6 | ~5 lanes |
| **6** | Workspace | Workspace state + tools, web renderer, shared group workspace | S-6 (shared state) | ~3 lanes |
| **7** | System node (Rust) | Node pairing, headless node, `fs`/`screen`/`notify`/audio capabilities, wake word, protocol JSON Schema export | none new | ~4 lanes |
| **8** | Ecosystem | MCP tool bridge, Telegram client app, realtime speech-to-speech, more providers | none new | Independent lanes |

## Dependencies between phases

```
0 ──► 1 ──► 2 ──► 3
            │     │
            ├──► 4 ◄┘ (memory can start after 2; voice not required)
            │
            └──► 5 ──► 6
      1 ──────────────────► 7 (needs only the protocol + core from 1)
      2 ──────────────────► 8 (lanes independent; each needs its prerequisite phase)
```

Phases 3, 4 and 7 can overlap once phase 2 is done, if there are enough agents. Each has its own coordinator and non-overlapping `owns`.

## Phase exit checklist

- [ ] Integration task `done`, and its e2e scenario tests pass in CI
- [ ] A human used the phase's result end to end (notes in the integration task's Outcome)
- [ ] `docs/architecture/*` has no `Planned (phase N)` markers left for this phase
- [ ] Next phase's task files written by the coordinator

### Phase 4 status (P4-I2)

- [ ] Integration task `done`, and its e2e scenario tests pass in CI: `tests/e2e/s3-semantic.test.ts` and `tests/e2e/s1-reminder.test.ts` pass five runs in a row locally, and CI runs each five times in a row (not yet observed in CI). P4-I2 is in review.
- [ ] A human used the phase's result end to end: pending, needs a real API key (steps in [P4-I2](phase-4-memory/P4-I2-e2e.md#human-run-owner-real-keys)).
- [x] `docs/architecture/*` has no `Planned (phase 4…)` markers left.
- [ ] Next phase's task files written by the coordinator.
