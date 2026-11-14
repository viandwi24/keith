# 0010. Manage Keith from the terminal UI

Status: Accepted (2026-10-29)

## Context

The owner wants setup, configuration, people and every other management task in a terminal UI, not
only as `keith-core` subcommands. Every online `keith-core` command already calls the typed API over
the owner socket (`client.rpc.admin.*`, `providers.*`, `models.*`, `budget.*`, `nodes.*`), so a UI
needs no new server logic. Only `setup`, `db migrate` and `token recover` work offline, with core
stopped. The CLI must stay usable on a headless server, over SSH, in scripts, in the smoke run and in
the docs.

## Decision

- **One API, two front ends.** The CLI stays the scriptable surface. The TUI is a second front end on
  the same procedures. No management logic lives in only one of them; a new capability is one
  procedure, one CLI command and one screen action.
- **Shared look.** The Ink components, theme tokens and glyphs live in `packages/ui` (`@keith/ui`);
  `apps/tui` and `apps/core` both draw with it and nobody passes a colour outside it.
- **The wizard is offline and lives in core.** `keith-core setup` on a terminal opens a full-screen
  wizard in `apps/core`, because setup runs with core stopped, under the offline lock, before any
  socket or client exists. Its step logic is split from the line-prompt flow (`cli/setup-steps.ts`),
  so both save the same settings. It writes nothing until the summary is confirmed.
- **Management is online and lives in the `keith` client.** `keith manage` (and `/manage` in chat) is a
  screen of the `keith` TUI that talks to core only through `packages/client`, role-aware by
  `whoami` capabilities and with the existing step-up dialog. It does not import apps/core.
- **`keith-core` with no arguments is a launcher, not a second manager.** On a terminal it opens the
  wizard when Keith is not set up, a home screen (start, doctor, setup again) when core is stopped, and
  hands over to `keith manage --core unix:<socket>` when core runs. Piped or with `--help` it prints
  help as before.
- **Secrets stay out of rendered state.** API keys, passwords and PINs use hidden inputs, are held in
  refs, emptied after submit and cleared after use; new tokens and pairing codes are shown once.

## Consequences

- Terminal management needs no server change and no duplicated rules; the CLI and the TUI cannot drift
  on what an action does, only on how it is asked.
- `apps/core` now depends on `ink`, `react` and `@keith/ui` (the same versions as `apps/tui`, from the
  catalog). Console options (`KEITH_THEME`, `NO_COLOR`, `COLORTERM`, `TERM`, `COLORFGBG`) are read in
  `apps/core/src/platform/config.ts` only.
- The console hands over to `keith`, so `keith` must be on PATH (`bun run link`); when it is not, the
  launcher prints the command to run.
- Revisit for a web UI (it would be a third front end on the same API) and when the wizard needs steps
  that only the online API can do.
