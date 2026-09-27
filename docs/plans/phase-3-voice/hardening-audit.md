# Phase 0–3 audit findings (2026-09-27)

The coordinator ran a read-only audit after P3-I2: task outcomes, contracts vs code, scenarios and invariants, and every architecture doc vs code (about 750 claims). Every ticked acceptance criterion holds. This file lists what was still missing. Tasks P3-K2, P3-H1…H7 and P3-I3 close it, and each item names its task. The owner decided to implement all of them (no `Planned` deferrals except person deletion, which is phase 5 by scope).

**Status (P3-I3, 2026-09-27):** every row below is closed (✔, with the commit and the file or test that closes it) except the **Manual** section, which needs the owner. Commits are on `main` unless marked I3 (branch `task/P3-I3-hardening-integration`).

## Code bugs

| # | Finding | Evidence | Task | Status |
|---|---|---|---|---|
| B1 | `tool.called` / `tool.completed` are emitted twice for every model tool call: once by the run loop and once by the registry's `invoke` | `mind/run-loop.ts:99,122`, `plugins/tools.ts:176,183` | H1 | ✔ `c77912f`: `plugins/tools.ts` is the only emitter; `run-loop.test.ts` T3 |
| B2 | A delivery flush can start while the thread is `listening` (the user is speaking) | `mind/thread-manager.ts` `nextWork`/`canFlush` ignore `rt.listening` | H1 | ✔ `c77912f`: `canFlush` needs `listening === null`; `thread-manager.test.ts` |
| B3 | A failed delivery turn with a `critical` item while user input is queued loops back into another delivery turn, and the queued input never runs (reported by one audit; H1 must reproduce it with a test first) | `mind/thread-manager.ts:339-367` | H1 | ✔ `c77912f`: reproduced by a test first, then fixed (`preempt` per pump run) |
| B4 | Focus fallback picks the *oldest* attached node, but nodes.md says the most recently attached | `thread-manager.ts:449` uses `attachedTo(...)[0]` | H1 | ✔ `c77912f`: `attachedTo(...).at(-1)`; three-node test |
| B5 | `thread.open.historyLimit` above 50 is ignored: `ThreadManager.open` has no limit and the server only trims | `thread-manager.ts:879`, `server/connection.ts:208` | K2 (interface) + H1 | ✔ `3584d6a` (interface), `c77912f` (mind), `57349cb` (server passes it through) |
| B6 | `MindThreadManager.cancelAll()` never added; bootstrap tracks busy threads as a workaround | P1-I1/P1-I2 outcomes | H1 + I3 | ✔ `c77912f` (`cancelAll`); I3 `231cc1c`: shutdown calls `threads.stop()` then `threads.cancelAll()`, `trackRunningTurns` / `cancelRunningTurns` removed; `packages/core/test/bootstrap.test.ts` (shutdown persists the partial reply) |
| B7 | If `welcome` fails validation the socket stays open and the node hangs | `server/attachments.ts:63-71` | H2 | ✔ `57349cb`: close `1011`; `server/delivery-rules.test.ts` |
| B8 | `bargeInMinMs` (300) is shorter than the energy VAD's `hangoverMs` (500), so short noises can cut a reply | `config/schema.ts:108`, `plugins/vad-energy/src/vad.ts:31` | K2 (default) | ✔ `3584d6a`: default 600; voice.md and config.md say why |

## Contract items never produced

| # | Finding | Task | Status |
|---|---|---|---|
| C1 | Core never sends the `notice` frame | K2 (define when) + H2 | ✔ `ced99f8` (protocol.md#notices), `57349cb` (server); I3 `231cc1c`: bootstrap passes `pluginStatus` and `voiceConfigured`; `bootstrap.test.ts` (notice per failed plugin, voice notice) |
| C2 | Error code `RATE_LIMITED` is never produced; a provider `rate_limited` becomes `PROVIDER_ERROR` | K2 + H1 (mind error) + H2 (pass-through) | ✔ `ced99f8`, `fc07851` (sdk code), `c77912f` (mind), `57349cb` (server); I3 `65e6ac8` drops the leftover casts |
| C3 | `chat.text@1` is not enforced: `input.text` and `message.*` frames go to nodes that didn't declare it | K2 + H2 | ✔ `ced99f8`, `57349cb`; `server/delivery-rules.test.ts` |
| C4 | `protocol.md` says `message.user` is input "from another node", but spoken input and UI clicks are echoed to the sender too | K2 | ✔ `ced99f8`: protocol.md#delivery-rules |
| C5 | UI blocks on deliveries (`DeliverySink.enqueue({ ui })`, task results) are validated, stored, then dropped | K2 + H3 (`deliveries.message_id`) + H7 | ✔ `44afb89`, `f7fcc44`; `mind/delivery-ui.test.ts`. Known limitation below |

## Design items the owner chose to build now

| # | Item | Task | Status |
|---|---|---|---|
| D1 | I-1 "exactly one Mind": an exclusive lock on `KEITH_HOME` so two `keith start` can't run together | H4 + I3 | ✔ `9f5befc` (lock; setup and migrate hold it); I3 `231cc1c`: bootstrap takes it first and releases it last; `bootstrap.test.ts` (second Keith fails, first keeps running, lock released on stop and on a failed start), `cli.test.ts` (second `keith start` exits 1 with the message) |
| D2 | Rotating JSON log files in `logs/` (config.md claims them; today the logger writes stdout only) | H4 + I3 | ✔ `9f5befc` (`createLogFile`); I3 `231cc1c`: the default logger also writes `logs/keith.log`, closed on stop; `bootstrap.test.ts` |
| D3 | A per-thread `seq` column for message order, replacing the 1 ms restamp | K2 + H3 + H7 | ✔ `3584d6a`, `44afb89`, `f7fcc44` (restamp removed) |
| D4 | `deliveries.message_id`: which message delivered an item (needed by C5) | K2 + H3 | ✔ `3584d6a`, `44afb89`, `f7fcc44` (scheduler passes the message id) |
| D5 | A check that `core.md` interface blocks match the `types.ts` files (synced by hand today) | H5 | ✔ `2dc4a14`; I3 `231cc1c`: `bun run core-docs` is a step of `bun run check` and listed in AGENTS.md |
| D6 | check-deps: `tests/` outside `e2e` may not import `@keith/core` | H5 | ✔ `2dc4a14`; repository.md and engineering.md R-1 say so (I3 `67f1741`) |
| D7 | TUI `--logout` and scrollback of older history | H6 | ✔ `f610ca5` |

## Test gaps

| # | Gap | Task | Status |
|---|---|---|---|
| T1 | S-8 e2e starts with web already on; it should go TUI-only → enable `@keith/web` → restart → same thread | I3 | ✔ I3 `d8d23d9`: `tests/e2e/s8-web.test.ts` now starts TUI-only, enables `@keith/web`, restarts on the same home; 5/5 runs, CI runs it five times |
| T2 | S-1 non-greeting branch (`on-greeting`, first input not a greeting) has no e2e | I3 | ✔ I3 `d8d23d9`: `tests/e2e/s1-arrival.test.ts` (on-greeting, first input not a greeting); 5/5 runs, CI runs the file five times |
| T3 | Tool-event count through the real registry (hid B1) | H1 | ✔ `c77912f`: `run-loop.test.ts` T3 |

## Doc fixes (all in I3 unless a lane's `updates` covers them)

All applied; in I3 `67f1741` unless noted.

- scenarios.md S-2: `agent: "researcher"` doesn't exist; use `general` or drop `agent`. ✔ `agent` dropped and the `general` default named (overview.md too).
- core.md: the tool filter applies to built-ins too (~1045); `open` sets focus when none (~998); memory step deps (~972); construction order missing voice 4b, data stores, `checkVoiceProviders`, `scheduling.start()` (~966); a briefing always runs and greets (~1040); delivery/briefing turns use the `foreground` role; the recent-messages window counts hidden tool rows. ✔ all seven; the construction order also gains step 0 (the lock) and the shutdown order.
- config.md: `logs/` (after D2), `models.utility` validated now and used from phase 4, name `@keith/web` and `@keith/tool-weather` as core deps. ✔ both `Planned (phase 3, P3-I3)` notes replaced.
- repository.md: add `src/voice/`; plugin `/service` type-only import exception; core's runtime plugin deps; migrations live in `packages/core/drizzle/`; R-4/R-5 checks. ✔ plus `bun run core-docs` and the D6 rule.
- memory.md:83: person deletion → `> Planned (phase 5)`. ✔
- voice.md: listening starts on any node's speech; barge-in in `thinking` or `speaking`, focus node only; `language` key; B8 default. ✔ (the B8 reason itself came with `3584d6a`).
- providers.md: `@keith/vad-energy` row namespace `vad_energy` and config. ✔
- nodes.md / ui.md: passed-through error codes listed the same way (`UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`, `PROVIDER_ERROR`, now `RATE_LIMITED`). ✔ nodes.md by H2 `57349cb`; ui.md's `ui.action` row now lists the same set.
- plugin-system.md: deliveries are rolled back; aborted signal step in `invoke`; a failed plugin keeps its namespace. ✔ plus the one-pair tool-event rule and the delivery-click limitation.
- memory.md: `memory.remember` refusal without a thread. ✔
- AGENTS.md: `bun run deps` (K2). ✔ by K2 `3584d6a`; I3 adds `bun run core-docs`.

## Known limitations (accepted)

- **Clicks on delivery blocks (H7).** A block attached by a delivery names no tool (`toolName: delivery:<source>`), so a click on its buttons becomes the input `(clicked: <label>)`. Routing it to a handler in the delivering plugin would need a plugin-api contract change. Documented in ui.md and plugin-system.md (I3 `67f1741`).

## Manual (owner)

Still open by design: these need a person, real devices, real provider accounts or a push.

Human runs for P1-I1, P1-I2 (S-2), P2-I1 (S-8), P3-I2 (S-7); re-record the synthetic provider fixtures (P1-D1, P3-B1); tune the energy VAD with a real mic; push and watch CI (never run for phases 1–3). DeepSeek reasoning with tools (P1-D1) needs an ADR and a provider contract change; the coordinator proposes it separately.
