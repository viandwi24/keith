---
id: P3-K2
title: "Hardening: contract clarifications and interface additions"
phase: 3
wave: 5
lane: K
status: review
owner: agent-P3-K2
depends: [P3-I1]
owns:
  - docs/contracts/**
  - packages/protocol/**
  - packages/core/src/mind/types.ts
  - packages/core/src/storage/types.ts
  - packages/core/src/server/types.ts
  - packages/core/src/config/**
  - packages/core/src/mind/thread-manager.ts
  - packages/core/src/storage/messages.ts
  - packages/core/src/storage/work.ts
  - packages/core/src/server/test-fakes.ts
  - AGENTS.md
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/contracts/protocol.md
  - docs/architecture/core.md
  - docs/architecture/nodes.md
  - docs/architecture/storage.md
updates:
  - docs/architecture/core.md
  - docs/architecture/nodes.md
  - docs/architecture/config.md
  - docs/architecture/voice.md
scenarios: []
---

# P3-K2: Hardening: contract clarifications and interface additions

## Goal

Every hardening lane can build against fixed contracts and interfaces. Items C1–C5, B5, B8, D3, D4 of [hardening-audit.md](hardening-audit.md). Like P2-K1: no behavior beyond placeholders.

## Scope

**In:**
- protocol.md (clarifications, additive): `message.user` is echoed to the other nodes, and also to the sender for spoken input and `ui.action` clicks (C4). Define when the core sends `notice` (C1): (a) on `welcome`, to an owner node, one `warn` per plugin in state `failed`; (b) when a node declares `audio.in@1` and the deployment has no `[voice]`, one `info` after `welcome`. `RATE_LIMITED` (C2): an `error` for a turn whose provider failed with `rate_limited` after retries. `chat.text@1` (C3): a node without it gets `FORBIDDEN` for `input.text` and receives no `message.*` / `tool.activity` frames. Update the doc tests if tables change.
- `mind/types.ts`: `ThreadManager.open({ ..., historyLimit?: number })` (B5, default 50, max 200).
- `storage/types.ts`: `seq: number` on message records (per thread, strictly increasing, assigned by the repository on insert) (D3); `DeliveriesRepository.markDelivered(ids, deliveredAt, messageId?)` and `messageId` on delivery records (D4).
- Placeholders so `bun run check` stays green (the implementer lanes replace them): the mind passes `historyLimit` through or ignores it; storage fills `seq` from an in-memory counter or 0 and ignores `messageId`. Widen nothing else.
- `config/`: default `voice.bargeInMinMs` becomes 600 (above the VAD's 500 ms hangover, B8); test and config.md updated.
- AGENTS.md: add `bun run deps` to the commands table.
- Mirror the changed interfaces in core.md.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [x] Doc example/table tests pass; new wording in protocol.md is covered where a table changed.
- [x] core.md interface blocks match the changed `types.ts`.
- [x] `bun run check` and `bun run plans --lint` pass.

## Outcome

Everything is additive or a clarification (contracts rule 3). No frame, payload field, error code or interface member was removed or changed meaning. No ADR: the `chat.text@1` rule only makes nodes.md's "the core offers only the features a Node declared" explicit, and every real node (`@keith/client` default, TUI, web) already declares `chat.text@1`.

**Built**
- `protocol.md`:
  - `message.user` row points to a new **Delivery rules** section (C4): echoed to every attached node except the sender; spoken input and the input run for a `ui.action` click also go to the sender.
  - `chat.text@1` (C3): `input.text` without it → `FORBIDDEN`; such a node gets no `message.user` / `message.started` / `message.delta` / `message.completed` / `tool.activity`. Everything else is unchanged for it.
  - **Notices** table (C1): (a) right after `welcome`, to an owner node, one `warn` per plugin in state `failed`; (b) after those, one `info` to a node that declared `audio.in@1` when there is no `[voice]`. No other notice in v1; nodes must still accept `notice` at any time. `text` is for people, never parsed.
  - **Error codes** is now a table with the meaning of each code (C2): `RATE_LIMITED` = a turn whose provider answered `rate_limited` after the core's retries, sent like `PROVIDER_ERROR`. Also states that turn errors go to every attached node without `re`, and frame errors to the sender with `re`.
  - Doc tests (`packages/protocol/test/doc-examples.test.ts`): the error-code table must list exactly `ERROR_CODES` in order, each with a meaning; each notice row must parse as a `notice` frame.
- `mind/types.ts`: `ThreadManager.open({ ..., historyLimit?: number })` (B5). Placeholder: `MindThreadManager.open` ignores it (comment in `thread-manager.ts`); the server test fake already records every argument.
- `storage/types.ts` (D3, D4):
  - `seq?: number` on `MessageRecordBase`: per thread, strictly increasing, assigned by the repository on insert (a value passed to `append` is ignored), defines order, set on every record `get` / `page` return. `page` doc now says `seq` order.
  - `DeliveryRecord = Delivery & { messageId?: MessageId | null }`, returned by `DeliveriesRepository.get`.
  - `markDelivered(ids, deliveredAt, messageId?)`.
  - Placeholders: `storage/messages.ts` doesn't store or return `seq` and still orders by `(created_at, id)`; `storage/work.ts` ignores `messageId`. Both carry a comment naming P3-H3.
- `config/`: `voice.bargeInMinMs` default 600 (B8), with the reason in the type comment; `voice.test.ts` updated.
- Docs: core.md (config, storage, mind blocks mirror the `types.ts` files; checked chunk by chunk), config.md (`bargeInMinMs = 600`), voice.md (why 600 is above the VAD hangover), nodes.md (echo sentence includes clicks; a `> Planned (phase 3, task P3-H2)` note for the delivery rules, notices and `RATE_LIMITED` pass-through), AGENTS.md (`bun run deps` row; `check` description lists deps and plans lint).

**Decisions**
- `seq` and `messageId` are **optional** in the types. A required `seq` on `MessageRecordBase` (or a stored-record type returned by `get`/`page`) breaks typecheck in files no K2 or H3 task owns: every record built in `mind/` (`run-loop.ts`, `thread-manager.ts`, `mind/testing/fakes.ts`, which implements `MessagesRepository`) and many tests. Likewise `scheduler/testing/fakes.ts` implements `DeliveriesRepository.get` returning `Delivery`. The doc comments state the stronger guarantee (always set when read back).
- `messageId` lives on a storage `DeliveryRecord`, not on the domain `Delivery` (`shared/types.ts`, not owned). Pending items have no message, so `pendingFor` keeps returning `Delivery[]`.
- `historyLimit` counts **visible** messages (the ones `thread.opened` carries), matching protocol.md "the last `historyLimit` messages"; range 0..200 as on the wire (the task said "default 50, max 200"; 0 stays allowed because `thread.open` allows it).
- Notice order after `welcome`: failed-plugin `warn`s first, then the voice `info`. Only owner nodes get plugin failures (members and guests can't act on them).
- The placeholder does not fill `seq` from a counter or 0 (the task allowed either): `storage/messages.test.ts` (not owned) compares read-back records with `toEqual`, so an extra `seq` field would fail it.

**Deviations**
- `server/types.ts` and `server/test-fakes.ts` are in `owns` but needed no change: the fake's `open` already records all arguments, and H2's new server deps (`pluginStatus`, `voiceConfigured`) are construction options in H2's own `server/**`.
- core.md's turn-loop prose (provider errors → `PROVIDER_ERROR`) is left for P3-H1, which implements the `RATE_LIMITED` split and owns that doc update.

**Notes for the lanes**
- **P3-H1:** implement `historyLimit` in `open` (default 50, 0 → no messages, count visible messages, so the page may need more than `historyLimit` rows when tool rows are hidden). `RATE_LIMITED` per protocol.md; update core.md's provider-error line. H7 passes `messageId` to `repos.deliveries.markDelivered` from `scheduler/deliveries.ts` (it owns `scheduler/**`).
- **P3-H2 (gap):** `server/connection.ts` still slices `opened.messages` itself and does not pass `frame.data.historyLimit` to `ThreadManager.open`. B5 names K2 + H1, but only H2 owns `server/**`, so H2 should pass it through (keep the slice as a guard). Also replace the Planned note in nodes.md when C1/C3 land. `ws.test.ts` / `audio.test.ts` have clients without `chat.text@1`; they don't send `input.text` today.
- **P3-H3:** tighten nothing in the types unless the coordinator widens `owns` to `mind/**` fakes; fill `seq` on every read record and `messageId` on `get`. storage.md still says `page` orders by `(created_at, id)`; H3 updates it.
- **P3-H5:** the core.md blocks for `config`, `storage` and `mind` match their `types.ts` after this task.
