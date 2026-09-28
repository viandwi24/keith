---
id: P5-I1
title: "Integration: wire relays, group threads, addressing and people into bootstrap"
phase: 5
wave: 3
lane: I
status: done
owner: agent-P5-I1
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

- [x] Every phase 0–4 test passes unchanged, including e2e S-1, S-2, S-3 (restart and semantic), S-4, S-7 and S-8.
- [x] The three integration tests above pass 5 runs in a row.
- [x] P5-E1's audit passes on `main` with real `removeParticipant`.
- [x] `grep -rn "Planned (phase 5" docs/architecture` finds nothing.
- [x] `bun run check` passes.

## Notes

- The e2e harness maps `utility` to `fake:utility` (P4-I2). Group tests that reach the classifier must script it. Old tests never do, because they have no group threads.
- `plugins/web/app/**` and `apps/tui/**` belong to P5-F2 and P5-F3 in this wave. A fix there is a blocker for them, not an edit here.


## Wiring notes from wave 2 (coordinator)

- **Addressing:** `createAddressing({ config, runLoop, scheduler: scheduling.scheduler, log })` (P5-D1) and pass it to `createThreadManager({ addressing })` (P5-C2). Until then every group input is addressed.
- **Groups:** build `createGroupThreads` in step 8 and pass `groups: { service: groups, persons: repos.persons, threads: repos.threads, config }` to `registerBuiltins` (P5-C1 added `threads` to `ThreadToolsDeps`).
- **Relay:** pass `relay: { service: scheduling.relay, persons: repos.persons }` to `registerBuiltins` (P5-B1). Remove core.md's remaining `> Planned (phase 5, P5-I1)` markers once wired.
- **Server:** no bootstrap change needed (P5-N1); `createCoreServer` already gets full `repos` and `events`. core.md's Group threads "Frames" line still says "(P5-N1)": reword as built.
- **People CLI (P5-A1):** run `keith person` on a real database (`runCli(['person', …])` or `addPersonForTest`), check that a tier change reaches the next turn without a restart, and that `hashInviteCode(code)` in `cli/person.ts` matches what `POST /v1/auth/invite` hashes (`hashToken` in `server/auth.ts`). Consider exporting one shared hash helper instead of two copies.
- **Storage (P5-S1):** SQLite `lower()` folds ASCII only for name uniqueness; document it. `persons.remove` returns `filePaths` relative to `files/`.
- **Visibility (P5-E1):** rerun `memory/audit.test.ts` on the real storage; it can switch from `markParticipantLeft` to `threads.removeParticipant`.
- **Coordinator fix 6a7d292:** `authTokens.deleteForPerson` and re-inviting former participants are in; no action needed beyond an integration test that a leaver can be re-invited and sees the whole history.
- P5-F2 (web) and P5-F3 (TUI) run beside this task in wave 3; don't edit `plugins/web/app/**` or `apps/tui/**`.

## Outcome

A real `keith start` now supports several people: `keith person add` prints an invite link whose code signs the person up, relays pass between people, and group threads run with the real addressing detector. Every phase 0–4 test passes unchanged, e2e included (S-1, S-2, S-3 restart and semantic, S-4, S-7, S-8: 14 tests).

**Built**
- **`bootstrap.ts`**, in the core.md construction order:
  - Step 8: `createAddressing({ config, runLoop, scheduler: scheduling.scheduler, log })` and `createGroupThreads({ config, repos, deliveries: scheduling.deliveries, events, ids, clock, log })`, each with a child logger (`addressing`, `groups`). `addressing` goes into `createThreadManager`. `createContextBuilder` needed no new deps (P5-C3).
  - Step 10: `registerBuiltins` gets `relay: { service: scheduling.relay, persons: repos.persons }` and `groups: { service: groups, persons: repos.persons, threads: repos.threads, config }`.
  - Step 6 needed no change (`scheduling.relay` came with P5-K1). There is no new shutdown step: a classifier call runs under its thread's signal, which `threads.stop()` / `cancelAll()` abort, and `GroupThreads` holds no timers or subscriptions. `createCoreServer` needed nothing (P5-N1).
- **One hash for invite codes** (`shared/hash.ts`, `sha256Hex`, exported from `shared/index.ts`, tested): `hashInviteCode` (`cli/person.ts`) and `hashToken` (`server/auth.ts`) both call it, so the CLI and `POST /v1/auth/invite` can't drift. Both names stay, so their callers and tests are unchanged. `people.test.ts` also pins `hashInviteCode(code) === hashToken(code)` and finds the stored link by it.
- **`keith setup`** (`cli/setup.ts`): no new question. `[server]` gets a commented `publicUrl`, and `PHASE5_DEFAULTS` (after the phase-4 block) shows `[mind.group]` and `[auth] inviteTtlHours` at their defaults as comments. `cli.test.ts` checks that the block is written, that uncommenting it parses to exactly the defaults, and that `publicUrl` stays unset.
- **Test helpers** (`test/people-helpers.ts`):
  - `routedChat()`: a `fake:chat` that answers by what the request holds, with named routes and an `unmatched` list. Turns of different people run concurrently, so a fixed script order would be flaky.
  - Request helpers: `lastUser`, `afterTool`, `toolResult`.
  - Setup: `createWorld` / `startKeith`, and `signUp`, which runs `addPersonForTest` on the real home while Keith runs, then `POST /v1/auth/invite` with the code, then attaches one node with the main thread open. Also `attachOwner`.
  - `greet` ends the on-greeting arrival hold.
  - Frames: `waitFrame` matches frames by content and returns each one once. Also `frameThread` and `settle`.
- **Integration tests** (real core, real storage, `fake:chat` + `fake:utility`, fake clock). All passed 25 runs in a row (5 loops, then 20 more).
  - `people.test.ts`:
    - `runCli(['person', 'add', 'Pepper'])` while Keith runs prints the link. The stored `invite_links` row is found by `hashInviteCode(code)`. `POST /v1/auth/invite` returns `LoginResponse` for Pepper (member), `/v1/me` answers her, her node opens the main thread the command made, and the code is single use (`401`).
    - Pepper takes a turn as a member: her tools include `reminder.set`, `thread.start_group`, `thread.invite`, `relay.send` and `thread.join`. Then `keith person tier Pepper guest` runs while Keith runs. Her next turn's tools drop the `member` ones and keep the `guest` ones, without a restart.
    - Pepper's model stores a memory about her, Tony starts a group (`autoJoin = true`) and Pepper speaks in it. `keith person remove Pepper --yes` refuses while Keith runs (exit 1, nothing deleted), and succeeds with Keith stopped. After a restart these are gone: the person, her main thread and its messages, the memory, her group message, her participant rows and her token. Tony's `thread.open` of the group returns only his line and Keith's reply.
  - `relay.test.ts`:
    - Tony's model calls `relay.send({ to: "pepper" })`, which emits `delivery.enqueued` (`relay`, `normal`) for Pepper's main thread.
    - Her node gets a `proactive: true` delivery turn. Its `message.completed` has `meta.relayFrom = [{ Tony }]`, and its context has `(relay from Tony) …` plus the relay instruction.
    - Pepper's model calls `relay.block({ from: "Tony" })`, and her card's `blockedRelayFrom` is Tony. Tony's next `relay.send` gets `RELAY_MESSAGES.notAllowed('Pepper')`, and no relay is enqueued or pending.
  - `groups.test.ts`:
    - `thread.start_group`: Tony's node gets `thread.updated` (the group, title, purpose, only Tony, `formerParticipants: []`).
    - Pepper and Rhodey each get the invitation delivery. The card with Join / Decline travels on the message, and the context holds `"Mission" (<id>): Plan the gala.`.
    - A Join `ui.action` becomes `(clicked: Join)`, then `thread.join`, and every participant's node gets `thread.updated` with all three.
    - In the group, "Rhodey, …" and "Pepper, …" make no chat call and no utility call; they are stored and echoed.
    - "Keith, status?" makes one chat request. Its user messages are `{ name, content: 'Name: …' }`, and its system prompt names the group and says "You are answering Tony's message."
    - An unsure line makes exactly one `fake:utility` call (no tools, the line in its input). With `{ addressed: false, confidence: 0.9 }` there is no turn.
    - Rhodey's model calls `thread.leave` from his main thread. His node gets `thread.removed`, and his `thread.open` and `input.text` for the group are `FORBIDDEN`. Tony's and Pepper's nodes get `thread.updated` with Rhodey in `formerParticipants`.
    - Tony's `thread.invite` re-invites him (coordinator fix 6a7d292). He joins again, and his `thread.opened` has all three participants, no former ones, and the whole history.
- **P5-E1's audit on `main`**: `memory/audit.test.ts` now builds its "left" fixtures with the real `threads.removeParticipant`, and all 73 tests pass. I removed the test-only `markParticipantLeft` helper in `storage/testing.ts` and its test (`storage/testing.test.ts`), because nothing uses them any more.
- **Docs:**
  - core.md:
    - The three `> Planned (phase 5, P5-I1)` notes now say what bootstrap does: the factories note, construction-order steps 8 and 10 plus the "no new shutdown step" line, and the built-in tools note.
    - The Group threads intro and its "Frames" line describe the built behavior.
    - The Relays attribution line lost its lane tag.
  - overview.md: the diagram, a **People** row, the Mind and Server rows, and `keith person` in the commands table.
  - repository.md: `cli/person.ts` and `person-testing.ts`, `shared/hash.ts`, `mind/groups.ts`, `mind/addressing/`, `scheduler/relay.ts`, `builtins/relay.ts`, `builtins/thread.ts` and `server/thread-list.ts`.
  - config.md: `keith setup` writes the phase-5 keys as comments.
  - nodes.md: the shared hash.
  - memory.md: the audit uses `removeParticipant`, and the removal integration test.
  - scenarios.md: phase-5 integration test descriptions for S-4, S-5 and S-6.
  - storage.md needed no change: P5-S1 already documents that `lower()` folds ASCII only.
  - `grep -rn "Planned (phase 5" docs/architecture` finds nothing.

### Integration fixes (by lane)

| # | Lane | Fix |
|---|---|---|
| 1 | I (bootstrap) | Build `createAddressing` and `createGroupThreads` in step 8. Pass `addressing` to the ThreadManager, and `relay` / `groups` to `registerBuiltins`. |
| 2 | A1 / N1 (invite hash) | `hashInviteCode` and `hashToken` were two copies of SHA-256 hex. Both now call `shared/hash.ts` `sha256Hex`, as the wiring notes suggested. No behavior change. |
| 3 | E1 (audit) | `audit.test.ts` uses `threads.removeParticipant` instead of `markParticipantLeft`. |
| 4 | K1 (test helper) | Removed `markParticipantLeft` and its test from `storage/testing.ts`, since nothing uses them. |
| 5 | I (setup) | The phase-5 keys and `publicUrl` are written as comments (see above). |

No lane's runtime code needed a behavior fix. The real storage, relay service, group membership, thread manager, context builder, addressing detector and server behaved as the lanes' fakes assumed. That includes the coordinator's re-invite fix.

### Decisions and deviations
- **Invitees get no `thread.updated` before they join.** The scope says "Pepper's and Rhodey's nodes get `thread.updated` for the creator's row" after `thread.start_group`. P5-N1 sends `thread.updated` only to the nodes of *current* participants, and ADR-0017 and D11 list the group only for participants. So pending invitees get the invitation delivery, and their first `thread.updated` arrives when they join. The test checks that, and that Tony's node gets the creator's row. If invitees should see the pending group in their list, that is a new rule for ADR-0017 and P5-N1, not an integration fix.
- **A first `thread.open` is an arrival.** With the default `briefing = "on-greeting"`, a newly signed-up person's deliveries wait until their first input. The tests have each person say "Hi." first (`greet`), which is also what a real person does. Nothing changed in the core.
- **Rhodey leaves from his main thread** (`thread.leave { threadId }`), not by talking in the group. Both paths call the same tool.
- **Invitation card in tests:** the test node declares only `chat.text@1`, so it gets no `ui.render`. The test reads the card from `message.completed`'s `message.ui` and clicks with the same `ui.action` a web node sends.
- `owns` was respected. `docs/concept/scenarios.md` and the architecture docs are in `updates`. Nothing in `plugins/web/app/**`, `apps/tui/**`, `docs/contracts/**` or any `types.ts` changed.
- **One unexplained failure.** Once, while other agents' tests were loading the machine, `keith person add` in the first people test exited 1. That run took 6.4 s, longer than SQLite's 5 s busy timeout. It did not recur in 25 later runs. The assertion now prints the command's output if it fails again.

### Notes for P5-I2
- `test/people-helpers.ts` shows the patterns the e2e files need:
  - Sign up through `addPersonForTest` + `POST /v1/auth/invite`.
  - Greet before expecting deliveries.
  - Route `fake:chat` by request content, because turns of different people interleave.
  - Script `fake:utility` only for lines the rules call unsure. The e2e harness maps `utility` to `fake:utility`, and a group line the rules can't decide makes one utility call.
- The S-4 privacy e2e can reuse the audit's cast. The audit now runs on real `removeParticipant`.
- Human run: check `ADDRESSING_SYSTEM_PROMPT` against a real `utility` model with the corpus's ambiguous lines (P5-D1's note). Also check that an invite link works both in the browser and with `keith-tui --invite` (P5-F2 / P5-F3).
