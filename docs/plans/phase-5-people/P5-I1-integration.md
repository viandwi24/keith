---
id: P5-I1
title: "Integration: wire relays, group threads, addressing and people into bootstrap"
phase: 5
wave: 3
lane: I
status: todo
owner: null
depends: [P5-S1, P5-A1, P5-N1, P5-B1, P5-C1, P5-C2, P5-C3, P5-D1, P5-E1, P5-F1]
owns:
  - packages/core/**
  - packages/sdk/**
  - packages/protocol/src/**
  - scripts/**
  - package.json
  - .github/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/decisions/0018-deleting-a-person.md
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/nodes.md
updates:
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/storage.md
  - docs/architecture/nodes.md
  - docs/architecture/config.md
  - docs/architecture/overview.md
  - docs/architecture/repository.md
  - docs/concept/scenarios.md
scenarios: [S-4, S-5, S-6]
---

# P5-I1: Phase-5 integration

## Goal

A real `keith start` supports several people: invite links sign people up, relays pass between them, group threads run with addressing, and every phase 0–4 test passes unchanged.

## Scope

**In:**
- **`bootstrap.ts`**, following the core.md construction order (update it):
  - Step 6: `scheduling.relay` exists (P5-K1). Pass the repos `SchedulingDeps` now needs.
  - Step 8: build `createAddressing(...)` and `createGroupThreads(...)`, and pass `addressing` to the thread manager. `createContextBuilder` gets any deps P5-C3 added.
  - Step 10: pass `relay: { service: scheduling.relay, persons }` and `groups: { service: groups, persons, config }` to `registerBuiltins`.
  - No new shutdown step unless a lane added a lifecycle (the addressing classifier's calls are aborted with their turn's input).
- **Integration tests** in `packages/core/test/` (the real core and storage, scripted `fake:chat` and `fake:utility` models, fake clock):
  - `people.test.ts`:
    - The `keith person add` logic on the real home prints a link, and `POST /v1/auth/invite` with its code signs Pepper in.
    - `keith person tier` to guest while Keith runs takes effect on her next turn: her tool list drops `member` tools, without a restart.
    - `keith person remove` with Keith stopped, then start: her threads, memories and group messages are gone, and Tony's group still opens.
  - `relay.test.ts`: Tony's model calls `relay.send({ to: "pepper" })`. Pepper's attached node gets a proactive delivery turn whose `message.completed` has `meta.relayFrom` Tony, and whose context labels the relay. A block, then a second relay, is refused with the generic text and enqueues nothing.
  - `groups.test.ts`:
    - Tony's model calls `thread.start_group`. Pepper's and Rhodey's nodes get `thread.updated` for the creator's row, and each gets an invitation delivery with Join / Decline.
    - Pepper clicks Join (`ui.action` → `(clicked: Join)` → her model calls `thread.join`). Every participant's node gets `thread.updated`.
    - In the group, Pepper → Rhodey small talk makes no `fake:chat` request. "Keith, status?" makes one, with `name`s on the user messages.
    - An unsure line calls `fake:utility` once, and a "no" verdict makes no turn.
    - Rhodey leaves: his node gets `thread.removed`, and his `thread.open` of the group is `FORBIDDEN`.
- **Integration fixes** in any lane's code, recorded per lane in the Outcome (the P3-I1 table). Rerun P5-E1's audit on `main` (it built the "left" fixture with a test helper).
- **Docs:**
  - No `> Planned (phase 5…)` marker left in `docs/architecture`.
  - core.md, memory.md, nodes.md and config.md describe what is built.
  - overview.md: people, relays and group threads in the component overview.
  - repository.md: `mind/addressing/`, `mind/groups.ts`, `scheduler/relay.ts`, `builtins/relay.ts`, `builtins/thread.ts`, `cli/person.ts`.
  - scenarios.md: the phase-5 test descriptions for S-4, S-5 and S-6.
- `keith setup`: no new question. The written `config.toml` shows `[mind.group]`, `auth.inviteTtlHours` and a commented `server.publicUrl`. Update `cli.test.ts`.

**Out:** the S-4 privacy, S-5 and S-6 e2e files and the human run (P5-I2). The web and TUI group UI (P5-F2, P5-F3 run beside this task).

## Acceptance criteria

- [ ] Every phase 0–4 test passes unchanged, including e2e S-1, S-2, S-3 (restart and semantic), S-4, S-7 and S-8.
- [ ] The three integration tests above pass 5 runs in a row.
- [ ] P5-E1's audit passes on `main` with real `removeParticipant`.
- [ ] `grep -rn "Planned (phase 5" docs/architecture` finds nothing.
- [ ] `bun run check` passes.

## Notes

- The e2e harness maps `utility` to `fake:utility` (P4-I2). Group tests that reach the classifier must script it. Old tests never do, because they have no group threads.
- `plugins/web/app/**` and `apps/tui/**` belong to P5-F2 and P5-F3 in this wave. A fix there is a blocker for them, not an edit here.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
