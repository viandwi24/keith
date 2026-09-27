# Phase 0–3 audit findings (2026-09-27)

The coordinator ran a read-only audit after P3-I2: task outcomes, contracts vs code, scenarios and invariants, and every architecture doc vs code (about 750 claims). Every ticked acceptance criterion holds. This file lists what was still missing. Tasks P3-K2, P3-H1…H7 and P3-I3 close it, and each item names its task. The owner decided to implement all of them (no `Planned` deferrals except person deletion, which is phase 5 by scope).

## Code bugs

| # | Finding | Evidence | Task |
|---|---|---|---|
| B1 | `tool.called` / `tool.completed` are emitted twice for every model tool call: once by the run loop and once by the registry's `invoke` | `mind/run-loop.ts:99,122`, `plugins/tools.ts:176,183` | H1 |
| B2 | A delivery flush can start while the thread is `listening` (the user is speaking) | `mind/thread-manager.ts` `nextWork`/`canFlush` ignore `rt.listening` | H1 |
| B3 | A failed delivery turn with a `critical` item while user input is queued loops back into another delivery turn, and the queued input never runs (reported by one audit; H1 must reproduce it with a test first) | `mind/thread-manager.ts:339-367` | H1 |
| B4 | Focus fallback picks the *oldest* attached node, but nodes.md says the most recently attached | `thread-manager.ts:449` uses `attachedTo(...)[0]` | H1 |
| B5 | `thread.open.historyLimit` above 50 is ignored: `ThreadManager.open` has no limit and the server only trims | `thread-manager.ts:879`, `server/connection.ts:208` | K2 (interface) + H1 |
| B6 | `MindThreadManager.cancelAll()` never added; bootstrap tracks busy threads as a workaround | P1-I1/P1-I2 outcomes | H1 + I3 |
| B7 | If `welcome` fails validation the socket stays open and the node hangs | `server/attachments.ts:63-71` | H2 |
| B8 | `bargeInMinMs` (300) is shorter than the energy VAD's `hangoverMs` (500), so short noises can cut a reply | `config/schema.ts:108`, `plugins/vad-energy/src/vad.ts:31` | K2 (default) |

## Contract items never produced

| # | Finding | Task |
|---|---|---|
| C1 | Core never sends the `notice` frame | K2 (define when) + H2 |
| C2 | Error code `RATE_LIMITED` is never produced; a provider `rate_limited` becomes `PROVIDER_ERROR` | K2 + H1 (mind error) + H2 (pass-through) |
| C3 | `chat.text@1` is not enforced: `input.text` and `message.*` frames go to nodes that didn't declare it | K2 + H2 |
| C4 | `protocol.md` says `message.user` is input "from another node", but spoken input and UI clicks are echoed to the sender too | K2 |
| C5 | UI blocks on deliveries (`DeliverySink.enqueue({ ui })`, task results) are validated, stored, then dropped | K2 + H3 (`deliveries.message_id`) + H7 |

## Design items the owner chose to build now

| # | Item | Task |
|---|---|---|
| D1 | I-1 "exactly one Mind": an exclusive lock on `KEITH_HOME` so two `keith start` can't run together | H4 + I3 |
| D2 | Rotating JSON log files in `logs/` (config.md claims them; today the logger writes stdout only) | H4 + I3 |
| D3 | A per-thread `seq` column for message order, replacing the 1 ms restamp | K2 + H3 + H7 |
| D4 | `deliveries.message_id`: which message delivered an item (needed by C5) | K2 + H3 |
| D5 | A check that `core.md` interface blocks match the `types.ts` files (synced by hand today) | H5 |
| D6 | check-deps: `tests/` outside `e2e` may not import `@keith/core` | H5 |
| D7 | TUI `--logout` and scrollback of older history | H6 |

## Test gaps

| # | Gap | Task |
|---|---|---|
| T1 | S-8 e2e starts with web already on; it should go TUI-only → enable `@keith/web` → restart → same thread | I3 |
| T2 | S-1 non-greeting branch (`on-greeting`, first input not a greeting) has no e2e | I3 |
| T3 | Tool-event count through the real registry (hid B1) | H1 |

## Doc fixes (all in I3 unless a lane's `updates` covers them)

- scenarios.md S-2: `agent: "researcher"` doesn't exist; use `general` or drop `agent`.
- core.md: the tool filter applies to built-ins too (~1045); `open` sets focus when none (~998); memory step deps (~972); construction order missing voice 4b, data stores, `checkVoiceProviders`, `scheduling.start()` (~966); a briefing always runs and greets (~1040); delivery/briefing turns use the `foreground` role; the recent-messages window counts hidden tool rows.
- config.md: `logs/` (after D2), `models.utility` validated now and used from phase 4, name `@keith/web` and `@keith/tool-weather` as core deps.
- repository.md: add `src/voice/`; plugin `/service` type-only import exception; core's runtime plugin deps; migrations live in `packages/core/drizzle/`; R-4/R-5 checks.
- memory.md:83: person deletion → `> Planned (phase 5)`.
- voice.md: listening starts on any node's speech; barge-in in `thinking` or `speaking`, focus node only; `language` key; B8 default.
- providers.md: `@keith/vad-energy` row namespace `vad_energy` and config.
- nodes.md / ui.md: passed-through error codes listed the same way (`UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`, `PROVIDER_ERROR`, now `RATE_LIMITED`).
- plugin-system.md: deliveries are rolled back; aborted signal step in `invoke`; a failed plugin keeps its namespace.
- memory.md: `memory.remember` refusal without a thread.
- AGENTS.md: `bun run deps` (K2).

## Manual (owner)

Human runs for P1-I1, P1-I2 (S-2), P2-I1 (S-8), P3-I2 (S-7); re-record the synthetic provider fixtures (P1-D1, P3-B1); tune the energy VAD with a real mic; push and watch CI (never run for phases 1–3). DeepSeek reasoning with tools (P1-D1) needs an ADR and a provider contract change; the coordinator proposes it separately.
