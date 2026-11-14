# 0013. Sign in inside the terminal UI

Status: Accepted (2026-11-08)

## Context

In P8 the TUI chose plain stdout for `keith login` (tui-design 5.13: "it fits a pipe and the scrollback, so there is no Ink
here"). That left signing in outside the app. A new device opened `keith`, saw "logged out" and had to leave to run another
command. Home's `Sign in` panel could not sign in: its `enter` quit the app and printed the command to run. The step-up PIN prompt
already lived inside the TUI while the password lived in a different widget with a different look. The decision was written in a
design section, not in an ADR, and ADR-0008 (device login) and ADR-0009 (roles, step-up) say nothing about plain stdout, so no ADR
is reversed.

## Decision

- **Signing in is a screen of the TUI.** `keith` with a rejected or missing credential, Home's `enter`, the chat's logged-out block,
  `/login` and `keith login` on a terminal open the same Sign in screen (`features/login`). `/logout` (with a confirmation) and
  `/whoami` work inside the app. After a sign in the app continues to Home with no restart and no second command.
- **The subcommands stay only for scripts.** `keith login` runs its text flow when stdin or stdout is not a terminal or when a flag
  asks for it (`--token`, `--password`, `--password-stdin`, `--username`, `--device`, `--label`). `keith logout` and `keith whoami`
  stay plain commands. Outputs, exit codes and the 0600 `client.json` of those paths do not change (the smoke run drives them).
- **Secrets stay out of argv, env and the scrollback.** Passwords and tokens are typed into masked fields inside the app, cleared
  after every submit, and are in no state, frame or log.

## Consequences

- **The app owns its connection.** `AppRoot` holds the current `Connection` and renders `App` keyed by a generation; a sign in or
  out swaps the connection and remounts the whole tree, so feeds, sessions and polls of the old client stop with it. Anything that
  keeps a client across a swap is a bug.
- **One implementation of the flow.** The sign-in controller (`createSignIn`) lives in `packages/client`, pure and testable
  without Ink, and the screen only renders it (rule 4: the TUI reaches the core only through the client package). The text
  commands keep `deviceLogin` and `passwordLogin`, which the controller also uses. `signOut` (`sign-out.ts`) is shared by
  `keith logout` and `/logout`.
- **The core says what it accepts.** `GET /auth/methods` lets the screen mute a method the core refuses from this address (the
  network rule of ADR-0009); an older core without the route keeps all three methods.
- **Texts change with the place.** Inside the app the logged-out and core-down states point to `/login` and `enter`; the texts of the
  plain commands and of a missing config without a terminal (`No core found ... keith login --core <url>`) stay, because they are right for a script; on a terminal `keith`, `keith chat` and `keith manage` with no core open the Sign in screen instead.
- Supersedes the "no Ink, plain stdout" rule of tui-design 5.13 (rewritten in the same change). Revisit when a web UI needs its own
  sign in: it should reuse the controller, not the screen.
