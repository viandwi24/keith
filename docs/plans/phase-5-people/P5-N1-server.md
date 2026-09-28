---
id: P5-N1
title: "Server: invite sign-up endpoint, live thread list frames, group thread DTOs"
phase: 5
wave: 2
lane: N
status: todo
owner: null
depends: [P5-K1]
owns:
  - packages/core/src/server/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/contracts/protocol.md
  - docs/architecture/nodes.md
  - docs/architecture/core.md
updates:
  - docs/architecture/nodes.md
scenarios: [S-4, S-6]
---

# P5-N1: Server for phase 5

## Goal

A person with an invite link can create their login over the public protocol (I-8). Every node sees group threads appear, change and disappear without reconnecting. `GET /v1/threads` and `thread.updated` describe a group fully (participants, former participants, purpose).

## Scope

**In:**
- **`POST /v1/auth/invite`** (`server/auth.ts`, `http-api.ts`), per protocol.md:
  - Hash the code (SHA-256 hex), `inviteLinks.get`. A missing, used or expired link gets `401 UNAUTHORIZED`, one answer for all three (ADR-0017).
  - Validate the username and password (`keith setup` rules). A username taken by someone else gets `400 INVALID_REQUEST` ("username taken").
  - `markUsed` first (a conditional update, so two requests with one code can't both win), then `setCredentials` with a `Bun.password` hash, then issue a token like `login`, and answer `LoginResponse`.
  - A person who already had a username (a password reset) may keep it or change it. Accepting deletes their existing auth tokens, so old sessions end.
  - The same timing care as `login`: an unknown code still runs one password hash.
- **Live thread list:** the server subscribes to `thread.participant_joined` and `thread.participant_left`.
  - On a join, it sends `thread.updated { thread }` to every connected attended node of every current participant.
  - On a leave, it sends `thread.updated` to the remaining participants' nodes, and `thread.removed { threadId }` to the leaver's nodes. It also detaches the leaver's nodes from the thread (`AttachmentRegistry.detach`), so they get no more frames of it.
  - Implement `AttachmentRegistry.nodesOfPerson` (P5-K1 declared it; the registry learns a node's person in `connect`) and use it for both frames.
- **Thread DTOs:** `toThreadDto` (`server/dto.ts`) and `GET /v1/threads` fill `purpose` and `formerParticipants` for group threads (from `threads.formerParticipants` and `persons`). Direct threads leave both out.
- **Access** stays as it is: `GET /v1/threads/:id/messages` and `thread.open` only for current participants. A former participant gets `404` / `FORBIDDEN`, like anyone else (ADR-0017).
- nodes.md: the invite flow, the live thread-list frames and who gets them, with the `(P5-N1)` markers removed.

**Out:** creating invite links (P5-A1), group membership logic (P5-C1), group turns (P5-C2), clients (P5-F1…F3).

## Acceptance criteria

- [ ] `http.test.ts` (or a new `invite.test.ts`):
  - A valid code creates the credentials and returns a working token (`GET /v1/me`).
  - The same code a second time is `401`, and so are an expired code and an unknown one.
  - A taken username is `400`, and the link stays unused.
  - A password reset through a new link ends the old token.
  - Two concurrent requests with one code: exactly one succeeds.
- [ ] `ws.test.ts`: after `thread.participant_joined`, every node of every participant (including a node that has only its main thread open, and one without `chat.text@1`) gets `thread.updated` with the new participant. After `thread.participant_left`, the leaver's nodes get `thread.removed`, no longer get that thread's frames, and the others get `thread.updated`.
- [ ] `GET /v1/threads` returns a group with `purpose` and `formerParticipants`. A direct thread has neither.
- [ ] `bun run check` passes.

## Notes

- Tests emit the participant events on the bus themselves. The group service (P5-C1) emits them for real, and P5-I1 connects the two.
- The code hash has to match P5-A1's. Export the hash helper from `server/index.ts` if P5-A1 asks for it (R-3), and record it in the Outcome.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
