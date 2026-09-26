# Phase 1: Living core + TUI

**Goal:** Keith runs as one process with a terminal client, backed by DeepSeek or OpenRouter. It keeps promises, works in the background, speaks first when work is done, briefs you when you come back, and remembers after a restart.

**Scenarios:** S-1 (delivery-based briefing), S-2, S-3 (history), S-4 (concurrency).

## Waves

**Wave 1: eight lanes in parallel.** Every lane builds against the frozen contracts (`@keith/protocol`, `@keith/sdk`) and the core `types.ts` interfaces from P0-04. In unit tests, lanes fake the other lanes from those interfaces.

| Task | Lane | Owns (summary) |
|---|---|---|
| [P1-A1 Plugin host, registries, events, config](P1-A1-plugin-host.md) | A | `core/src/{shared,config,plugins,events}` |
| [P1-B1 Storage](P1-B1-storage.md) | B | `core/src/storage` |
| [P1-C1 Server, auth, handshake, presence](P1-C1-server.md) | C | `core/src/server` |
| [P1-D1 OpenAI-compatible helper + OpenRouter + DeepSeek](P1-D1-providers.md) | D | `sdk/src/providers/openai-compatible`, `plugins/provider-*` |
| [P1-E1 Mind: threads, turn loop, context, deliveries flush](P1-E1-mind.md) | E | `core/src/mind`, `builtins/skill.ts` |
| [P1-F1 TUI](P1-F1-tui.md) | F | `apps/tui` |
| [P1-G1 Scheduler, tasks, commitments, delivery queue](P1-G1-scheduler.md) | G | `core/src/scheduler`, `builtins/task.ts` |
| [P1-M1 Memory v1](P1-M1-memory.md) | M | `core/src/memory`, `builtins/memory.ts` |

**Wave 2:** [P1-I1 Bootstrap and CLI](P1-I1-bootstrap.md). Wires everything into `keith setup` and `keith start`.

**Wave 3:** [P1-I2 End-to-end scenarios](P1-I2-e2e.md). Plays S-1…S-4 end to end and fixes integration bugs.

```
P0-04 ─┬─ A1 ─┐
       ├─ B1 ─┤
       ├─ C1 ─┤
       ├─ D1 ─┤
       ├─ E1 ─┼─► I1 ─► I2
       ├─ F1 ─┤
       ├─ G1 ─┤
       └─ M1 ─┘
```

## Rules specific to this phase

- `packages/core/src/*/types.ts` are **frozen during wave 1**. If a lane needs an interface change, it records a blocker, and the coordinator makes the change in a small dedicated task that every affected lane rebases onto.
- `packages/core/src/builtins/` is split by file: each lane owns only its file. `builtins/index.ts` belongs to I1.
- No lane edits `bootstrap.ts`.

## Exit

- `tests/e2e` S-1, S-2, S-3, S-4 pass in CI with the fake LLM.
- A human ran `keith setup`, `keith start` and the TUI against DeepSeek (or OpenRouter), asked for a background task, kept chatting, and received the unsolicited result. Notes go in P1-I2's Outcome.
