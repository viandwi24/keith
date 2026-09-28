---
id: P5-C1
title: "Group threads: start, invite, join and leave, with invitations as deliveries"
phase: 5
wave: 2
lane: C
status: todo
owner: null
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

- [ ] `groups.test.ts` (fake repositories, delivery queue and bus):
  - `start` creates the thread, and the creator is its only participant. Each invitee has a `pending` row and an `invitation` delivery in their main thread, with a card with Join and Decline. `thread.participant_joined` is emitted for the creator.
  - A guest creator and a guest inviter are refused, and so is a list over `maxParticipants`.
  - `join` without an invitation is false. With one, it adds the participant and emits the event with `invitedBy`.
  - `leave` of a participant emits `thread.participant_left`. `leave` of a pending invitation declines it, and a re-invite then works.
  - `autoJoin` joins a member at once, but never a guest.
- [ ] `builtins/thread.test.ts`: names resolve case-insensitively. An unknown name, `thread.invite` outside a group, and `thread.leave` in a direct thread answer tool errors with the fixed wording.
- [ ] `bun run check` passes.

## Notes

- The thread manager caches each thread's participants. It learns about changes only from the two events (P5-C2), so emit them after the storage write.
- The invitation delivery lands in the invitee's main thread like any other delivery. The model sees it in section 8 and, when the invitee answers, calls `thread.join` with the id from the content.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
