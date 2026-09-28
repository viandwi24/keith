---
id: P5-C3
title: "Group context: author names in LlmMessage.name, every participant's card, relay and invitation labels"
phase: 5
wave: 2
lane: C
status: done
owner: agent-P5-C3
depends: [P5-K1]
owns:
  - packages/core/src/mind/context-builder.ts
  - packages/core/src/mind/context-builder.test.ts
  - packages/core/src/mind/context-sections.ts
  - packages/core/src/mind/context-sections.test.ts
  - packages/core/src/mind/messages.ts
  - packages/core/src/mind/messages.test.ts
reads:
  - docs/plans/phase-5-people/README.md
  - docs/concept/scenarios.md
  - docs/architecture/core.md
  - docs/contracts/providers.md
updates:
  - docs/architecture/core.md
scenarios: [S-6, S-5]
---

# P5-C3: Group context

## Goal

In a group, the model knows who said what, knows everyone it is talking to, and speaks in a tone that suits all of them (S-6 step 3). In any thread, a relay in a delivery turn is labelled with its sender (I-13), and an invitation reads as one.

## Scope

**In:**
- **Author names** (`mind/messages.ts`): `toLlmMessages(records, opts?)` takes an optional `names: Map<PersonId, string>` and `group: boolean`. In a group thread, each `user` message gets `name` = its author's name, and its content is prefixed with `<name>: ` (D7: not every provider honours `name`; the OpenAI-compatible adapter already maps it). Direct threads stay as they are. An author who is gone (deleted, ADR-0018) doesn't occur, because their messages are deleted too. An unknown id falls back to `Someone`.
- **Section 3 (participants)** (`context-sections.ts`):
  - In a group, every current participant's card (name, tier, tone, notes).
  - The thread's title and `purpose`.
  - One line naming whose message the turn answers (the latest input's author).
  - The tone rule from S-6: "Several people read this thread. Use the most formal tone among the participants unless you are answering one person directly."
  - "People talk to each other here too. Answer only what is addressed to you, and keep it short."
- **Section 8 (deliveries):**
  - A `relay` item reads "(relay from <sender name>) <text>", with an instruction to pass it on in the recipient's thread, saying who it is from.
  - An `invitation` item reads "(invitation from <inviter name>) <content>", with an instruction to ask whether the person wants to join and to call `thread.join` with the id when they agree.
  - The builder looks up author names with `persons.get`. It may add `persons` to `ContextBuilderDeps.repos` if it isn't there already, and P5-I1 wires it.
- **Context builder:** passes names and the thread kind to `toLlmMessages`, and the thread record (title, purpose, kind) to section 3.
- core.md: the context-builder section (sections 3 and 8 in groups, the message names), with the `(P5-C3)` markers removed. (`docs/contracts/providers.md` already documents `LlmMessage.name`; contracts change only in P5-K1.)

**Out:** the turn logic (P5-C2), memory visibility (the builder already passes the full `viewer`; P5-E1 audits the memory side), addressing (P5-D1).

## Acceptance criteria

- [x] `messages.test.ts` (new): in a group, a user row by Pepper becomes `{ role: 'user', name: 'Pepper', content: 'Pepper: …' }`. In a direct thread nothing changes. The existing replay rules (orphan tool rows, incomplete calls) still hold.
- [x] `context-sections.test.ts`:
  - A group with three participants shows three cards, the title, the purpose and the tone rule.
  - A direct thread's section 3 is unchanged.
  - A relay item names its sender, and an invitation item names its inviter and the thread id.
- [x] `context-builder.test.ts`: a group build passes names into the messages. A direct build is byte-for-byte what it was for the same fixture.
- [x] `bun run check` passes.

## Notes

- `ContextBuilderDeps` changes are the one place where this lane may change a constructor that bootstrap calls. Keep the new deps optional or already present, so `bootstrap.ts` still compiles before P5-I1.
- Keep the sections as separate, testable functions (core.md).

## Outcome

No ADR. No `types.ts`, contract or constructor signature changed: `ContextBuilderDeps.repos` already had `persons`, so bootstrap compiles as it is and P5-I1 has nothing new to wire.

**Built**
- **`mind/messages.ts`:** `toLlmMessages(records, opts?: LlmReplayOptions)` with `{ group?: boolean; names?: ReadonlyMap<PersonId, string> }`. In a group, each `user` message becomes `{ role: 'user', name, content: '<name>: <text>' }` (D7). Assistant and tool messages carry no name. New exports `authorName(id, names?)` and `UNKNOWN_AUTHOR` (`'Someone'`, for a null or unresolved author). The replay rules and the `relayFrom` copy in `stripUndefined` are unchanged.
- **`mind/context-sections.ts`:**
  - `participantsSection(cards, group?: GroupContext | null)`. `GroupContext = { title, purpose: string | null, answering: string | null }`. A group always has the `# Participants` heading (even with one participant), then `This is the group thread "<title>".`, `Its purpose: …` (left out when empty), every card, `You are answering <name>'s message.` (left out when `answering` is null), `GROUP_TONE_RULE` (S-6) and `GROUP_ADDRESS_RULE`. Without `group`, the output is exactly what it was.
  - `deliveriesSection(deliveries, kind, skillNames?, names?)`: `relay` and `invitation` items read `(relay from <name>)` / `(invitation from <name>)` (from `authorPersonId`; `Someone` when unknown). One `RELAY_INSTRUCTION` line when any relay is present ("pass it on here, and say who it is from"), one `INVITATION_INSTRUCTION` line when any invitation is present (ask; `thread.join` with the id from the invitation on yes, `thread.leave` on no). Other kinds keep their labels.
- **`mind/context-builder.ts`:** a thread with `kind = 'group'` turns on group mode. `loadNames` starts from the participants' cards and reads the remaining ids (authors of window user rows in a group, authors of relay and invitation deliveries in any thread) with `persons.get`; a missing person is left out and reads as `Someone`. `answering` is the author of the latest user row in the window, only for `user` turns (delivery and briefing turns in a group answer nobody). A direct build does no extra lookups unless it carries relays or invitations.
- **Tests:** new `messages.test.ts` (group names and prefix, direct unchanged with or without names, `Someone` fallback, replay rules in group mode, `authorName`). `context-sections.test.ts`: group section with three cards, title, purpose, answering and both rules; the bare variant; direct unchanged; relay and invitation labels and instructions, unknown author. `context-builder.test.ts`: a direct build compared against a literal captured from the phase-4 builder before any change (byte-for-byte), a relay in a direct delivery turn, and group builds (names in messages including a former participant and a deleted author, section 3, guest-limited tools, delivery turn without `answering`). The local `msg()` helper now applies overrides to user rows too.
- **core.md:** sections 3 and 8 and a new "Author names" paragraph describe the behavior; the `(P5-C3)` Planned note is gone, and the Relays subsection's marker now names only P5-B1 and P5-C2.

**Decisions**
- **A decline calls `thread.leave`.** The task mentions only `thread.join`; D3 and ADR-0017 say `thread.leave` on a pending invitation declines it, so the invitation instruction says both.
- **Whose message:** `ContextBuilder.build` has no input author (frozen `types.ts`), so the builder takes the latest user row in the window (the thread manager appends the input before building).
- **Former participants keep their names** in the replay (looked up with `persons.get`), rather than showing as `Someone`; only a deleted person or a null author does.
- The thread id in an invitation comes from its content (P5-C1 writes it there). Section 8 doesn't parse or repeat it.

**Deviations:** none. `docs/contracts/providers.md` needed no change.

**Notes for other lanes**
- **P5-C2:** pass `viewer.participants` = the group's current participants (the cards come from it). The latest user row must be in storage before `build` for the "answering" line, as today.
- **P5-C1:** keep the thread id in the invitation delivery's `content`; the model reads it from there. The label `(invitation from <inviter>)` comes from `authorPersonId`, so set it to the inviter.
- **P5-B1:** the relay label comes from the delivery's `authorPersonId` (the sender). A `core.md` Relays marker edit may conflict with yours on the same line; keep whichever names are still unbuilt.
- **P5-I1:** no new deps for `createContextBuilder`.
