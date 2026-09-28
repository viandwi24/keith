---
id: P5-C1
title: "Group threads: start, invite, join and leave, with invitations as deliveries"
phase: 5
wave: 2
lane: C
status: review
owner: agent-P5-C1
depends: [P5-K1]
owns:
  - packages/core/src/mind/groups.ts
  - packages/core/src/mind/groups.test.ts
  - packages/core/src/builtins/thread.ts
  - packages/core/src/builtins/thread.test.ts
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/concept/scenarios.md
  - docs/architecture/core.md
  - docs/contracts/ui-blocks.md
updates:
  - docs/architecture/core.md
scenarios: [S-6]
---

# P5-C1: Group membership

## Goal

"Connect me with Pepper and Rhodey" creates a group thread (S-6 step 1). Pepper and Rhodey get an invitation in their main threads (step 2), and they can join, decline or later leave. Membership changes are events that the thread manager and the server react to.

## Scope

**In:**
- `createGroupThreads(deps)` (`mind/groups.ts`, same deps as the P5-K1 placeholder), following ADR-0017:
  - `start`:
    - Refuses (`FORBIDDEN`, with the `details.reason` values P5-K1 fixed) a creator below `member`, an empty or self-including invitee list, an unknown invitee, and more than `mind.group.maxParticipants − 1` invitees.
    - Creates a `group` thread (`slug` null, `ownerPersonId` = creator, `title`, `purpose`) with the creator as its only participant, and emits `thread.participant_joined { invitedBy: null }`.
    - Then invites the others as `invite` does.
  - `invite`:
    - Only a current participant with tier `member` or higher, only in a `group` thread, only within `maxParticipants` (current participants plus pending invitations).
    - People who are already participants or already invited are returned in `skipped`.
    - Each new invitee gets a `thread_invitations` row (`pending`) and an `invitation` delivery in their main thread, with `authorPersonId` = inviter and `urgency: 'normal'`.
    - The delivery content names the inviter, the title, the purpose and the thread id, and says how to answer: "Tony invites you to the group thread "Mission" (thr_…): <purpose>. Say whether you want to join."
    - Its `ui` is a card with the same text and an `actions` block, **Join** and **Decline** (clicks become `(clicked: Join)` input, ui.md).
    - The row stores the delivery id.
    - With `mind.group.autoJoin`, an invitee with tier `member` or higher joins at once (`joined`). Their delivery says they were added, and has no buttons.
  - `join`: needs a `pending` invitation. It resolves it `accepted`, calls `threads.addParticipant`, and emits `thread.participant_joined { invitedBy }`.
  - `leave`:
    - A current participant of a group: `removeParticipant`, then `thread.participant_left`.
    - A pending invitation: resolved `declined`, and no event.
    - Otherwise false. Leaving a direct thread is refused (`FORBIDDEN`).
- The tools (`builtins/thread.ts`, keeping P5-K1's names, schemas, `minTier` and `THREAD_MESSAGES`):
  - `thread.start_group { participants, title, purpose? }`: resolves names with `deps.persons.findByName`. It answers with the new thread's id and title, who was invited and who joined.
  - `thread.invite { participants }`: in the current thread, which must be a group.
  - `thread.join { threadId }`: the caller accepts. The answer tells the model the thread's title, so it can tell the person where to find it.
  - `thread.leave { threadId? }`: the current thread by default. Inside the group itself, the answer is the last thing the leaver's turn says there.
  - Refusals come back as tool errors with the wording from `THREAD_MESSAGES`, never as thrown errors.
- core.md: the membership part of the "Group threads" section (start, invite, join, leave, invitation deliveries, autoJoin), with its `(P5-C1)` marker removed.

**Out:** what happens inside the group (fan-out, addressing, context: P5-C2, P5-C3, P5-D1), the frames to nodes (P5-N1), memory and task visibility in groups (P5-E1).

## Acceptance criteria

- [x] `groups.test.ts` (fake repositories, delivery queue and bus):
  - `start` creates the thread, and the creator is its only participant. Each invitee has a `pending` row and an `invitation` delivery in their main thread, with a card with Join and Decline. `thread.participant_joined` is emitted for the creator.
  - A guest creator and a guest inviter are refused, and so is a list over `maxParticipants`.
  - `join` without an invitation is false. With one, it adds the participant and emits the event with `invitedBy`.
  - `leave` of a participant emits `thread.participant_left`. `leave` of a pending invitation declines it, and a re-invite then works.
  - `autoJoin` joins a member at once, but never a guest.
- [x] `builtins/thread.test.ts`: names resolve case-insensitively. An unknown name, `thread.invite` outside a group, and `thread.leave` in a direct thread answer tool errors with the fixed wording.
- [x] `bun run check` passes.

## Notes

- The thread manager caches each thread's participants. It learns about changes only from the two events (P5-C2), so emit them after the storage write.
- The invitation delivery lands in the invitee's main thread like any other delivery. The model sees it in section 8 and, when the invitee answers, calls `thread.join` with the id from the content.

## Outcome

**Built**
- `mind/groups.ts`: `createGroupThreads(deps)` (same `GroupThreadsDeps`) implements `start`, `invite`, `join` and `leave` per ADR-0017. Refusals throw `KeithError('FORBIDDEN', …, { details: { reason } })` with P5-K1's `GroupRefusalReason`s; an unknown thread throws `NOT_FOUND`. Events are emitted after the storage write. Also exports `invitationText`, `INVITATION_CARD_ID` (`group_invitation`) and `INVITATION_ACTIONS_ID` (`group_invitation_actions`).
  - Invitation delivery: `kind: 'invitation'`, `authorPersonId` = inviter, `urgency: 'normal'`, main thread (queue default). Content: `Tony invites you to the group thread "Mission" (thr_…): <purpose>. Say whether you want to join.` (no `: <purpose>` without one; no double period when the purpose ends a sentence). `ui`: a card with the same text as `body` and an `actions` child with Join (`primary`) and Decline (`secondary`).
  - Order per invitee: enqueue the delivery, then `threadInvitations.create` with its id (the repository has no setter for `deliveryId`).
  - autoJoin (member or higher): the notice says `Tony added you to the group thread "Mission" (thr_…)…. It is in your thread list.`, the card has no buttons, the row is stored `accepted` (with `resolvedAt`), then `addParticipant` and `thread.participant_joined { invitedBy }`.
  - `start` dedupes invitee ids and checks `limit` (more than `maxParticipants − 1`) before creating anything.
- `builtins/thread.ts`: the four tool bodies, keeping P5-K1's names, schemas, `minTier` and `THREAD_MESSAGES`. Refusals and `NOT_FOUND` map to tool errors (`refused[reason]`, `limit` with `config.mind.group.maxParticipants`, `noSuchThread`); other errors are rethrown. `thread.invite` with no current thread answers `refused.not_group`; `thread.leave` with no thread answers `noSuchThread`.
- Tests: `mind/groups.test.ts` (13 tests, own in-memory `ThreadInvitationsRepository` fake from its JSDoc, plus the mind fakes) and `builtins/thread.test.ts` (P5-K1's spec tests plus 12 behavior tests against a fake `GroupThreads`).
- core.md: the "Group threads" membership part (with the invitation text, card, autoJoin, tools), the `(P5-C1)` markers removed from the factories note, the built-in tools note and the section marker; the P5-I1 bootstrap note now passes `threads` in `groups`.

**Decisions**
- **`ThreadToolsDeps` gained `threads: Pick<ThreadsRepository, 'get' | 'participants'>`.** `GroupThreads.join` / `leave` return only booleans, but the answers need the title (`joined(title)`, `left(title)`, `declined(title)`), and `thread.leave` must tell "left" from "declined". The type lives in `builtins/thread.ts` (owned by this task), not in a `types.ts`.
- Order of `invite` checks: `NOT_FOUND`, `not_group`, `not_participant`, `tier`, then the invitee list (`no_invitees`, `self`, `unknown_person`), then `limit`. An unknown creator in `start` is `NOT_FOUND`.
- `join` only emits when `addParticipant` actually added the person; `leave` of a participant wins over a pending invitation.

**Deviations / follow-ups**
- **Re-inviting a former participant doesn't work yet.** ADR-0017 says someone invited again sees the whole history, but `ThreadInvitationsRepository.create` replaces only a `declined` row, and a former participant keeps an `accepted` one. `invite` therefore returns them in `skipped` (with a warning log), without sending a delivery; tested and documented in core.md as a known limitation. Fix (contract change, coordinator): let `create` also replace an `accepted` row whose person is no longer a current participant, then drop the pre-check in `groups.ts` `inviteChecked`.

**Notes for other lanes**
- **P5-I1:** step 10 passes `groups: { service: groups, persons: repos.persons, threads: repos.threads, config }` (the new `threads` member). core.md's bootstrap note says so.
- **P5-C2 / P5-N1:** `thread.participant_joined` is emitted for the creator at `start` (`invitedBy: null`), for each auto-joined invitee and on `join`; `thread.participant_left` only when a current participant leaves (declining emits nothing).
- **P5-C3:** invitation deliveries are ordinary `invitation` deliveries in section 8; the content carries the thread id the model passes to `thread.join`.
- **P5-S1:** `ThreadInvitationsRepository` is used exactly as its JSDoc says (`get`, `pendingForThread`, `create`, `resolve`).
