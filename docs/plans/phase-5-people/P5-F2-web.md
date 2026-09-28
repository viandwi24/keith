---
id: P5-F2
title: "Web: thread list, group participants, author names, relay marks, invite sign-up page"
phase: 5
wave: 3
lane: F
status: todo
owner: null
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

- [ ] `app.test.tsx` (or new tests): the invite fragment shows the form, a successful sign-up lands in the chat and clears the fragment, and an invalid code shows the message.
- [ ] A pushed `thread.updated` adds the group to the sidebar, selecting it opens it, and a pushed `thread.removed` drops it and returns to Main.
- [ ] In a group, a message from Pepper shows "Pepper". An assistant message with `relayFrom` shows "via Tony".
- [ ] `bun run check` passes (the app's build test included).

## Notes

- Keep the phase-3 voice controls working in any open thread. Voice is per thread, and the focus rules are the core's.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
