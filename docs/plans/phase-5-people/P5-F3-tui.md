---
id: P5-F3
title: "TUI: switch threads, show authors and relay marks, sign up with --invite"
phase: 5
wave: 3
lane: F
status: done
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

- [x] `main.test.ts`: `--invite` without a value is an argument error, and `--help` lists it.
- [x] A sign-up with the fake core stores the session and opens Main. An invalid code exits 1 with the sentence.
- [x] `/threads` then `/open 2` opens the group. A pushed `thread.removed` returns to Main with the notice.
- [x] Group lines show their author, and relay lines show "(via Tony)".
- [x] `bun run check` passes.

## Outcome

**Built** (`apps/tui`, imports `@keith/client`, `@keith/protocol` and `@opentui/core` only):
- `main.ts`: `--invite <code>` / `--invite=<code>` (with `--url`). A missing or empty value is an argument error (exit 2); `--invite` with `--logout` too. The usage text lists the flag and the `/threads` / `/open <n>` commands. With `--invite` the stored session is not restored: the sign-up form runs, `auth.acceptInvite` stores the session like a login, and the chat opens Main. `INVITE_INVALID` ends the TUI with exit 1 and prints `INVITE_INVALID_MESSAGE` (the web app's sentence) after the terminal is restored; any other error (e.g. a taken username, `400`) shows the core's message on the form and asks again. `main` takes an optional `createRenderer` dep so tests run it on OpenTUI's test renderer.
- `login-screen.ts`: `signUp` option: title "Keith: sign up with your invite", the password asked twice, `PASSWORD_MIN_CHARS` checked locally (`PASSWORD_TOO_SHORT`), a mismatch asks for both again (`PASSWORDS_DIFFER`). Esc steps back one field.
- `view.ts`: the status bar uses `threadLabel` (`Main`, `Mission · Pepper, Rhodey`). `entryView(entry, state?)`: in a group, other people's user lines are prefixed `Pepper: ` (style `author`), own lines stay `You`; an assistant line with `relayFrom` gets a muted `(via Tony) ` after the Keith prefix. `threadList` / `threadListLines` (Main first, then the groups in `state.threads` order, numbered, the open one marked `•`) and `parseCommand` (`/threads`, `/open <n>`; anything else, other `/…` text included, is a message).
- `ui.ts`: a `/threads` panel above the input, re-rendered on every state update while shown (so it follows `thread.updated` / `thread.removed`). `/open <n>` calls the new `ChatActions.openThread` (`client.openThread`) and hides the panel; a bad number or `/open` without one keeps the draft and says why in the hint line; offline says so. Esc hides the panel first, and cancels the turn only when no panel is shown. The removal notice comes from `@keith/client` (P5-F1), so the TUI adds none.
- Tests: `main.test.ts` (argument parsing, `--help`, and `main` end to end with the fake core: sign-up stores the session and opens Main; invalid code → exit 1 with the sentence and no session file; a taken username re-asks), `ui.test.ts` (`/threads` then `/open 2`, bad `/open`, live list + Esc, `thread.removed` → Main with the notice, group authors, "(via Tony)", sign-up form checks), `view.test.ts` (status label, authors, relay mark, list order, command parsing).
- nodes.md: new section "The TUI (`keith-tui`)" with `--invite` and the thread commands.

**Decisions**
- Thread numbering puts Main first and then the groups by recency, so `1` is always Main. Numbers follow the live list, which is what `/threads` shows at the time.
- The thread list is a toggled panel rather than log lines, because the log is rebuilt from `ChatState` and the client has no API for TUI-local entries; the panel also stays current as the list changes.
- Only `/threads` and `/open` are commands; other slash text still goes to Keith, so nothing a user types to Keith today is swallowed.

**Deviations:** none. No ADR. No `> Planned (phase 5, P5-F3)` marker existed in the docs.

**Follow-ups:** none required. A `/help` command could list the commands in the chat (the hint line and `--help` mention them today).
