---
id: P5-I2
title: "S-4 privacy, S-5 relay and S-6 group thread end to end"
phase: 5
wave: 4
lane: I
status: done
owner: agent-P5-I2
depends: [P5-I1, P5-F2, P5-F3]
owns:
  - tests/e2e/**
  - packages/core/**
  - packages/client/**
  - plugins/**
  - apps/**
  - .github/**
reads:
  - docs/concept/scenarios.md
  - docs/concept/model.md
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
updates:
  - docs/concept/scenarios.md
  - docs/plans/roadmap.md
scenarios: [S-4, S-5, S-6]
---

# P5-I2: S-4 privacy, S-5 and S-6 end to end

## Goal

Phase 5's scenarios run in CI on the real core, with nodes talking to it over HTTP and WebSocket: two people keep their privacy (S-4), messages pass between them (S-5), and three people work together in a group thread (S-6, group part). Then a human runs the same with real people and a real model.

## Scope

**In** (the real core, the scripted `fake:chat` and `fake:utility` models, the fake clock, `tests/e2e/harness.ts`; people are added with P5-A1's helpers and sign up through `POST /v1/auth/invite`):
- `tests/e2e/s4-privacy.test.ts`:
  1. Tony (owner), Pepper (member) and Happy (guest) sign up.
  2. Tony says a private fact, and his model writes it with `memory.remember` (`subject`). He also starts a background task.
  3. Pepper and Happy each ask about it in their own threads. No request of theirs (system prompt, messages, tool results) contains the fact or the task goal. Pepper's digest mentions the task as a count only, and Happy's digest is counts only.
  4. Happy's tool list has no `member` tools (`task.*`, `reminder.*`, `thread.start_group`).
  5. The test titles name I-3 and I-4.
- `tests/e2e/s5-relay.test.ts`:
  1. Tony: "Tell Pepper I'll be late." His model calls `relay.send`.
  2. Pepper's attached web-like node (`chat.text@1`, `ui.render@1`) gets an unsolicited message whose `meta.relayFrom` names Tony, and the delivery is marked delivered.
  3. Pepper answers "Tell him no problem", which relays back the same way.
  4. Pepper blocks Rhodey (`relay.block`). Rhodey's relay is refused with the generic text, and Pepper gets nothing.
  5. Happy (guest) → Pepper is refused, and Happy → Tony goes through.
  6. A relay to Pepper while she is away waits and is delivered on her arrival (I-11). The test titles name I-13.
- `tests/e2e/s6-group.test.ts`:
  1. Tony: "Connect me with Pepper and Rhodey, mission thread." The model calls `thread.start_group`. Every node of all three gets `thread.updated`, and Pepper and Rhodey get invitation deliveries.
  2. Pepper clicks Join, and Rhodey says "yes, join" in text. Both become participants.
  3. In the group:
     - Pepper → Rhodey lines reach every attached node with no LLM request.
     - "Keith, what's our status?" runs one turn, whose request has every participant's card, the tone rule and `name`s.
     - An unsure line goes to `fake:utility`.
  4. Tony, in his direct thread while the group is live, asks Keith something privately. His context's digest mentions the group, and the group's nodes see nothing of it.
  5. In the group, Rhodey's model calls `memory.remember`. The memory is `thread`, and it is absent from Pepper's direct thread context.
  6. A task started in the group reports back to the group.
  7. Rhodey leaves: his nodes get `thread.removed`, and the others keep the history and the group's memory (S-6 "Leaving").
- A light browser check in the existing `tests/e2e/browser.ts` style, if the browser harness runs in CI: Pepper's web app shows the group in the sidebar and author names. Skip it with a logged reason when no browser is available, like S-8.
- CI runs each new file 5 times in a row, like S-7, S-8 and S-3.
- Human run instructions (below) and the roadmap's phase-5 status list.

**Out:** new features. Fixes only, recorded per lane in the Outcome.

## Acceptance criteria

- [x] `s4-privacy`, `s5-relay` and `s6-group` each pass 5 runs in a row locally and in CI. (Locally yes; CI runs the loops, not yet observed.)
- [x] The existing e2e files still pass unchanged.
- [x] scenarios.md S-4, S-5 and S-6 describe the phase-5 tests.
- [ ] The human run is recorded in the Outcome (the coordinator asks the owner, because it needs real people, devices and an API key). **Deferred by the owner**; the steps are in the Outcome.
- [x] `bun run check` passes.

## Human run (owner, real keys, two or three people)

1. `KEITH_HOME=/tmp/keith-p5 keith setup` (with `@keith/web`), set `server.publicUrl` to an address the phones can reach (for example a Tailscale name), then `keith start`.
2. `keith person add Pepper` and `keith person add Rhodey --tier guest`. Open each link on a phone and sign up.
3. **S-4:** Tony tells Keith something private in the TUI. Pepper asks the web app about it. Note whether anything leaked.
4. **S-5:** Tony says "Tell Pepper I'll be late". Check that Pepper's phone shows who it is from. Pepper answers through Keith. Rhodey (guest) tries to relay to Pepper, and should be refused.
5. **S-6:** Tony asks Keith to connect him with Pepper and Rhodey. Both join (one with the button, one by saying yes). Talk to each other for a few lines, then ask Keith something by name, then ask a question without naming it. Note every line where Keith spoke when not addressed, or stayed quiet when addressed (the addressing prompt's real-model check).
6. Rhodey leaves. Then `keith person remove Rhodey` with Keith stopped, and check what `keith person remove` printed against ADR-0018.
7. Record the models used, the addressing misses, and anything that looked like a privacy leak.


## Notes from P5-I1 (coordinator)

- Reuse `packages/core/test/people-helpers.ts` ideas in `tests/e2e` (e2e may not import `@keith/core` test files beyond what check-deps allows; copy what you need into the e2e harness): `signUp` = `addPersonForTest` → `POST /v1/auth/invite` → attach a node; `greet` before expecting deliveries (a first `thread.open` is an arrival, `on-greeting` holds deliveries); a routed fake chat model answering by request content, because turns of different people interleave; script `fake:utility` only for group lines the addressing rules can't decide.
- Invitees get no `thread.updated` before they join (P5-N1 sends it only to current participants, per ADR-0017 and D11); their first one comes on join.
- Once under heavy machine load, `keith person add` exited 1 in a P5-I1 test (a 6.4 s run, possibly an SQLite lock wait over the 5 s busy timeout). Not reproduced in 25+ runs. If you see it, investigate rather than retry blindly.
- Human run: deferred by the owner (like phases 1–4). Still write the steps, including checking `ADDRESSING_SYSTEM_PROMPT` against a real utility model and invite links in both the browser and `keith-tui --invite`.

## Outcome

S-4 (privacy), S-5 and S-6 (group part) now run end to end on the real core, with nodes over HTTP and WebSocket, the fake clock, a routed `fake:chat`, and `fake:utility` / `fake:researcher`. Each new file passed 5 runs in a row locally (15 of 15), and the whole `tests/e2e` suite passes (17 tests in 11 files, the phase 1–4 files unchanged). No runtime code changed.

**Built**
- **`tests/e2e/harness.ts`** (additive):
  - `signUp(keith, home, clock, { name, tier?, tone? })`: runs `addPersonForTest` (the `keith person add` code path) on the real home while Keith runs, then `POST /v1/auth/invite` with the code. It returns the person and the invite's session token. `tone` writes the relationship card.
  - `greet` (the "Hi." that ends the on-greeting arrival hold).
  - `routedChat` (P5-I1's routed fake, copied rather than imported from `packages/core/test`). Its built-in greeting route skips requests that carry pending items (`# Things to tell them`), so a greeting that must carry a relay can be scripted.
  - `lastUser`, `afterTool`, `toolResult`, `requestText` (system prompt, messages and tool call arguments), `digestOf` (context section 6's lines) and `settle`.
  - `connectNode`'s options now accept explicit `undefined` (`exactOptionalPropertyTypes`).
- **`tests/e2e/s4-privacy.test.ts`** (title names I-3 and I-4):
  - Tony's model calls `memory.remember` (`subject`, pinned) and `task.start`. The research task is held at its model call, so it stays `running`.
  - Pepper and Happy ask in their own threads, and each of their models tries `memory.recall`. None of their requests (greeting, question, the step after recall) holds the fact, Tony's words, the task goal, the reply or Tony's card. Both recalls answer "No matching memories.".
  - Pepper's digest is exactly `Busy with 1 private background task for someone else.`. Happy's is `Also busy with 0 other conversations and 1 background task.` (counts only).
  - Happy's tools have no `task.*`, `reminder.*`, `thread.start_group` or `thread.invite`, and still have `memory.recall`, `relay.send` and `thread.join`. Pepper's have the member tools.
  - Positive control: Tony's next turn has the pinned fact and "Working on a background task for you: <goal>". When the gate opens, the task's result reaches only Tony's node. Pepper's and Happy's nodes never got a frame with the secret, the goal, the result or Tony's thread id.
- **`tests/e2e/s5-relay.test.ts`** (title names I-13 and I-11):
  - Pepper is on a web-like node (`chat.text@1`, `ui.render@1`).
  - Tony → Pepper arrives as a proactive message with `meta.relayFrom = [Tony]`, and its delivery row is `delivered`, authored by Tony, with that message's id. Pepper → Tony comes back the same way.
  - `relay.block` of Rhodey, then Rhodey → Pepper and Happy (guest) → Pepper both get `RELAY_MESSAGES.notAllowed('Pepper')`. No relay is enqueued, nothing is pending, and Pepper's node gets nothing.
  - Happy → Tony goes through.
  - Pepper goes away (her node closes, waiting for `person.left`, then the clock moves past `awayAfterMinutes`). Tony's relay stays `pending` with no turn. On her return (`person.arrived`), her greeting's reply carries it with `meta.relayFrom`, and it is marked delivered.
- **`tests/e2e/s6-group.test.ts`**:
  - The cast: Tony on two nodes, Pepper (web-like), Rhodey, and Happy (guest, in no group).
  - `thread.start_group`: both of Tony's nodes get `thread.updated`. The invitees get the invitation, and Pepper also gets its card as `ui.render`.
  - Pepper joins with the Join `ui.action`, and Rhodey joins by saying "Yes, join.". All four nodes then get `thread.updated` with three participants.
  - Human-to-human lines echo to every other attached node, with no chat or utility call and no `message.started`.
  - "Keith, what's our status?" (held by a gate) has every card and tone, `GROUP_TONE_RULE`, "You are answering Pepper's message.", the purpose and the `name`d user messages.
  - While the status turn is held, Tony's private question in his direct thread gets a digest with `Replying in your other thread "Mission".`. Pepper's and Rhodey's nodes never see his thread id or the aside, and no group request holds it.
  - An unsure line makes one tool-less `fake:utility` call and no turn.
  - Rhodey's `memory.remember` in the group is `thread` (authored by him).
  - A `task.start` in the group has `thread` visibility, and its report reaches every node as a proactive message. Happy's node never sees the group.
  - The browser check: Pepper signs in to the web app in Chromium. The sidebar lists "Mission" with its participants, and the timeline shows the authors' names (Rhodey, Tony). The test builds the web app and launches Chromium in `beforeAll`, and on failure logs `S-6: the browser check is skipped …` and runs the rest.
  - Rhodey leaves from his main thread. He gets `thread.removed`. Tony's and Pepper's nodes list him in `formerParticipants`, and Pepper's `thread.open` has the whole history. The group's next turn still has the memory and no card for Rhodey. Rhodey's direct context no longer has the memory, and his node gets no more group frames.
- **CI** (`.github/workflows/ci.yml`): three loops, each running one of the new files 5 times in a row, after the S-3 and S-1 reminder loops. The browser the S-6 check needs is already installed by the existing `playwright install` step.
- **Docs:**
  - scenarios.md: a "Test (phase 5, end to end)" paragraph for each of S-4, S-5 and S-6.
  - roadmap.md: a "Phase 5 status (P5-I2)" list.

### Fixes by lane

None needed. No lane's code (storage, people CLI, server, relay, groups, thread manager, context, addressing, visibility, client, web, TUI) needed a change for these scenarios, and every new test passed against `main` as it was. The only edits outside the new files are additive test helpers in `tests/e2e/harness.ts`.

### Decisions and deviations
- **The group memory in Pepper's direct thread (scope step S-6.5).** The scope says Rhodey's group memory is "absent from Pepper's direct thread context". That contradicts the concept and the architecture:
  - scenarios.md S-6 says `thread` memories are "shared with that group's participants and nobody else".
  - I-4 admits a memory when its rule admits every participant of the thread asking.
  - memory.md "In group threads" says a group's `thread` memories show "in the direct thread of each of its current participants".
  - `memory/audit.test.ts` pins that behavior.

  Following the precedence rule (concept > architecture > plans), the test checks what the docs say. The memory is present in Pepper's direct context and absent from the direct context of Happy, who is in no group. After Rhodey leaves, it is also absent from Rhodey's direct context. If the plan's reading was intended, it needs an ADR that changes I-4's reading and memory.md.
- **"Every node of all three gets `thread.updated`" at creation (S-6.1).** As P5-I1 found, P5-N1 sends `thread.updated` only to current participants (ADR-0017, D11). At creation, Tony's two nodes get it. The invitees get the invitation delivery, and their first `thread.updated` comes on join, when every node of all three gets it. The test asserts both.
- **S-6 "Leaving" wording.** scenarios.md says a leaver "keeps the history up to that point". ADR-0017 (accepted) says a leaver loses access, and the group keeps everything. The test follows the ADR, like P5-I1: Rhodey gets `thread.removed`, and the others keep the history and the memory. The concept wording is not changed here. It is a follow-up for the coordinator (an S-6 wording fix, or a later ADR for a read-only view).
- **The browser check** runs in the S-6 test itself, before Rhodey leaves, so the sidebar shows a live group with three authors. It is not a separate file. It is skipped with a logged reason only when the web build or Chromium launch fails.
- **The digest for a busy group** needs the group to be mid-turn, because the digest lists busy threads only. A gate on the status call holds the group turn while Tony asks privately.
- `routedChat` is copied into the e2e harness (the P5-I1 note). `addPersonForTest` is imported from `packages/core/src/cli/person-testing.ts`, which `check-deps` allows from `tests/e2e`.
- The P5-I1 note about `keith person add` exiting 1 under load did not recur. Every `signUp` in the 15 runs plus the suite runs succeeded.

### Human run

**Deferred by the owner** (like phases 1–4), and its acceptance box is left unticked. Steps for the owner (real people, devices and a real API key):
1. `KEITH_HOME=/tmp/keith-p5 keith setup` (with `@keith/web`). Set `server.publicUrl` to an address the phones can reach (for example a Tailscale name), then run `keith start`.
2. Run `keith person add Pepper` and `keith person add Rhodey --tier guest`. Open each link on a phone and sign up in the browser. Also try one link with `keith-tui --url <url> --invite <code>`. A used or expired link should show "This invite link is not valid any more…".
3. **S-4:** Tony tells Keith something private in the TUI. Pepper asks the web app about it. Note whether anything leaked, in the answer or in "what are you busy with".
4. **S-5:** Tony says "Tell Pepper I'll be late". Check that Pepper's phone shows who it is from (the "via Tony" badge). Pepper answers through Keith. Rhodey (guest) tries to relay to Pepper, and should get the generic refusal.
5. **S-6:** Tony asks Keith to connect him with Pepper and Rhodey. Both join, one with the button and one by saying yes.
   - Talk to each other for a few lines, then ask Keith something by name, then ask a question without naming it.
   - Note every line where Keith spoke when not addressed, or stayed quiet when addressed. This checks `ADDRESSING_SYSTEM_PROMPT` against the real `utility` model, including the ambiguous lines of `mind/addressing/corpus.ts`.
6. Rhodey leaves. Then, with Keith stopped, run `keith person remove Rhodey` and check what it printed against ADR-0018.
7. Record the models used, the addressing misses, and anything that looked like a privacy leak.

### Follow-ups
- The coordinator should decide on S-6 wording ("keeps the history up to that point" vs ADR-0017) and on the plan's reading of S-6.5 (above).
- Observe the three new CI loops on the first push. They were not observed here (no CI run from this worktree).
