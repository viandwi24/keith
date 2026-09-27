---
id: P3-K2
title: "Hardening: contract clarifications and interface additions"
phase: 3
wave: 5
lane: K
status: in-progress
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

- [ ] Doc example/table tests pass; new wording in protocol.md is covered where a table changed.
- [ ] core.md interface blocks match the changed `types.ts`.
- [ ] `bun run check` and `bun run plans --lint` pass.

## Outcome

_Filled by the agent when finishing._
