---
id: P5-C3
title: "Group context: author names in LlmMessage.name, every participant's card, relay and invitation labels"
phase: 5
wave: 2
lane: C
status: in-progress
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

- [ ] `messages.test.ts` (new): in a group, a user row by Pepper becomes `{ role: 'user', name: 'Pepper', content: 'Pepper: …' }`. In a direct thread nothing changes. The existing replay rules (orphan tool rows, incomplete calls) still hold.
- [ ] `context-sections.test.ts`:
  - A group with three participants shows three cards, the title, the purpose and the tone rule.
  - A direct thread's section 3 is unchanged.
  - A relay item names its sender, and an invitation item names its inviter and the thread id.
- [ ] `context-builder.test.ts`: a group build passes names into the messages. A direct build is byte-for-byte what it was for the same fixture.
- [ ] `bun run check` passes.

## Notes

- `ContextBuilderDeps` changes are the one place where this lane may change a constructor that bootstrap calls. Keep the new deps optional or already present, so `bootstrap.ts` still compiles before P5-I1.
- Keep the sections as separate, testable functions (core.md).

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
