---
id: P3-H7
title: "Hardening: UI blocks on deliveries, and order by seq"
phase: 3
wave: 7
lane: H
status: done
owner: agent-P3-H7
depends: [P3-H1, P3-H3]
owns:
  - packages/core/src/mind/**
  - packages/core/src/scheduler/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/contracts/plugin-api.md
  - docs/architecture/ui.md
  - docs/architecture/core.md
updates:
  - docs/architecture/core.md
  - docs/architecture/ui.md
scenarios: []
---

# P3-H7: Hardening: UI blocks on deliveries, and order by seq

## Goal

C5 and the mind side of D3 from [hardening-audit.md](hardening-audit.md).

## Scope

**In:**
- When a delivery or briefing turn delivers items that carry `ui` (plugin deliveries, task results), the blocks are attached to that turn's assistant message: persisted as `ui` entries, sent as `ui.render` to `ui.render@1` nodes, with fallback text for the others, exactly like tool UI. Items are marked delivered with the message id.
- Remove the 1 ms restamp (`inOrder`) now that storage orders by `seq`.
- Pass the delivering message id into `repos.deliveries.markDelivered(ids, at, messageId)` from `scheduler/deliveries.ts` (P3-K2 note). Make `seq` set in `mind/testing/fakes.ts` and `scheduler/testing/fakes.ts` so read-back records match storage.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [x] A plugin delivery with a card shows up in `thread.opened` history and as `ui.render` on a web-like node; a text-only node gets the fallback.
- [x] A task result's `ui` reaches the delivered message.
- [x] History order tests pass without the restamp.
- [x] `bun run check` passes.

## Outcome

**Built**
- **C5** (`mind/thread-manager.ts`): when a turn that delivers items completes, `attachDeliveryUi` takes each item's `ui` (plugin deliveries, task results), re-validates it (`validUiBlock`), drops it with a warning if it reuses a block id already on the message (`idsFreeIn`), stores it as a `ui` entry of the delivering assistant message (`toolCallId: delivery:<deliveryId>`, `toolName: delivery:<source>`) and sends `ui.render` (fallback `uiBlockToText(block)`) to the thread's `ui.render@1` nodes, before `message.completed`. Text-only nodes get no `ui.render`; they get the blocks in `message.completed` / history, as for tool UI. Items are then marked delivered with that message id (unchanged path).
- **D3** (mind side): removed the 1 ms restamp (`inOrder`); `append` stores records as they are and storage's `seq` gives the order.
- `scheduler/deliveries.ts`: `markDelivered` passes `messageId` to `repos.deliveries.markDelivered(ids, at, messageId)`.
- Fakes match storage: `mind/testing/fakes.ts` assigns `seq` per thread on append (ignoring a passed value) and pages by `seq`; `scheduler/testing/fakes.ts` stores `messageId` on `markDelivered` (pending rows only), `get` always sets it (null if none), `pendingFor` returns plain `Delivery` values.
- Tests: `mind/delivery-ui.test.ts` (plugin card on a web-like and a text-only node, reopen history, task-result `ui`, arrival user turn, failed turn attaches nothing and the retry attaches once, duplicate block id dropped, click on a delivered block becomes `(clicked: <label>)`, history order by `seq` with a frozen clock and tool rows). All C5 tests failed with the attach call removed. `scheduler/deliveries.test.ts` checks the stored `messageId`.
- Docs: core.md (turn messages order by `seq`; delivery turn attaches item blocks), ui.md (delivered items carry blocks; clicks become input).

**Decisions**
- Blocks attach only when the turn completes (not failed, not cancelled). A failed or cancelled turn leaves its items pending, so attaching then would show the block twice after the retry.
- A user turn that carries pending items after an arrival also attaches their blocks: it delivers them just like a delivery turn.
- `toolName: delivery:<source>` names no registered tool (tool names have no `:`), so `ui.action` on such a block falls back to the `(clicked: <label>)` input. Routing clicks to a plugin handler would need a contract change; not in scope.
- Queued inputs are still stamped with the turn-start time when persisted (only the restamp was removed); order no longer depends on it.

**Deviations**
- None. `bun run check`: 1179 pass, 3 skip, 0 fail.
