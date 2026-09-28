---
id: P5-F3
title: "TUI: switch threads, show authors and relay marks, sign up with --invite"
phase: 5
wave: 3
lane: F
status: in-progress
owner: agent-P5-F3
depends: [P5-F1]
owns:
  - apps/tui/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0010-tui-framework.md
  - docs/architecture/nodes.md
updates:
  - docs/architecture/nodes.md
scenarios: [S-5, S-6]
---

# P5-F3: TUI group support

## Goal

From the terminal, Rhodey can sign up with his invite code, switch between his main thread and a group, see who wrote each line, and see who a relay came from (I-12: the terminal alone is a full Keith).

## Scope

**In** (`apps/tui`, OpenTUI core API, ADR-0010; `@keith/protocol` and `@keith/client` only):
- `keith-tui --invite <code>` (with `--url`): the login screen asks for a username and a password (twice), calls `acceptInvite`, and stores the session like a login. An invalid code prints the same sentence as the web app and exits 1. The usage text lists the flag.
- **Thread switching:** `/threads` lists the threads numbered (the `threadLabel`s), and `/open <n>` opens one. The status bar shows the open thread's label. The list follows `thread.updated` / `thread.removed`, and a removed open thread falls back to Main with a one-line notice.
- **Authors:** in a group, other people's lines are prefixed with their name ("Pepper: …").
- **Relays:** an assistant line with `meta.relayFrom` is prefixed "(via Tony)".
- Tests with the fake core, in the existing `ui.test.ts` / `view.test.ts` style.
- nodes.md: the TUI's commands and `--invite`.

**Out:** unread counters (D11), creating or leaving groups by command (say it to Keith, D3).

## Acceptance criteria

- [ ] `main.test.ts`: `--invite` without a value is an argument error, and `--help` lists it.
- [ ] A sign-up with the fake core stores the session and opens Main. An invalid code exits 1 with the sentence.
- [ ] `/threads` then `/open 2` opens the group. A pushed `thread.removed` returns to Main with the notice.
- [ ] Group lines show their author, and relay lines show "(via Tony)".
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
