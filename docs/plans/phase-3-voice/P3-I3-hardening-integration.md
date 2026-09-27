---
id: P3-I3
title: "Hardening integration: wiring, e2e gaps and doc fixes"
phase: 3
wave: 8
lane: I
status: review
owner: agent-P3-I3
depends: [P3-H1, P3-H2, P3-H3, P3-H4, P3-H5, P3-H6, P3-H7]
owns:
  - packages/**
  - plugins/**
  - apps/**
  - tests/**
  - scripts/**
  - package.json
  - .github/**
  - docs/architecture/**
  - docs/concept/scenarios.md
  - docs/rules/engineering.md
  - AGENTS.md
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/plans/phase-3-voice/P3-I1-integration.md
updates:
  - docs/architecture/**
  - docs/concept/scenarios.md
scenarios: []
---

# P3-I3: Hardening integration: wiring, e2e gaps and doc fixes

## Goal

Wire the hardening lanes into a real `keith start`, close the e2e gaps, and apply every doc fix in [hardening-audit.md](hardening-audit.md). After this, the audit list has nothing open except the owner's manual items.

## Scope

**In:**
- Bootstrap: acquire the home lock first and release it last (D1); the file log writer (D2); `cancelAll()` replaces the busy-thread workaround (B6); pass `pluginStatus` / `voiceConfigured` to the server (C1). Add the H5 sync check to `bun run check` if H5 couldn't.
- e2e: T1 (S-8 TUI-only → enable web → restart → same thread and card) and T2 (S-1 non-greeting branch).
- Every item in the audit's "Doc fixes" list.
- Integration fixes per lane recorded in the Outcome.
- **Wiring notes from the lanes:**
  - H1: shutdown uses `threads.cancelAll()`; drop `trackRunningTurns` / `cancelRunningTurns` from bootstrap.
  - H2: pass `pluginStatus: () => host.status()` and `voiceConfigured` to `createCoreServer`.
  - H4: `acquireHomeLock(paths.home)` first and release last in bootstrap (the CLI does not take it for `start`); logger gets `file: createLogFile({ dir: paths.logsDir })`, closed on stop; remove config.md's `> Planned (phase 3, P3-I3)` note.
  - H7: document in plugin-api.md-adjacent architecture docs (ui.md / plugin-system.md, not the contract) that a click on a block attached by a delivery becomes the input `(clicked: <label>)`; routing it to a plugin handler would need a contract change. Add it to hardening-audit.md as a known limitation.
  - H5: root `package.json` gets `"core-docs": "bun scripts/check-core-docs.ts"` and `bun run core-docs` in `check` after `deps`; add `core-docs` to the AGENTS.md command table (AGENTS.md is in owns for this).

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [x] Two `keith start` on one home: the second fails with a readable error (test).
- [x] T1 and T2 pass 5 runs in a row.
- [x] Every audit item is ticked in hardening-audit.md or listed as manual.
- [x] `bun run check` passes.

## Outcome

A real `keith start` now runs with every hardening lane wired in, the two e2e gaps are closed, and every doc fix in [hardening-audit.md](hardening-audit.md) is applied. The audit file has a Status column: every code, contract, design and test row, and every doc fix, is ticked with the commit and the test or file that closes it. Only the owner's **Manual** items stay open, plus one accepted **Known limitation** (H7 delivery clicks).

**Built**
- `packages/core/src/bootstrap.ts`:
  - **D1**: step 0 is `acquireHomeLock(paths.home)`, before config loads. Its release is the first closer pushed, so a failed start releases it last, and shutdown releases it as its final step. A second `keith start` on the same home fails before it opens anything. The CLI prints `INTERNAL: Keith is already running with this home (pid …, since …). Stop it first. Lock file: …` and exits 1.
  - **D2**: without `opts.log`, the logger is `createLogger({ clock, write: opts.logWrite, file: createLogFile({ dir: paths.logsDir }) })`. The file closes after `keith stopped`. A new test-only option `logWrite` replaces stdout and the file still gets every line. A logger passed as `log` (all tests) gets no file.
  - **B6**: shutdown runs `threads.stop()` and then `threads.cancelAll()`. `trackRunningTurns`, `cancelRunningTurns` and the `ThreadId` import are gone.
  - **C1**: `createCoreServer` gets `pluginStatus: () => pluginsRef?.status() ?? []` and `voiceConfigured: config.voice !== undefined`. This is a late binding, because the plugin host is built in step 11, after the server.
- `package.json`: `"core-docs": "bun scripts/check-core-docs.ts"`. `check` runs it after `deps` (H5). AGENTS.md lists it in the command table.
- `.github/workflows/ci.yml`: S-1 now runs five times in a row, like S-8 and S-7.
- Tests:
  - `packages/core/test/bootstrap.test.ts`, 4 new tests:
    - A second Keith on the same home fails with the readable `INTERNAL` error while the first keeps serving, and a new start works after `stop()`.
    - A failed start releases the lock.
    - The default logger writes the same lines to `logs/keith.log` as to stdout, ending with `keith stopped`.
    - An owner node that declared `audio.in@1` gets the failed-plugin `warn` and then the voice `info` notice from a real bootstrap.
  - `packages/core/test/cli.test.ts`: while a first `keith start` runs, a second one exits 1 and prints the lock message.
  - **T1** (`tests/e2e/s8-web.test.ts`): the S-8 test now covers the whole scenario:
    1. Keith starts TUI-only. `@keith/web` is not loaded and `/` answers 404. A TUI turn produces the weather card.
    2. Keith stops, `config.toml` gets `@keith/web`, and Keith restarts on the same home. This also shows that the lock was released.
    3. The TUI reopens the same main thread with the card in history.
    4. The browser signs in and shows the same thread and card. Refresh adds an updated card, and the TUI never gets `ui.render`.
  - **T2** (`tests/e2e/s1-arrival.test.ts`): `on-greeting` with a first input that is not a greeting:
    1. The arrival hold keeps Keith silent, and the item stays pending.
    2. The user turn's system prompt has the pending result and section 8's "Otherwise answer first, then mention them briefly." It has no briefing "Greet them" text.
    3. The reply answers the question first and then mentions the result, and the item is marked delivered.
    4. No delivery or briefing turn follows (`chat.calls` stays 3, and there is exactly one `message.started`).
- Docs:
  - scenarios.md: S-2 without `agent: "researcher"`, test lines for S-1 (non-greeting) and S-8 (restart).
  - core.md: construction order with step 0, 4b, data stores, `checkVoiceProviders`, `scheduling.start()`, the memory deps and the shutdown order. Also: `open` sets focus when none, the tool filter applies to built-ins too, the recent window counts hidden rows, delivery and briefing turns use the `foreground` role, and an `auto` briefing always runs and greets.
  - config.md: the lock and log wiring replace both Planned notes. `utility` is validated at start and first used in phase 4. The first-party plugin deps are listed.
  - repository.md: `src/voice/`, shared lock and log file, `drizzle/`, the runtime plugin deps, `core-docs`, and the dependency rules R-1/R-2 (`/service` exception)/R-4/R-5, including D6.
  - engineering.md: R-1 includes the D6 rule.
  - memory.md: `memory.remember` refuses without a thread, and person deletion is Planned (phase 5).
  - voice.md: listening starts on any node, barge-in only from the focus node while `thinking` or `speaking`, `language`, and the 600 default.
  - providers.md: the `vad_energy` namespace and its config keys.
  - ui.md: the `ui.action` pass-through codes match nodes.md, the H7 delivery-click limitation, and the S-8 test flow.
  - plugin-system.md: failed plugins (deliveries refused, namespace kept, owner notice), the aborted-signal step and the one-pair rule in `invoke`, and the delivery-click limitation.
  - overview.md: the lock, the log file, `cancelAll` and the lock-last shutdown, and `task.start` without `agent`.

**Integration fixes by lane**

| Lane | Fix |
|---|---|
| H1 | Bootstrap uses `threads.cancelAll()` after `threads.stop()`. The busy-thread workaround is removed. |
| H2 | Bootstrap passes `pluginStatus` (late-bound to the host) and `voiceConfigured`. `server/connection.ts` and `delivery-rules.test.ts` drop the `'RATE_LIMITED'` casts, because `KeithErrorCode` has the code since `fc07851` (the gap H2 reported). |
| H4 | Bootstrap takes and releases the lock and writes the log file. config.md's two Planned notes are replaced. |
| H5 | `core-docs` is a named `check` step and is in AGENTS.md. repository.md states the D6 rule. |
| H7 | The delivery-click limitation is documented in ui.md, plugin-system.md and the audit's Known limitations. |
| K2, H3, H6 | Nothing needed. |

**Verification**
- `bun run check`: typecheck, lint, deps, core-docs and plans lint pass. `bun test`: 1185 pass, 3 skip, 0 fail.
- T1 + T2: `bun test tests/e2e/s8-web.test.ts tests/e2e/s1-arrival.test.ts` passed 5 runs in a row (5 pass, 0 fail each time).

**Decisions**
- The lock is taken before config loads, so even a bad `config.toml` can't race a running Keith, and a missing config still gives the same `CONFIG_INVALID`.
- Tests keep passing their own `log`, so they write no log file. Only the default logger gets one. `logWrite` exists so a test can check the file without printing to stdout.
- T1 replaces the old "web already on" S-8 test instead of adding a second browser test. It keeps every earlier assertion, and CI already runs this file five times.

**Deviations**
- `docs/plans/phase-3-voice/hardening-audit.md` is not in `owns`. The coordinator's instructions and the acceptance criteria ask for it to be ticked, so it got the Status column, the Known limitations section and a note on the Manual section.
- `docs/architecture/overview.md` changed through `docs/architecture/**` (in `owns` and `updates`) to keep the shutdown description true.
