---
id: P1-I2
title: End-to-end scenarios S-1 to S-4
phase: 1
wave: 3
lane: I
status: review
owner: agent-P1-I2
depends: [P1-I1]
owns:
  - tests/e2e/**
  - packages/core/**
  - packages/sdk/**
  - packages/protocol/src/**
  - apps/tui/**
  - plugins/provider-openrouter/**
  - plugins/provider-deepseek/**
  - scripts/**
reads:
  - docs/concept/scenarios.md
  - docs/concept/model.md
  - docs/architecture/core.md
updates:
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/nodes.md
scenarios: [S-1, S-2, S-3, S-4]
---

# P1-I2: End-to-end scenarios S-1 to S-4

## Goal

Prove phase 1: the scenarios pass against the real core process, over the real protocol, with a scripted fake LLM.

## Scope

**In:**
- `tests/e2e/harness.ts`: boots the core in-process through `bootstrap({ home, plugins: [fakeLlmPlugin], clock })` with a temp `KEITH_HOME` and small `awayAfterMinutes`, creates persons, and offers a protocol-level client (login, WS, frame expectations with timeouts).
- One test file per scenario: `s1-arrival.test.ts`, `s2-background.test.ts`, `s3-restart.test.ts`, `s4-concurrency.test.ts`, implementing the tests described in scenarios.md.
- Fix integration bugs found along the way. This task alone may edit any phase-1 path in `owns`. Implementation bugs in `@keith/protocol` may be fixed. Contract *semantics* may not (blocker + ADR). **List every fix in the Outcome** with the lane it belonged to.
- Re-run the wave-1 lanes' key fake-backed tests against the real implementations (real SQLite, real scheduler).
- Human run: the coordinator (or the user) runs Keith with the TUI against a real model and follows S-2. Record observations and papercuts as follow-up tasks.

**Out:**
- New features. Anything that isn't a bug found by a scenario becomes a follow-up task.

## Acceptance criteria

- [x] S-1, S-2, S-3, S-4 e2e tests pass in CI (`bun run check` locally; 12 consecutive runs plus 12 runs four-at-a-time under load).
- [x] Every fix is listed in the Outcome.
- [x] Follow-up tasks are created for papercuts (phase-2 folder or a `phase-1-followups` list in the Outcome).
- [x] No `> Planned (phase 1)` markers remain in `docs/architecture`.
- [x] `bun run check` passes.

## Outcome

**Built** (`tests/e2e/`, 8 tests, all against the real core booted in-process by `bootstrap`: real SQLite in a temp `KEITH_HOME`, real scheduler lanes, event bus, plugin host, server on port 0, mind, memory; only the LLM is scripted and the clock is a fake one):

| File | What |
|---|---|
| `harness.ts` | `e2eConfig`/`createHome` (config with `fake:chat` for `foreground`, `fake:researcher` for `background`, small `awayAfterMinutes`, long scheduler tick), `startKeith` (bootstrap with the fake provider plugin, env `{}`, in-memory logger; `KEITH_TEST_LOG=1` prints it), `addPerson` (person + optional relationship card), `scriptedProvider` (one `fake` LLM provider routing by model to `createFakeLlm` scripts, with an abortable `before` hook), `createGate`, `nextEvent`, `eventually`, and `connectNode`: a protocol-level node (HTTP login, WS `hello`/`welcome`, every core frame validated with `parseCoreFrame`, `pong`, `next(type, match)` with timeouts, `openMain`, `say`, `reply`). |
| `s1-arrival.test.ts` | **S-1 / I-10:** a task completes while no node is attached; the delivery stays pending while Tony is away; after the threshold he reconnects (`person.arrived` with `awayMs`), an e2e `tool` plugin listening to `person.arrived` queues "3 headlines" (real plugin host, delivery sink and `plugin_data`), the `on-greeting` hold keeps Keith silent, and "Hello Keith." gets a reply with the task result and the headlines; both deliveries are marked delivered. Also `briefing = auto` (proactive briefing with no input) and a reconnect below the threshold (no arrival; flush trigger (d) sends the delivery turn after `thread.opened`, which checks the C1/E1 attach ordering). |
| `s2-background.test.ts` | **S-2 / I-5 / I-11:** `task.start` with a commitment ends the turn while the task runs (held in its model call, occupying a background slot); a second user turn completes while the task still runs; releasing the task fulfils the commitment, queues a `task_result` delivery, and the node receives an unsolicited `proactive` message with the result; event order, stored history and the delivery turn's replayed messages are asserted. |
| `s3-restart.test.ts` | **S-3:** stop the core and boot a new one on the same home: `thread.opened` returns the history, the task keeps its result, the next turn's context contains yesterday's report and `task.status` still returns the result. Plus: a task interrupted by a shutdown is recovered on start (attempt 2), completes and still reports back. |
| `s4-concurrency.test.ts` | **S-4 / I-3 / I-4:** Tony and Pepper send at once; a barrier model proves both turns are mid-stream at the same time (it fails loudly if the core serialized them); each context holds only its own messages and its own relationship tone; Pepper's awareness digest says the Mind is busy "with someone else" without Tony's name, thread title or content. |

The wave-1 lanes' key fake-backed flows (G1 task/commitment/delivery, E1 flush triggers and holds, C1 presence/arrival and attach order, B1 reopen, A1 plugin host with real registries, delivery sink and plugin data, M1 digest) now run against the real implementations through these tests.

**Fixes (with lane)**

1. **E1 (mind), message order within one millisecond.** A turn's assistant message gets its id at `message.started`, before the run loop stores the tool-step rows, and history is ordered by `(createdAt, id)`. When the final message was stored in the same millisecond as its tool step (always with the fake clock, and possible with a real one after a fast tool), it sorted *before* its tool step, so the next turn replayed `user, assistant(reply), assistant(toolCalls), tool`. Queued inputs (id taken on arrival, stored when their turn starts) had the same risk. `thread-manager.ts` now stamps such a record one millisecond after the thread's latest row (`inOrder`). Found by the S-1 `auto` test; covered by the S-1 and S-2 replay assertions. Documented in core.md "The turn loop" (Messages of a turn).

No other bugs were found. The C1 risk (frames sent during `open` don't reach the opener) does not bite: E1's trigger (d) and the hold/grace timers all start after `open` returns, and S-1 checks that `thread.opened` precedes the delivery turn's frames.

**Decisions and notes**

- **Imports in `tests/e2e`:** it isn't a workspace package, so under the isolated linker it can't resolve `@keith/*` by name. The tests import the packages' entry files by relative path (`../../packages/core/src/index.ts`, `.../sdk/src/testing/index.ts`, `.../protocol/src/index.ts`). check-deps allows any import from `tests/e2e`, and symlinked workspace packages resolve to the same files, so these are the same module instances. No root `package.json` change was needed.
- Presence arrival uses the injected fake clock (tests call `clock.advance`). Hold/grace timers and the connection timers are real, so the tests use a long `holdMs` (60 s) and a short `graceMs`, and never fake timers, so real sockets work.
- `cancelAll()` was not added to `MindThreadManager`. Bootstrap's workaround (P1-I1) works in every shutdown the tests exercise, including shutdown during a running task.
- The **human run** (Keith with the TUI against a real model, following S-2) was not done. It needs a person with an API key; the coordinator runs it and records papercuts.
- No `> Planned (phase 1)` markers were left in `docs/architecture` (checked core.md, memory.md, nodes.md and the rest). No contradictions found between docs.

**phase-1-followups**

1. **Server: a dropped `welcome` hangs the node.** A person row with a malformed id (my first harness draft) made `attachments.send` drop the invalid `welcome` frame (R-9, logged), and the node then waited with no answer. The server should close the socket (e.g. 1011) when a handshake frame fails validation, and persons should get ids from `Ids` only (`keith person add` in phase 5 should validate).
2. **Message order:** the one-millisecond restamp is a small fix. A per-thread sequence column in `messages` (storage + migration) would make the order independent of timestamps.
3. **`MindThreadManager.cancelAll()`** (from P1-I1) to replace bootstrap's busy-thread tracking.
4. **`ThreadManager.open` `historyLimit`** (from C1/E1): `open` returns at most 50 messages.
5. **Workspace resolution for `tests/e2e`:** if bare `@keith/*` imports are wanted there, the root `package.json` needs `devDependencies` `@keith/core`, `@keith/sdk`, `@keith/protocol` as `workspace:*` (coordinator change).
6. **Human S-2 run** with the TUI and a real model (see above).
