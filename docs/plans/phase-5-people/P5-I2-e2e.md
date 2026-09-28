---
id: P5-I2
title: "S-4 privacy, S-5 relay and S-6 group thread end to end"
phase: 5
wave: 4
lane: I
status: todo
owner: null
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

- [ ] `s4-privacy`, `s5-relay` and `s6-group` each pass 5 runs in a row locally and in CI.
- [ ] The existing e2e files still pass unchanged.
- [ ] scenarios.md S-4, S-5 and S-6 describe the phase-5 tests.
- [ ] The human run is recorded in the Outcome (the coordinator asks the owner, because it needs real people, devices and an API key).
- [ ] `bun run check` passes.

## Human run (owner, real keys, two or three people)

1. `KEITH_HOME=/tmp/keith-p5 keith setup` (with `@keith/web`), set `server.publicUrl` to an address the phones can reach (for example a Tailscale name), then `keith start`.
2. `keith person add Pepper` and `keith person add Rhodey --tier guest`. Open each link on a phone and sign up.
3. **S-4:** Tony tells Keith something private in the TUI. Pepper asks the web app about it. Note whether anything leaked.
4. **S-5:** Tony says "Tell Pepper I'll be late". Check that Pepper's phone shows who it is from. Pepper answers through Keith. Rhodey (guest) tries to relay to Pepper, and should be refused.
5. **S-6:** Tony asks Keith to connect him with Pepper and Rhodey. Both join (one with the button, one by saying yes). Talk to each other for a few lines, then ask Keith something by name, then ask a question without naming it. Note every line where Keith spoke when not addressed, or stayed quiet when addressed (the addressing prompt's real-model check).
6. Rhodey leaves. Then `keith person remove Rhodey` with Keith stopped, and check what `keith person remove` printed against ADR-0018.
7. Record the models used, the addressing misses, and anything that looked like a privacy leak.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
