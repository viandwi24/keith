---
id: P5-N1
title: "Server: invite sign-up endpoint, live thread list frames, group thread DTOs"
phase: 5
wave: 2
lane: N
status: review
owner: agent-P5-N1
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

- [x] `http.test.ts` (or a new `invite.test.ts`):
  - A valid code creates the credentials and returns a working token (`GET /v1/me`).
  - The same code a second time is `401`, and so are an expired code and an unknown one.
  - A taken username is `400`, and the link stays unused.
  - A password reset through a new link ends the old token.
  - Two concurrent requests with one code: exactly one succeeds.
- [x] `ws.test.ts`: after `thread.participant_joined`, every node of every participant (including a node that has only its main thread open, and one without `chat.text@1`) gets `thread.updated` with the new participant. After `thread.participant_left`, the leaver's nodes get `thread.removed`, no longer get that thread's frames, and the others get `thread.updated`.
- [x] `GET /v1/threads` returns a group with `purpose` and `formerParticipants`. A direct thread has neither.
- [x] `bun run check` passes.

## Notes

- Tests emit the participant events on the bus themselves. The group service (P5-C1) emits them for real, and P5-I1 connects the two.
- The code hash has to match P5-A1's. Export the hash helper from `server/index.ts` if P5-A1 asks for it (R-3), and record it in the Outcome.

## Outcome

Everything in scope is built and tested. The task was briefly blocked: no storage member could delete a person's auth tokens, so accepting an invite could not end old sessions. The coordinator resolved it on main (6a7d292, `AuthTokensRepository.deleteForPerson`); after the rebase `acceptInvite` calls it.

**Built**
- **`POST /v1/auth/invite`** (`server/auth.ts` `Auth.acceptInvite`, route in `http-api.ts`):
  - The body is parsed with `InviteAcceptRequest` (a bad body or a password shorter than `PASSWORD_MIN_CHARS` is `400`).
  - The password is hashed first (`Bun.password.hash`), so an unknown code costs one hash like a right one.
  - The code hash is `hashToken(code)` (SHA-256 hex of the UTF-8 code, the auth-token helper). A missing, used or expired link, or one whose person no longer exists, is `401 UNAUTHORIZED` "invalid or expired invite code", one answer for all.
  - The username is trimmed and must not be empty (`keith setup` rule). A username another person has is `400 INVALID_REQUEST` "username taken" and the link stays unused. The person's own username may be kept or changed.
  - `inviteLinks.markUsed` (conditional) comes before `persons.setCredentials`; the loser of a race gets `401`. If `setCredentials` throws (another invite took the username between the check and the write, the unique index), the answer is `400` "username taken" (the link is then used; see Follow-ups).
  - Then `authTokens.deleteForPerson` ends the person's old sessions, and a new token is issued by the same helper as `login`; the answer is `LoginResponse`.
- **Live thread list** (new `server/thread-list.ts`, subscribed in `createCoreServer`):
  - `thread.participant_joined` → `thread.updated { thread }` to every node of every current participant.
  - `thread.participant_left` → for each of the leaver's nodes: detach from the thread (`AttachmentRegistry.detach` and `ThreadManager.detach`), `presence.nodeDetached` if it has no thread open any more, then `thread.removed { threadId }`; afterwards `thread.updated` to the remaining participants' nodes.
  - An event for an unknown thread logs a warning and sends nothing; handler errors are logged.
- **`AttachmentRegistry.nodesOfPerson`** (`attachments.ts`): `ServerAttachmentRegistry.connect` takes the node's `personId` (4th argument, server-private), and a new server-private `markReady(nodeId)` that the connection calls right after `welcome`. `nodesOfPerson` lists only ready nodes, in connect order, so no thread-list frame reaches a node before its `welcome`.
- **Thread DTOs:** `toThreadDto(t, participants, state, formerParticipants = [])` adds `purpose` (when set) and `formerParticipants` (always, possibly empty) for groups, neither for direct threads. `createThreadDescriber` (thread-list.ts) builds a DTO from a record (current + former participants, persons cached per request) and is used by both `GET /v1/threads` and the frames.
- **Access** is unchanged; a test checks a former participant no longer lists the group and gets `404` on its messages.
- **Tests:** new `invite.test.ts` (valid code + `/v1/me`, used/expired/unknown/malformed = 401, taken username = 400 with the link unused, invalid body = 400, reset keeps or changes the username, three concurrent requests = one 200, unknown code runs exactly one hash, a reset through a new link ends the old token). `ws.test.ts` "thread list (phase 5)": join/leave frames to a main-thread-only node, a node without `chat.text@1`, the leaver and a new participant; detach, presence and no further frames for the leaver; unknown thread. `http.test.ts`: group DTO fields and former-participant access. `dto.test.ts` and `attachments.test.ts`: unit tests. `test-fakes.ts` gains an in-memory `inviteLinks` repository, and the fake `setCredentials` throws on a taken username like the real unique index.
- **Docs:** nodes.md "Adding people" describes the endpoint step by step (no Planned marker left; P5-A1's commands were merged meanwhile); "Thread list (phase 5)" lost its marker and says who gets which frame, `markReady` and presence.

**Decisions**
- The code hash reuses `hashToken` (same function P5-A1 needs: SHA-256 hex of the UTF-8 code). It isn't exported from `server/index.ts`, because P5-A1 didn't ask; if it wants it, export `hashToken` there (R-3).
- `nodesOfPerson` waits for `welcome` (`markReady`), not just `connect`: `connect` happens before the handshake's awaits, and a frame through the registry in that window would reach the node before `welcome`.
- On leave, the leaver's nodes are also detached from the thread manager and presence, exactly as after `thread.close`.
- The subscription lives as long as the server object (it is not removed in `stop()`); the bus is per process.

**Deviations**
- Blocked for a while on the missing `deleteForPerson` (outside `owns`); resolved by the coordinator on main, not by this task.
- core.md's "Group threads" section still says "(P5-N1)" for the frames inside a section-wide Planned note owned by other lanes; core.md isn't in this task's `updates`, so it is left for P5-I1.

**Follow-ups**
- If `setCredentials` fails after `markUsed` (a username race between two different links), the link is spent and the person needs a new one. No storage member can un-use a link; this is rare and harmless.

**Notes for other lanes**
- **P5-S1:** `setCredentials` must throw on a username another person has (the server maps it to `400`).
- **P5-C1:** emit `thread.participant_joined` for every initial participant when a group is created (the server only reacts to events), and emit after the storage write, since the server reads participants from storage when it builds the DTO.
- **P5-F1:** `thread.updated` for a group always carries `formerParticipants` (possibly `[]`) and carries `purpose` only when set.
- **P5-A1:** codes must be hashed as SHA-256 hex of the UTF-8 code (`new Bun.CryptoHasher('sha256').update(code).digest('hex')`).
- **P5-I1:** no bootstrap change needed; `createCoreServer` already gets the full `repos` (it now uses `inviteLinks`) and `events`.

