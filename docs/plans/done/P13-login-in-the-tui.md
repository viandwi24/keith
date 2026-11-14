# P13 — Sign in inside the TUI

Nov 8, 2026 · status: **done Nov 8, 2026** · reverses the "no Ink" choice of docs/specs/tui-design.md 5.13 (ADR-0013)

## Problem

Signing in is a subcommand, not part of the app. `keith login` prints plain text and reads the password
or token from a `packages/cli` readline prompt (`apps/tui/src/commands.tsx`, `login-view.ts`). tui-design
5.13 chose that on purpose ("plain stdout: it fits a pipe and the scrollback, so there is no Ink here").
The result is inconsistent and awkward:

- A new device opens `keith`, sees "logged out", and has to leave the TUI to run another command.
- P12's Home "Sign in" panel cannot sign in: its `enter` exits the app and leaves the command to run in
  the scrollback (`apps/tui/src/cli.tsx`, `onExitMessage`).
- The step-up PIN prompt already lives inside the TUI, but the password does not.
- The password is typed into a different widget, with a different look, outside the app.

## Decision

Signing in is a screen of the TUI. The subcommands stay only as the non-interactive path for scripts.

- `keith` with no usable login (no `client.json`, no local socket, or a credential the core rejected)
  opens on the **Sign in** screen. Home's `Sign in` panel opens the same screen in place. `/login`,
  `/logout` (with a confirmation) and `/whoami` work inside the app.
- `keith login` on a terminal opens the app on the Sign in screen (one implementation). Without a TTY it
  keeps the flags for scripts: `--token` from stdin, `--core`, and the device code printed as text.
  `keith logout` and `keith whoami` stay as they are.
- After a successful sign in the app goes on to Home, with no restart and no second command.

### The screen (design to finish in tui-design.md, new 5.13)

1. **Core address.** Prefilled from `--core`, then `client.json`, then `http://127.0.0.1:7420`. The app
   asks the core (`/health`) and shows its name and version, or the reason it is unreachable. The local
   socket never needs a login: say so when the address is the socket.
2. **Method.** A list of what this core accepts: device code, username and password, token. A method the
   core refuses from this address (the network rule of ADR-0009) is greyed with the reason.
3. **Password.** Username, password (masked, never echoed), `enter` signs in. Wrong credentials show one
   uniform line. A 429 shows a countdown from `Retry-After`. The field is cleared after every submit.
4. **Device code.** The code in spaced letters, the command to approve it on the core machine, a live
   countdown and the polling state, `esc` cancels; expired or denied shows the reason and offers a new code.
5. **Token.** A masked field for scripts-in-hand cases (paste a `keith_s_` credential).
6. **Done.** Who you are (name, role), then the app continues. Failure leaves the form filled except the
   secret.

Colours off (`NO_COLOR`): every state still has text; the layout follows the app's minimum size.

## How (the parts that matter)

- **Logic in `packages/client`** (rule 4: the TUI talks to the core only through it). A pure controller
  `createSignIn({ fetch, core, store })` with explicit states (`address`, `method`, `password`,
  `device`, `token`, `done`, `error`) and the existing helpers (`deviceLogin`, `passwordLogin`,
  `whoami`), so the flow is testable without Ink. The Ink screen only renders it.
- **The app owns its connection.** Today `cli.tsx` builds the client before rendering and passes it to
  `App`; a login screen must replace it at runtime. `App` takes a connection source and a setter
  (a small provider), the feeds and chat sessions rebuild when it changes. This is the largest piece and
  it ships first, with no behavior change.
- **`features/login/`** in the TUI, imported through its `index.ts`; it draws only through `@keith/ui`.
- **Secrets.** Never in argv, env or the scrollback; masked input; cleared after submit; `client.json`
  stays mode 0600 and is written by the existing code path.
- The command `keith login` and the prompts in `packages/cli` stay for the non-TTY path, not duplicated.

## Milestones (one commit each, in order)

1. **Controller in `packages/client`** with tests (every state, the 401, 429 and expired paths).
   **Done:** 1416e76. Plus **M1b, done:** 0c01229, `GET /auth/methods` (core) so the screen can grey a
   method the core refuses from this address; an older core without the route keeps all three.
2. **The app owns its connection** (refactor, tests unchanged, `bun run check` green). **Done:** 15f0933.
3. **The Sign in screen** (`features/login/`), the Home panel opens it, `/login`, `/logout`, `/whoami`;
   tests with the fake core (it gains the auth routes it lacks).
   **M3a, done:** 97a6acf, the screen as a standalone feature (`LoginScreen`, contract in
   `docs/specs/tui-login.md`, 23 tests, not wired). **M3b, done:** 803a1db, the screen is wired (`app-session.tsx`), Home's panel and the chat's logged-out block open it, `/login`, `/logout` (with a confirmation, `LogoutScreen`), `/whoami` (already existed). Wiring recipe from M3a: create the controller when the screen opens
   (`createSignIn({ address: core, socketPath? })`), render
   `<LoginScreen signIn initialCore onCancel onDone columns={layout width} />`, `dispose()` on close;
   in `onDone({ core, person? })` rebuild the client from the `client.json` the controller already saved
   and swap the app's connection (the socket case gives `unix:...` with nothing saved: use the socket
   client); `onCancel` goes back to the previous screen or Home.
4. **CLI:** `keith login` on a TTY opens the screen; flags for scripts; `onExitMessage` for logged out
   goes away. **Done:** 7ef9799. `keith login` opens the screen only when stdin and stdout are terminals and
   no flag asks for the text flow (`--token`, `--password`, `--password-stdin`, `--username`, `--device`,
   `--label`); `--core` alone prefills the address. Everything else is the unchanged text command.
   `keith logout` shares `signOut` with `/logout`. Tests: `login-screen-choice.test.ts` (every invocation) and
   `cli.login.pty.test.ts` (a password sign in inside the app in a pseudo-terminal).
5. **Docs and proof:** `docs/specs/tui.md`, `tui-design.md` (5.13 rewritten), `client.md`,
   `docs/manual-testing.md` (1.5b and 1.5c), ADR-0013, a PTY test that signs in with a password inside
   the app, `bun run check` once, `bun run smoke` once. **Done:** the commit `docs(tui): document signing in
   inside the app` (the one that moves this plan to done; the specs and the PTY test shipped with M4).

## Sequencing and risks

- **P12 first.** P12 (Home and the new chat header) has uncommitted changes in `apps/tui` and
  `packages/ui`, including `cli.tsx`, `app.tsx`, `commands.tsx` and the Home auth panel that this plan
  rewires. Starting P13 before P12 is committed would overwrite or conflict with that work. Start at M1
  (which touches only `packages/client`) at any time; M2 waits for P12.
- **P12 changes `@keith/ui` under the login screen.** The P12 working tree no longer exports `Spinner`,
  `SPINNER_FRAMES` and `SPINNER_MS` from `packages/ui/src/index.ts` (the other primitives the screen
  uses are still there: `Screen`, `Field`, `TextInput`, `ListRow`, `Surface`, `Txt`, `KeyHints`, `G`,
  `GUTTER`). `features/login` imports `Spinner`, so its tests fail to load against that tree (they pass,
  23 of them, on a clean copy of HEAD). When P12 lands, swap `Spinner` for whatever replaces it before
  M3b; re-run `bun test ./apps/tui/src/features/login`.
- **The connection refactor** can break reconnect and feed handling; the resilience tests
  (`resilience.test.tsx`, `server-turn.test.tsx`) are the guard.
- **Password in a TUI** must not leak into frames kept by tests or logs: the test helpers must mask it.

## Gate evidence

Nov 8, 2026, on the tree of 7ef9799 (a clean `git archive` copy: the working tree had an unrelated, uncommitted and
half-edited `apps/tui/src/features/home/home-state.ts` that did not parse, plus `scripts/manual.ts`):

- `bun run check`: exit 0. Biome, tsc on every package, `bun test` (about 1596 pass, 13 skip, 0 fail), check-imports,
  check-entry, check-size (warnings only: commands.tsx 413, cli.pty.test.ts 410, login.test.tsx 409, sign-in.ts 590, among
  older ones) and check-exports ok. An earlier run in the same copy failed `states.test.tsx` (it still asserted the old
  `keith login --core <url>` caption) and was fixed in the same commit; `sign-in-app.test.tsx` "a wrong password" timed out
  once at 5 s under the full parallel run and passed on its own and in the second run (load flake, not masked).
- `bun run smoke`: `SMOKE PASS (15 steps ok, 8245 ms)`, device login and password login over the unchanged text CLI.
- PTY: `cli.login.pty.test.ts` passed (`keith login --core <fake core>` opens the Sign in screen, password method, username and
  password typed inside the app, Home signed in, `logins` = one, the raw bytes never contain the password).
- Not verified: the screen on a real terminal against a real core (covered by Ink render tests, the PTY test with the fake
  core and the manual steps 1.5b and 1.5c).
  The follow-up (`keith`, `keith chat` and `keith manage` with no core found open the Sign in screen on a terminal) was done in
  the commit `feat(tui): open the sign-in screen when no core is found`.

## Out of scope

OAuth or SSO, QR codes for phones, the web UI login, approving device codes from a signed-in owner
client (still on the core machine; a later plan can add it with step-up).
