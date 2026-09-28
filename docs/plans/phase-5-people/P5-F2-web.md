---
id: P5-F2
title: "Web: thread list, group participants, author names, relay marks, invite sign-up page"
phase: 5
wave: 3
lane: F
status: review
owner: agent-P5-F2
depends: [P5-F1]
owns:
  - plugins/web/app/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0011-client-app-browser-side.md
  - docs/architecture/ui.md
  - docs/architecture/repository.md
updates:
  - docs/architecture/ui.md
scenarios: [S-5, S-6]
---

# P5-F2: Web group UI

## Goal

In the browser, Pepper can sign up from her invite link, see her threads (her main thread and the Mission group), switch between them, see who is in a group and who wrote each message, and see who a relay came from.

## Scope

**In** (`plugins/web/app`, shadcn/ui only, R-19; `@keith/protocol` and `@keith/client` only, ADR-0011):
- **Invite page:** when the URL fragment holds `#invite=<code>`, the app shows a sign-up form (username, password, repeat), calls `acceptInvite`, removes the fragment from the address bar, and continues as after a login. An invalid link shows "This invite link is not valid any more. Ask the owner for a new one."
- **Thread list:** a sidebar (a sheet on narrow screens) from the client's thread list: "Main" first, then groups by recent update, each with its title and participants. Selecting one calls `openThread`. The list updates live (`thread.updated` / `thread.removed`).
- **Group header:** title, purpose, participants' names.
- **Messages:** in a group, each user message shows its author's name (the person's own messages stay right-aligned, as today). An assistant message with `meta.relayFrom` shows "via Tony" (several names joined).
- **Invitation cards** need nothing new: they are delivery UI blocks, and the Join / Decline buttons already send `ui.action`.
- Component tests with the fake core (the existing `app/test` DOM setup).
- ui.md: a short "Group threads in the web app" paragraph.

**Out:** unread counters (D11), creating groups from the UI (the model does it, S-6), leaving from a button (say it to Keith, D3).

## Acceptance criteria

- [x] `app.test.tsx` (or new tests): the invite fragment shows the form, a successful sign-up lands in the chat and clears the fragment, and an invalid code shows the message.
- [x] A pushed `thread.updated` adds the group to the sidebar, selecting it opens it, and a pushed `thread.removed` drops it and returns to Main.
- [x] In a group, a message from Pepper shows "Pepper". An assistant message with `relayFrom` shows "via Tony".
- [x] `bun run check` passes (the app's build test included).

## Notes

- Keep the phase-3 voice controls working in any open thread. Voice is per thread, and the focus rules are the core's.

## Outcome

**Built** (`plugins/web/app`, imports `@keith/protocol` and `@keith/client` only; check-deps passes):
- `lib/invite.ts`: `AddressBar` (injected `hash()` / `clearHash()`, `browserAddressBar()` uses `history.replaceState`) and `inviteFromHash`.
- `components/invite-form.tsx`: username, password (at least `PASSWORD_MIN_CHARS`), repeat. A mismatch is refused locally ("The passwords do not match."); `INVITE_INVALID` goes to the app, any other `ClientError` (e.g. a taken username, 400) shows under the form.
- `components/app.tsx`: new `address` prop. `#invite=<code>` opens the sign-up screen (a stored session is not restored then). Success → `auth.acceptInvite`, fragment cleared, chat. A refused code, or an empty one, shows "This invite link is not valid any more. Ask the owner for a new one." with "Sign in instead" (clears the fragment, back to the normal restore/login path).
- `components/chat/thread-list.tsx`: `orderThreads` (direct thread first, groups keep the client's recency order), `ThreadList` (title + other participants, `aria-current` on the open one, disabled while offline).
- `components/chat/chat-screen.tsx`: sidebar on `md+`, a left `Sheet` behind a "Threads" button on narrow screens (closes on select), `client.openThread` on select, `GroupHeader` (title, purpose, participants), header label via `threadLabel`.
- `components/chat/entries.tsx`: `Byline` (author name via `authorName`, `mine`): in a group, each person message shows its author; own messages right, others left with a secondary bubble. Assistant messages with `relayFrom` get a "via A, B" badge (any thread).
- `components/ui/sheet.tsx`: added with `bunx --bun shadcn@latest add sheet` (base-ui Dialog, no new npm dependency; the CLI's `cn` entry in `app/package.json` and `app/node_modules`/`bun.lock` were removed, as ui.md says).
- Tests: `components/groups.test.tsx` (9: invite success + fragment cleared, password mismatch, invalid code, empty code, pushed group after Main → open → `thread.removed` back to Main with the notice, `thread.updated` refreshes participants, authors and alignment in a group, no author names in Main, "via Pepper" / "via Pepper, Rhodey"); `chat/voice.test.tsx` (1: an open mic survives a switch, the old stream ends, the next `audio.start` names the group).
- ui.md: "Group threads in the web app (phase 5)" section, invite links included.

**Decisions**
- An invite link wins over a stored session: the link is for a new person, possibly on a shared browser.
- The own-message test is `authorPersonId` undefined (a local echo) or equal to the signed-in person.
- Relay badges show in any thread, not only groups (relays land in the main thread, D15).

**Deviations:** the relay test uses senders Pepper/Rhodey instead of "Tony", because the fake core's signed-in person is Tony; the rendering is the same ("via <names>"). No ADR.

**Follow-ups:** none required. `bun run check`: 1812 pass, 3 skip, 0 fail.
