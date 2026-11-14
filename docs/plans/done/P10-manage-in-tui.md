# P10 — Manage Keith from the TUI

Oct 28, 2026 · status: **done Oct 29, 2026** · builds on P8 (setup, local socket) and P9 (people, capabilities, step-up)

The owner asked for setup, configuration, people and every other management task in a TUI, not
only as `keith-core` subcommands. Every online `keith-core` command already calls the typed API over
the local socket (`client.rpc.admin.*`, `providers.*`, `models.*`, `budget.*`, `nodes.*`), so the
TUI needs no new server logic. Only setup, `db migrate` and `token recover` work offline.

## Decisions

- **One API, two front ends.** The CLI stays as the scriptable surface for headless servers, SSH,
  scripts, smoke and docs. The TUI is a second front end on the same procedures. No logic lives only
  in one of them. ADR-0010 records this.
- **Shared look.** `apps/tui/src/ui` moves to a new package `packages/ui` (`@keith/ui`): theme
  tokens, components and glyphs. `apps/tui` and `apps/core` (setup wizard, launcher) both draw with
  it. Its rules move from apps/tui/AGENTS.md to packages/ui/AGENTS.md.
- **`keith-core` with no arguments on a TTY opens the console** (with `--help` or without a TTY it
  prints help, as today):
  - Not set up: the setup wizard.
  - Set up, core stopped: a home screen with Start (foreground), Doctor (results on screen), Run
    setup again, Quit.
  - Core running: it hands over to `keith manage --core unix:<socket>` (found with `Bun.which`;
    when `keith` is not on PATH it prints the command to run).
- **Setup wizard.** `keith-core setup` on a TTY opens a full-screen wizard with the same steps as the
  line prompts (name, provider and key, models, budget, access, owner PIN), with back and next. The
  flags, `--non-interactive` and piped input keep the current prompt flow. The step logic is split
  out of `cli/setup.ts` so both front ends share it.
- **Management lives in the `keith` client.** `keith manage` and `/manage` in chat open a Manage
  screen with a section list:
  - Overview
  - People (add, rename, role, suspend, reactivate, remove, transfer owner, password, PIN, grants,
    unlock)
  - Devices & tokens (approve, deny, revoke, create token)
  - Nodes (pair, revoke)
  - Providers & models (add with key, test, remove, set the model per role)
  - Access
  - Budget (limit and per-person caps)
  - Audit (read-only list)
- **Role-aware.** A section shows only when `whoami` grants its read capability, and an action only
  with the manage capability. The server still enforces both. The owner over the socket sees
  everything.
- **Step-up.** `KEITH_STEP_UP_REQUIRED` opens the existing PIN dialog and retries once. Provider
  writes must be step-up procedures. If one is not marked, mark it in the contract and spec.
- **Secrets.**
  - API keys, passwords and PINs use hidden inputs and are cleared from state after submit.
  - New tokens and pairing codes appear once, in a dialog that says they are shown once.
- **Destructive actions** (remove a person, revoke, transfer owner) need a confirm dialog. Transfer
  also needs the username typed.

## Work

| Step | What | Done when |
| --- | --- | --- |
| A | Create `packages/ui` and move `apps/tui/src/ui` into it; update imports, check-imports, exports snapshot | TUI tests pass unchanged |
| B | Setup wizard and `keith-core` console launcher in apps/core/src/cli (Ink via `@keith/ui`) | Wizard and launcher tests with a fake TTY, existing setup flag tests unchanged |
| C | Manage screen in apps/tui/src/features/manage/, one folder per section, pure state reducers with tests; `keith manage`; `/manage`; fake core extended (split `fake-core.ts`, already over 400 lines) | Frames for owner and member; actions call the right procedures; step-up retry tested |
| D | Docs: specs tui.md, tui-design.md, core-cli.md, permissions.md if changed, ADR-0010, manual-testing.md, README commands | Specs match code |
| E | Gate: `bun run check`, `bun run smoke` once each | Exit 0, evidence below |

## Out of scope

Editing raw config files from the TUI. Guests and invites. A web UI.

## Gate evidence

Oct 29, 2026, on main after the step C commit:

- `bun run check`: exit 0. 1061 pass, 13 skip (env-gated frames), 0 fail; check-imports ok (484 files,
  11 packages), check-size ok (warnings: apps/tui/src/app.tsx 440, frames.test.ts 444,
  person-store.ts 430, smoke.ts 418), check-exports ok (9 entries).
- `bun run smoke`: `SMOKE PASS (15 steps ok, 29077 ms)`, no processes left.
- `bun audit`: 1 moderate advisory, esbuild ≤0.24.2 under drizzle-kit (dev only, not from P10).
- One race fixed in `manage.test.tsx` (the switcher moves before the section's rows load).
- Not verified: the wizard and the console on a real terminal (covered by Ink render tests and one
  PTY test for `keith manage`); a member granted extra capabilities does not see the matching
  section yet, because `auth.whoami` reports only the role (the server still enforces every call).
  Fixed right after: `auth.whoami` now returns `capabilities` (role table plus grants) and Manage uses it.
