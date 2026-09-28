---
id: P5-K1
title: Phase-5 contract additions and core interfaces for people, relays and group threads
phase: 5
wave: 1
lane: K
status: in-progress
owner: agent-P5-K1
depends: [P4-I2]
owns:
  - docs/contracts/**
  - packages/protocol/src/**
  - packages/sdk/src/events.ts
  - packages/sdk/src/events.test.ts
  - packages/core/src/config/**
  - packages/core/src/shared/types.ts
  - packages/core/src/storage/**
  - packages/core/src/mind/**
  - packages/core/src/scheduler/**
  - packages/core/src/memory/testing/**
  - packages/core/src/builtins/**
  - packages/core/src/server/**
  - packages/core/src/cli/**
  - packages/client/src/state.ts
  - packages/client/src/state.test.ts
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/decisions/0018-deleting-a-person.md
  - docs/concept/model.md
  - docs/concept/scenarios.md
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/storage.md
  - docs/architecture/nodes.md
  - docs/architecture/config.md
  - docs/contracts/protocol.md
  - docs/contracts/events.md
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/plans/phase-4-memory/P4-K1-contracts.md
updates:
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/storage.md
  - docs/architecture/nodes.md
  - docs/architecture/config.md
  - docs/architecture/providers.md
  - docs/concept/glossary.md
  - docs/rules/conventions.md
scenarios: [S-4, S-5, S-6]
---

# P5-K1: Phase-5 contract additions and core interfaces

## Goal

Every wave-2 lane builds against fixed types: the additive protocol for group threads, relay attribution and invite links; two participant events; the `[mind.group]`, `auth.inviteTtlHours` and `server.publicUrl` config keys; the storage types for invite links, group invitations, participants and person removal; the core interfaces for addressing, group threads and relays; the `relay.*` and `thread.*` tool specs; and the `keith person` command surface. Placeholders keep `bun run check` green. The coordinator runs it after [ADR-0017](../../decisions/0017-tier-rules-for-relays-and-group-threads.md) and [ADR-0018](../../decisions/0018-deleting-a-person.md) are accepted.

The hardening audit's lesson applies: every interface a wave-2 lane needs is fixed **here**, and every implementer that a type change breaks gets a placeholder **here**. A lane that finds a missing member is blocked. It doesn't add the member itself.

## Scope

**In (all additive, contracts rule 3):**

- **Protocol** (`protocol.md`, `@keith/protocol`, schema tests, one ` ```json frame` example per new frame):
  - `ThreadDto` gains `purpose?: string` (group threads; absent for direct threads) and `formerParticipants?: PersonDto[]` (people who left a group; absent or empty otherwise). Both are optional, so phase-4 nodes and cores stay compatible.
  - `MessageDto.meta.relayFrom?: { personId: string; name: string }[]`: set on an assistant message whose delivery turn carried relays, one entry per sender, in delivery order (I-13). The name is the one the recipient saw, so it survives a rename or a deletion.
  - Core → node `thread.updated { thread: ThreadDto }` (phase 5): a group thread was created, or its participants changed. It goes to every connected attended node of every current participant, whether or not that node has the thread open, so a new group appears in the thread list.
  - Core → node `thread.removed { threadId }` (phase 5): the node's person left the thread. The node closes it and drops it from its list.
  - Neither is a chat frame, so a node without `chat.text@1` still gets them (add them to the delivery rules).
  - `POST /v1/auth/invite`, auth none, body `InviteAcceptRequest { code, username, password }`, response `LoginResponse` (`{ token, person, expiresAt }`). `code` is the invite link's code (43 base64url characters). Username and password follow the `keith setup` rules (password ≥ 8 characters). A wrong, used or expired code is `401 UNAUTHORIZED` (ADR-0017). A taken username or an invalid body is `400 INVALID_REQUEST`.
  - The `message.user` row loses "or a relay": relays arrive as deliveries (open decision D4). No new node → core frame (D3).
- **Events** (`events.md`, `@keith/sdk` `CoreEventMap`, `CORE_EVENT_NAMES`, test):
  - `thread.participant_joined`: `{ threadId, personId, invitedBy: string | null }`. A person became a current participant of a group thread. `invitedBy` is null for the creator.
  - `thread.participant_left`: `{ threadId, personId }`. A current participant left.
  - Both phase 5. No `relay.*` or `person.*` events: a relay is a `delivery.enqueued` with `kind: 'relay'`, and person commands run in the CLI process, outside the bus (D12).
- **Config** (types, zod schema, defaults, tests, config.md). Every key but `publicUrl` has a default:
  ```toml
  [server]
  # publicUrl = "https://keith.example.net"   # optional: the base of invite links; default http://<host>:<port>

  [auth]
  inviteTtlHours = 72

  [mind.group]
  maxParticipants = 8          # current participants plus pending invitations
  autoJoin = false             # ADR-0017: members and owners join at once; guests always accept
  addressing = "rules+utility" # or "rules": no utility-model fallback
  ```
- **Shared types** (`shared/types.ts`): `ThreadInvitationStatus = 'pending' | 'accepted' | 'declined'` and `ThreadInvitation { threadId; personId; invitedBy: PersonId; status; deliveryId: DeliveryId | null; createdAt; resolvedAt: number | null }`.
- **Storage types** (`storage/types.ts`, every member with JSDoc; the wave-2 lanes build fakes from these comments):
  - `PersonsRepository`:
    - `findByName(name)`: trims, matches `name` case-insensitively, then `username`; null when nothing matches. Names are unique case-insensitively (enforced by `keith person add`, D13).
    - `setTier(id, tier)`.
    - `setCredentials(id, { username, passwordHash })`.
    - `remove(id): Promise<PersonRemoval>`: the ADR-0018 transaction. `PersonRemoval` holds a count per kind of row and `filePaths: string[]` (relative to the files folder) for the command to delete.
  - `ThreadRecord.purpose?: string | null | undefined` (optional, the cursor precedent).
  - `ThreadsRepository`:
    - `addParticipant(threadId, personId, at)`: inserts a row, or clears `left_at` and sets `joined_at` on a former participant's row. Returns false when the person is already a current participant.
    - `removeParticipant(threadId, personId, at)`: sets `left_at`, and returns whether a current participant left.
    - `formerParticipants(threadId)`: rows with `left_at` set, most recent first.
  - `ThreadInvitationsRepository` (`Repositories.threadInvitations`):
    - `create(inv)`: a new `pending` row, or a re-invitation after `declined` replaces the row. Returns false when a `pending` or `accepted` row exists.
    - `get(threadId, personId)`.
    - `pendingForThread(threadId)` and `pendingForPerson(personId)`.
    - `resolve(threadId, personId, status, at)`: changes only a `pending` row, and returns whether it did.
  - `InviteLinkRecord { codeHash; personId; createdAt; expiresAt; usedAt: number | null }` and `InviteLinksRepository` (`Repositories.inviteLinks`):
    - `create`, `get(codeHash)`;
    - `markUsed(codeHash, at)`: only an unused row; returns whether it changed;
    - `revokeFor(personId)`: deletes the person's unused links.
  - `MessageMeta.relayFrom?: { personId: PersonId; name: string }[] | undefined`.
- **Mind types** (`mind/types.ts`):
  ```ts
  export type AddressingVerdict = {
    addressed: boolean
    /** Which rule decided. 'unsure' means not addressed (the Mind doesn't interrupt humans). */
    by: 'single_human' | 'name' | 'reply' | 'question' | 'other_human' | 'classifier' | 'unsure' | 'default'
  }
  export interface AddressingDetector {
    /** Whether the Mind should take a turn for this input in a group thread. Never throws. */
    decide(a: {
      threadId: ThreadId
      input: { authorPersonId: PersonId; text: string }
      /** Visible messages before the input, oldest first (at most 10). */
      recent: MessageRecord[]
      /** Current participants' names. */
      participantNames: string[]
      signal: AbortSignal
    }): Promise<AddressingVerdict>
  }
  export interface GroupThreads {
    start(a: { creatorId: PersonId; inviteeIds: PersonId[]; title: string; purpose: string | null }): Promise<{ thread: ThreadRecord; invited: PersonId[]; joined: PersonId[] }>
    invite(a: { threadId: ThreadId; inviterId: PersonId; inviteeIds: PersonId[] }): Promise<{ invited: PersonId[]; joined: PersonId[]; skipped: PersonId[] }>
    /** Accepts a pending invitation. False without one. */
    join(a: { threadId: ThreadId; personId: PersonId }): Promise<boolean>
    /** Leaves a group, or declines a pending invitation. False when neither applies. */
    leave(a: { threadId: ThreadId; personId: PersonId }): Promise<boolean>
  }
  ```
  - Refusals by rule (tier, limit, not a participant) are `KeithError('FORBIDDEN')` with a `details.reason`, which the tools turn into tool errors. Fix the reasons here.
  - Factories, as placeholders:
    - `createAddressing(deps)` in `mind/addressing/index.ts`: `decide` returns `{ addressed: true, by: 'default' }`, which is today's behavior.
    - `createGroupThreads(deps)` in `mind/groups.ts`: every method throws `INTERNAL` "not implemented yet (P5-C1)".
    - Both are exported from `mind/index.ts`.
  - Their deps are fixed here:
    - `AddressingDeps`: `config` (`mind`), `runLoop`, `scheduler` (`run`), `log`.
    - `GroupThreadsDeps`: `config` (`mind`), `repos` (`persons`, `threads`, `threadInvitations`), `deliveries` (`enqueue`), `events`, `ids`, `clock`, `log`.
  - `ThreadManagerDeps.addressing?: AddressingDetector` (optional, so bootstrap compiles unchanged).
- **Scheduler types** (`scheduler/types.ts`):
  ```ts
  export type RelayResult =
    | { ok: true; delivery: Delivery }
    | { ok: false; reason: 'unknown_recipient' | 'self' | 'not_allowed' }
  export interface RelayService {
    /** I-13 per ADR-0017. Enqueues a `relay` delivery authored by the sender into the recipient's main thread. */
    send(a: { fromPersonId: PersonId; toPersonId: PersonId; text: string }): Promise<RelayResult>
    /** Adds or removes `from` in `personId`'s `blockedRelayFrom`. Returns whether the list changed. */
    block(a: { personId: PersonId; from: PersonId }): Promise<boolean>
    unblock(a: { personId: PersonId; from: PersonId }): Promise<boolean>
  }
  ```
  - `scheduler/relay.ts` has `createRelayService(deps)` as a placeholder that throws "not implemented yet (P5-B1)". Its deps: `repos` (`persons`, `relationships`, `threads`), `deliveries` (`enqueue`), `log`.
  - `createScheduling` builds it and exposes `Scheduling.relay`. `SchedulingDeps.repos` gains what the relay and the group-task change (P5-E1) need: `persons`, `relationships`, `threads`.
- **Built-in tool specs** (the bodies return a tool error "not implemented yet (P5-B1)" / "(P5-C1)"), `minTier` from ADR-0017:
  - `builtins/relay.ts`:
    - `relay.send { to: string (1..80), text: string (1..2000) }`, `guest`;
    - `relay.block { from: string }` and `relay.unblock { from: string }`, `guest`.
  - `builtins/thread.ts`:
    - `thread.start_group { participants: string[] (1..7), title: string (1..80), purpose?: string (..500) }`, `member`;
    - `thread.invite { participants: string[] (1..7) }`, `member`, in the current group thread;
    - `thread.join { threadId }`, `guest`;
    - `thread.leave { threadId? }` (default: the current thread), `guest`.
  - Export the input schemas, the tool names and the answer wording (`RELAY_MESSAGES`, `THREAD_MESSAGES`), including ADR-0017's refusal texts.
  - `registerBuiltins` registers the relay tools only when `BuiltinDeps.relay` (`{ service: RelayService; persons: Pick<PersonsRepository, 'findByName'> }`) is given, and the thread tools only when `BuiltinDeps.groups` (`{ service: GroupThreads; persons: Pick<PersonsRepository, 'findByName'>; config: Pick<KeithConfig, 'mind'> }`) is given. Both are optional, so bootstrap compiles unchanged, and P5-I1 wires them. The tools resolve names through `persons`, so the lanes need nothing else from `builtins/index.ts`.
- **CLI surface** (`cli/index.ts` dispatch and usage text, `cli/person.ts` placeholder that prints "not implemented yet (P5-A1)" and exits 1):
  ```
  keith person add <name> [--tier member|guest]     creates the person, their relationship and main thread; prints an invite link
  keith person list
  keith person invite <name>                         a new invite link; revokes older unused ones
  keith person tier <name> <member|guest>
  keith person card <name> [--tone <text>] [--notes <text>]   shows or edits the relationship card
  keith person block <name> --from <other>  /  keith person unblock <name> --from <other>
  keith person remove <name> [--yes]                 ADR-0018; needs Keith stopped
  ```
  The invite link is `<publicUrl>/#invite=<code>`: a fragment, so the code never reaches a server log. The command also prints the code for the TUI (`keith-tui --invite <code>`).
- **Server types** (`server/types.ts`): `AttachmentRegistry.nodesOfPerson(personId): NodeId[]`, the connected attended nodes of a person in connect order, whether or not they have a thread open. P5-N1 needs it to send `thread.updated` / `thread.removed`. The placeholder in `server/attachments.ts` returns `[]`, and every fake that implements `AttachmentRegistry` gets the member.
- **DTO pass-through:** `server/dto.ts` and `mind/messages.ts` copy `meta.relayFrom` into `MessageDto.meta`. Nothing sets it yet, so behavior doesn't change.
- **Placeholders in implementers:**
  - `storage/persons.ts` and `storage/threads.ts` get the new members, and new `storage/invite-links.ts` and `storage/thread-invitations.ts` hold their repositories (wired in `db.ts`). All throw `INTERNAL` "not implemented yet (P5-S1)".
  - `storage/testing.ts` gains `markParticipantLeft(db, threadId, personId, at)`, a real, test-only helper, so P5-E1's audit can build a "left" participant on a real database before P5-S1 lands.
  - Every fake that implements a changed interface gets the new members: `memory/testing/**`, `mind/testing/**`, `scheduler/testing/**` and `server/test-fakes.ts`. So do config literals in tests.
  - `packages/client/src/state.ts` ignores `thread.updated` and `thread.removed` (P5-F1 handles them).
- **Docs:**
  - core.md: the config, shared, storage, mind and scheduler blocks, the built-in tools table (all seven tools with their tiers), a "Group threads" section and a "Relays" subsection under Deliveries, both marked `> Planned (phase 5, P5-…)`. Remove the old group-threads Planned note.
  - memory.md: replace the person-deletion Planned note with ADR-0018's list, marked `(P5-S1, P5-A1)`.
  - storage.md: `invite_links`, `thread_invitations`, `threads.purpose`, and the repository semantics, marked `(P5-S1)`.
  - nodes.md: the invite-link flow and `keith person`, replacing the phase-5 Planned note, marked `(P5-A1, P5-N1)`. The WS lifecycle gets `thread.updated` / `thread.removed`.
  - config.md: the new keys and `keith person`.
  - providers.md: `utility` is used by the addressing classifier.
  - glossary.md: **Invite link** ("A single-use link that lets a new Person set their username and password"; don't say "signup token", "invitation", which stays the group-thread delivery).
  - `bun run core-docs` must pass.

**Out:** any behavior beyond placeholders. The Drizzle schema and migrations are P5-S1's, and `bootstrap.ts` is P5-I1's.

## Deliverables

- The frames, DTO fields, endpoint, events, config keys, types, factory signatures, tool specs and CLI surface above, with placeholders.
- Doc blocks in core.md that match every changed `types.ts` (`bun run core-docs`).

## Acceptance criteria

- [ ] `frames.test.ts` / `dto.test.ts`: the new frames and fields parse, the protocol.md examples parse, and a phase-4 `ThreadDto` (without the new fields) still parses.
- [ ] `events.test.ts` (sdk) checks the two new events against events.md, and `CORE_EVENT_NAMES` includes them.
- [ ] Config: `config/group.test.ts` (new). An empty file gives every default above. `KEITH__MIND__GROUP__MAXPARTICIPANTS=4` gives 4. `maxParticipants = 1` and `inviteTtlHours = 0` are `CONFIG_INVALID`, and so is a `publicUrl` that is not an `http(s)` URL.
- [ ] `builtins/relay.test.ts` and `builtins/thread.test.ts` (spec only): names, input schemas and `minTier` as above. `registerBuiltins` without `relay` / `groups` registers none of them.
- [ ] `cli.test.ts`-style unit test in `cli/`: `keith person` without a subcommand prints the usage, and each subcommand reaches the placeholder.
- [ ] Existing tests pass unchanged. `createAddressing`'s placeholder answers `addressed: true`.
- [ ] `bun run core-docs` passes.
- [ ] `bun run plans --lint` is clean. Once this is `done`, `bun run plans --ready` lists P5-S1, P5-A1, P5-N1, P5-B1, P5-C1, P5-C2, P5-C3, P5-D1, P5-E1 and P5-F1.
- [ ] `bun run check` passes.

## Notes

- **Placeholders must not change behavior.** Bootstrap doesn't call the new factories yet, and no `relay.*` or `thread.*` tool is registered.
- Keep `ThreadRecord.purpose` optional, or every `ThreadRecord` literal in the repo breaks.
- If typecheck shows another implementer outside `owns` (for example an exhaustive `switch` over `CoreFrame` in `apps/tui` or `plugins/web/app`), widen `owns` for that one file and record it under Deviations (the P3-K1 precedent). Don't skip the placeholder.
- The addressing verdict's `by` values are fixed here so that P5-C2 can log them and P5-D1 can test them. P5-D1 decides the rules behind them.
- `thread.start_group`'s `participants` holds names or usernames, not ids. The tools resolve them with `persons.findByName`. Participants and invitees are always people other than the caller.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
