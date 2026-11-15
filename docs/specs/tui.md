# TUI

Code: `apps/tui/src` (`cli.tsx`, `commands.tsx`, `login-view.ts` (the text of the script path), `sign-out.ts`, `connection.ts`, `messages.ts`, `app.tsx`,
`layout.ts`, `sidebar.tsx`, `home-host.tsx`, `app-hints.ts`, `app-commands.ts`, `help-screen.tsx`, `app-framed.tsx`, `activity-strip.tsx`,
`features/{home,chat,brain,tasks,nodes,approvals,activity,identity,budget,stepup,manage}`). How it looks is in `tui-design.md`
(tokens, glyphs, layout, every component); this file says what each screen does and where its data comes from. The TUI reaches the core only through
`@keith/client` (`client.md`); types come from `@keith/contracts`. It is a thin client: settings (providers,
models, the budget limit, pairing, node revoke) live on the core machine in `keith-core` (`core-cli.md`); the Manage
screen (below) is a second front end on the same procedures, so the owner can also do all of it from the TUI.

## The `keith` command

`cli.tsx` (bin `keith`, `#!/usr/bin/env bun`; `bun run start [args]` runs the same file) is a `@keith/cli` program
(`cli.md`) built in `commands.tsx` (`keithCommands(deps)`: every side effect, such as opening the chat, the config
path and the socket probe, is a dependency, so tests run it with `fakeIo`).

| Command | What it does |
| --- | --- |
| `keith [--core <url>] [--disable-orb]` (`home`, the default) | Resolve the connection (below) and open the TUI on the Home screen (`start: 'home'`; see Home). With none found (no `--core`, no remembered `client.json`, no local socket) on a terminal (stdin AND stdout are TTYs): opens the app on the Sign in screen (`start: 'login'`) prefilled with `http://localhost:7420`, like `keith login`; `esc` there goes to Home, where a signed-out core shows the login panel, as for `keith login`. Without a terminal (script, pipe): `No core found. On the core machine run 'keith-core start'; from another device run 'keith login --core <url>'.`, exit 1 `--disable-orb` keeps the orb still (one fixed picture, colour only; no flight between Home and the chat), see Motion below. |
| `keith --guest [--core <url>]` | Anonymous guest chat (`guests.md`, ADR-0017): **no login, no `client.json`, no local socket**, nothing written to disk. `--core` is the **guest listener** (`http://192.168.1.20:7421`; an `http:` address with no port means port 7421; `unix:` or a non-http address is a usage error); with no `--core` it is `http://127.0.0.1:7421`. Opens the Guest screen below (`guest-main.tsx`, loaded only for this flag). Without a terminal: `guest chat needs a terminal`, exit 1 |
| `keith chat [--core <url>] [--disable-orb]` | Same connection rules (and the same Sign in screen when none is found); opens the app straight on the chat (`start: 'chat'`) `--disable-orb` as for `keith`. |
| `keith manage [--core <url>]` | Same connection rules as chat (including the Sign in screen when none is found); opens the app on the Manage screen with no chat (`start: 'manage'`): no chat session is opened and `Esc` at the top level quits. See Manage |
| `keith login [--core <url>] [--password [--username <name>] [--remember]] [--password-stdin] [--device] [--token] [--label <name>]` | **Opens the app on the Sign in screen** (`start: 'login'`, the same screen as `/login`, `tui-login.md`) when stdin AND stdout are terminals and no flag asks for the text flow: `keith login` and `keith login --core <url>` only. The address is prefilled from `--core`, else the stored `client.json` core, else `http://localhost:7420` (the app never signs in with a saved login that was not remembered, so `esc` goes back to a signed-out Home); `--core unix:<path>` is a usage error (the socket needs no login). After a successful sign in the app continues to Home. **Every other invocation is the text command** for scripts, unchanged: any of `--token`, `--password`, `--password-stdin`, `--username`, `--remember`, `--device`, `--label` (a method, a secret source or a device name only the text flow uses), or stdin or stdout that is not a terminal (a pipe, CI, a redirect). The text command stores the credential in `client.json` (0600) and revokes the login it replaces (`replaceClientConfig`; a failed revoke prints `could not revoke the previous login on <core>: keith-core devices revoke <id>` on stderr, and the new login is kept). With no method flag and no screen (a pipe) it is the device code; with only `--label` on a terminal it asks `How do you want to log in?` (select: `Password` or `Device code`, default Password). `--password` (or `--username`, `--password-stdin`) asks for the username (unless `--username`) and the password (hidden prompt, or one line of piped stdin) and calls `passwordLogin`; success prints `✓ Logged in to <url> as <username> (<role>).` and then `Run keith to start.` when `--remember` was given, else `Saved for scripts and \`keith whoami\`; \`keith login\` without a flag keeps a login for the app.` (username and role from one `auth.whoami`, 3 s at most). `--remember` keeps this device signed in for 30 days idle, as the app's "remember this device" does: the login goes through the flow route with `remember: true` and the file holds `remember: true`; a core without that route (an older core) refuses with `✕ core cannot keep this device signed in: log in without --remember (or with keith login, the app).`, exit 1, nothing saved. Only the password login can be remembered: `--remember` with `--device` or `--token` is a usage error (exit 2) that says so, since the core gives no remember lifetime to a device code or a pasted credential Failures, exit 1 and nothing saved: `✕ Wrong username or password.` (the core never says which), `✕ Too many attempts. Try again in N s.`, `✕ Password login is only allowed from this machine, Tailscale, or tailscale serve. Use a device code instead.`, `✕ The core is busy. Try again in a moment.`. `--device` (or the choice) is the device login (`client.md`): prints the waiting screen (`keith login  ·  <url>`, `On the core machine, approve this device:`, `keith-core devices approve XXXX-XXXX --label <name>`, the spaced code, `waiting for approval · expires in 10 minutes · esc to cancel`) and waits; Esc, Ctrl+C or SIGTERM cancels (`Cancelled.`, exit 130, nothing saved); on approval it prints `✓ Logged in to <url> as <person> (device "<label>").` and the script line (a device login is never remembered). An expired code prints `✕ The code expired. Run keith login again.` (exit 1). More than one of `--password`, `--device`, `--token` is a usage error (exit 2). `--core` defaults to `http://localhost:7420` and must be http(s); `--label` defaults to the host name. The text is plain stdout, no Ink (`login-view.ts`; `tui-design.md` 5.13) |
| `keith login --token [--core <url>]` | Reads a token from a hidden prompt or piped stdin (never echoed, never an argument), checks it through `auth.whoami` and only then saves it, for scripts. A 401 refuses (`<core> did not accept that credential; nothing was saved`, exit 1, the old `client.json` stays); an unreachable core refuses too unless `--no-check` is given. The success line names the person |
| `keith logout` | The same sign out as the app's `/logout` (`signOut`, `sign-out.ts`): `revokeSelf()` with the stored credential, then deletes `client.json` and prints `✓ Logged out of <url>. This device's credential is revoked.`. A core that cannot be reached still loses the local token: stderr gets one warning, `Logged out on this device; the core could not be reached, so the credential is still valid there: keith-core devices revoke <id>.`, and stdout names no revoke at all (exit 0); a 401 (already revoked) is fine; no file prints `Not logged in.` |
| `keith lock` / `keith unlock` | Lock the local socket now (`POST /auth/local/lock`), or open it with the owner's PIN (hidden prompt or one piped line; `POST /auth/local/unlock`). They talk to the socket of the default data dir (`lock-commands.ts`), never to a TCP core. `lock` with local trust `none` (the default): `The local socket needs a session ... there is no implicit owner to lock` (end a session with `/logout` or by closing `keith`); `lock` without a PIN set: `No PIN is set: the lock needs one. Set one with 'keith-core people pin <you>'`. `unlock` with a wrong PIN: `Wrong PIN.` (exit 1); no core on the socket: `No core answers on the local socket...` |
| `keith whoami [--core <url>]` | `auth.whoami`: `person`, `core` (URL or `unix:<path>`), `via` (`local`/`tcp`), `credential` (`device`, `token`, `legacy` or `none (local socket)`). A 401 prints `Logged out or revoked. Run 'keith login'.` (a script's text; inside the app the same state points to `/login`) |

## Guest mode

`features/guest/` (`GuestScreen`, `useGuestChat`, `GuestEntry`), reached by `keith --guest` or by the "continue as an anonymous guest" row of the signed-out sign-in panel. A visitor has no account: the screen never touches `client.json`, the socket or an owner route, and it reaches the core only through `createGuestClient` (`client.md`, "Guest client").

**Screen.** A `ScreenFrame` labelled `Guest`: the banner on top (`GUEST_BANNER`: anonymous, read-only, not stored by Keith, **the owner can watch a live session**, the model provider receives the messages), a muted line `19 of 20 messages left  ·  ends in 1 h 58 min` (the core's count from `x-keith-guest-turns-left`; the expiry is the session's absolute limit, ticking every 15 s), the conversation (the chat's `MessageList`, with its own empty text: "Ask about the owner's public notes."), the input (the chat's `InputBand`, placeholder `ask about the public notes`) and the legend `[enter] send  [esc] end chat`. A warning notice `The owner is watching this live chat.` appears once the core sets `x-keith-guest-watched`. There is no sidebar, no tasks, nodes, budget, brain trace, manage, approval dialog or login.

**Keys and commands.** `enter` sends one message (a message is one text part up to 2048 characters; the input is busy while a turn runs). `esc` and `ctrl+c` end the chat: `DELETE /guest/sessions/:id` first, then the screen leaves (`keith --guest` exits; from the sign-in panel the app comes back). Slash commands: only `/help` and `/quit`; any other `/...` is refused locally with `That command is not available in guest chat. Try /help.` and never sent. The hint row offers only those two.

**States** (`GuestPhase`): `opening` (a pulse and `starting a chat ...`), `ready`, `refused` (no session could start: one sentence from `guestFailureText`; `enter` tries again for `busy`, `cap`, `rate-limited`, `unreachable` and `unavailable`, else it leaves) and `ended` (`410`/`401` during a send, or the last allowed message: the input is replaced by the sentence, `enter` leaves). Sentences: disabled `Guest chat is not available.`; zone `... not available from your network.`; rate limit `Too many chats were started from your address. Try again later.`; busy `Guest chat is busy right now. Try again in a little while.`; cap `Guest chat has reached its limit for now. Try again later.`; and one per end reason (`closed`, `idle`, `absolute`, `turn-cap`, `cost-cap`, `killed`, `restart`: `GUEST_END_TEXT`). The last allowed message ends the chat on screen at once, and the client does not send DELETE: the core ends the session after its grace with reason `turn-cap`, so the audit row says so (the screen says `This chat reached its message limit.` and ends the session itself) instead of waiting for the next `410`. A failed send that leaves the chat usable (`409` a turn is still running, a network blip) shows one error notice and the empty assistant message is dropped.

**Nothing is kept.** The conversation lives in React state of the screen; leaving, `ctrl+c` or a crash drops it. The hook ends the session at the core on unmount too (best effort; the core's idle sweeper is the backstop), and `keith --guest` also ends it after Ink exits.

**Home entry.** A signed-out Home on an http core asks `GET <host>:7421/guest/status` once when the panel mounts (the default guest port of the same host; a core with another guest port shows no row, because a signed-out client cannot ask which). Only when the answer is `enabled` and `available` does the panel show `or continue as an anonymous guest  ·  [ctrl+g]` under it, and only then does `ctrl+g` take it (the identifier box owns the plain keys; `TextInput` ignores ctrl combinations). Any failure, a 404, a timeout (2.5 s) or `available: false` shows nothing at all. `AppRoot` swaps the app for the guest screen (`enterGuest`); leaving gives back a fresh Home. The signed-in Home and the chat never mention guest mode.

Tests: `features/guest/guest-screen.test.tsx` (banner and counters, no account panels, send and stream, the slash rule, `esc` ends with a DELETE, the last message, a 410 reason, the watched notice, every refusal of `open`), `guest-text.test.ts`, `home-guest.test.tsx` (the row, `ctrl+g`, `esc` back; absent for not available, disabled and no listener; none when signed in), `guest-command.test.ts` (`--guest` address rules, no login read or written, no socket), and the real-pty `cli.guest.pty.test.ts` (`keith --guest` against a fake core whose credentials are all refused: chat, `ctrl+c`, the DELETE arrived, no non-guest route touched, the bearer never on the terminal). The fake core serves `/guest/*` with `guest: {...}` (`testing/fake-guest.ts`).


## Connection

`resolveConnection` (`connection.ts`) picks, in order: (1) the `--core` flag, `unix:<path>` or an http(s) URL (a URL
reuses the stored token when `client.json` names the same core); (2) `client.json` `{ core, token }`; (3) the local
socket of the default core data dir, only when something answers on it (`probeSocket`). The socket path is
`localSocketPath(dataDir)` of `@keith/client` (the rule of `socketPathFor` in apps/core: `<dataDir>/core.sock`, or
the path core recorded in `<dataDir>/core.sock.path`, or `$TMPDIR/keith-<hash>.sock` for a long path). The data dir is
`KEITH_DATA_DIR`, else `<KEITH_HOME>/data`, else `<repo>/data`. Over the socket the client is
`createKeithClient({ baseUrl: 'http://localhost', fetch: socketFetch(path) })` with no token (the socket serves the
owner): chat streams, the feed and rpc all go through the socket. When the owner's `local trust` is `none` the socket needs a session:
the `socket` connection then carries a `token` **in memory only** (set by the app after Home's panel signs in through the socket, `tui-login.md`; never read from
or written to disk, so each `keith` start signs in again); a login the person kept still wins over the socket, and the socket's session never replaces it. `clientFor(connection)` builds the client.

**Every start signs in (ADR-0014 amendment of 2026-11-09, second part).** Several people use one machine and one OS account, so a login saved in
`client.json` is never used silently by the app on a terminal. `resolveConnection({ interactive: true })` (what `keith`, `home`, `chat`, `manage` and
`login` pass when stdin and stdout are terminals) treats a saved login as usable only when it carries `remember: true`, the mark of a sign-in made with
"remember this device" (`isRemembered`, `client.md`). Order for the app: (1) `--core` (an http core gets a token only from a remembered login of that core;
a `unix:` path never has one); (2) a remembered `client.json`; (3) the local socket (needs a session under trust `none`: the sign-in panel);
(4) nothing found: the Sign in screen on the stored core or `http://localhost:7420`. A saved login without the mark (a `keith login`, a token, a
file of an earlier version) is skipped: the app opens signed out and the sign-in panel or screen shows one compact box saying an old saved login is not used (`ctrl+f` forgets it) with one action, `ctrl+f`, to forget it (revoke it on the core if it answers within 3 s, then delete the file); the start itself deletes
nothing, because a script or a remote device may use it. **Commands and scripts are unchanged**: `keith whoami`, `keith logout`, `keith-node`, any run with
stdin or stdout not a terminal, and `--core` through `connectionOf` without `interactive` use any saved login exactly as before. A sign-in made in the
panel is kept **in memory only** (`session-vault.ts`; the app swaps to it through `signedInConnection`, source `session`) unless the person ticked
"remember this device" (`ctrl+r`, default off, `tui-login.md`), which asks the core for a 30-days-idle session and writes `client.json` with `remember: true`.
A sign-in that is not remembered also ends with the process: on a clean quit (`/quit`, `/exit`, ctrl+c; `quit-revoke.ts`, `AppRoot` unmount) the app calls `auth.logout` for it, best effort with a 2 s cap, so `keith-core sessions list` does not fill with dead sessions; a remembered credential (the one `client.json` holds) and a `--core` or file credential are never revoked this way; the server also caps such a session at 12 h idle and 7 days (`auth.md`, Sessions). `/logout` revokes the credential, drops the in-memory sign-in and deletes `client.json` only when it holds that same credential (a remembered
one); a different saved login stays.

Config: `platform/config.ts` is the only reader of the environment (zod): `KEITH_CLIENT_CONFIG` (path) or else
`KEITH_HOME` (`<home>/client.json`, made absolute) moves the login file from `~/.keith/client.json`;
`KEITH_DATA_DIR` or `KEITH_HOME` moves the data dir whose socket is tried. They are passed to `@keith/client`
(which never reads env). The motion settings above (`KEITH_INTRO`, `KEITH_IDLE_HIDE_SECONDS`, `KEITH_REDUCED_MOTION`, `KEITH_DISABLE_ORB`) are read here too.

### The app owns its connection

`cli.tsx` renders `AppRoot` (`src/app-root.tsx`) with the resolved `Connection`, not an `App` on a ready client. The root keeps
the current connection and its one client in state and renders `App` with `key={generation}`, `client`, `core` (`coreLabel`),
`connection` and `switchConnection(next, { notice? })`. A swap builds the client of `next`, bumps the generation and so unmounts
the old `App`: every hook stops its activity feed (`useActivity` calls `feed.stop()` on unmount), the chat session, the polls and
the dialogs go with it, and the new tree starts with no state of the old client (`KeithClient` has no timer of its own to
dispose). After a swap the app opens on Home and shows `notice` once as a success toast (tui-design 5.20, top-right over any screen; the root holds the `ToastProvider` above the keyed app, so the toast outlives the swap; it is not in the caption slot). `App` also works rendered alone (tests):
`connection` and `switchConnection` are optional (without `switchConnection`, `/login`, `/logout` and Home's `enter` only say that signing in needs the keith app). `start` also takes `login` (the Sign in screen first). The app has no `onExitMessage` any more: signing in no longer quits to print a command.

## Identity and logged-out state

`useWhoami` (`features/identity`) calls `rpc.auth.whoami()` at mount, on every feed resync, when the feed reconnects and on each `identity.changed` record (P27.3.6: a grant, revoke, role change or suspension of this person reaches the screen at once, without a restart). The chat mounts once it
answers, with session `front:<personId>` (`frontSessionOf`); nothing is hardcoded to `owner`. A 401 from whoami, or an
`unauthorized` activity feed (terminal in eharness, no retry loop), puts the app in the logged-out state: the header
reads `○ logged out`, the input band is replaced by the `Sign in` panel (`AuthPanel`, `features/identity`; Home draws the
same one: `This device is logged out or its credential was revoked.`, `Press enter to sign in.`,
`Keith reconnects by itself after the login.`; `enter` on the chat's block opens the Sign in screen, like Home's), the footer reads `ctrl+c quit` and nothing is sent. A whoami that fails
for another reason (the core is not there) shows `○ offline` and a `Core down` panel naming the target and the actions (`keith-core start`). While
whoami has not answered the header shows `◐ connecting <target>` and the conversation shows the empty state.
`/whoami` is an info notice in the conversation: name, role and login name (`Ana  member · login ana`), how the client
reached the core (`local socket`, or `<credential kind> credential`, with `(pin session)` or `(password session)` when the credential came from a PIN or password sign-in) with the core, `elevated` (`yes (local socket)`,
`yes (9:41 left)` after a step-up in this run, else `no`) and the core version, sha and front model.

**Role in the UI.** The header names the person by username (name when there is none) and tags anyone who is not the
owner: `ana · member` (`personLabel` in `app.tsx`). The UI never assumes the owner: the owner sees `keith-core`
notices where a member sees `Ask the owner` (`ASK_OWNER`), `/help` lists the commands of the role (`helpFor`), and
`/budget` has two views (below). Members get no node events, so the node list (`useNodes`) is read again when `/nodes`
opens and every 30 s while the sidebar shows it (`nodesPollMs` prop in tests); the owner keeps the events.

## Step-up

`features/stepup`; the state machine is `StepUpController` in `@keith/app-model` (`step-up-controller.ts`, texts in `step-up-state.ts`), `useStepUp` reads it as React state. A PIN session's refusal (`pin_session_cannot_step_up`) reads `A PIN session cannot confirm with its PIN: …`. A call the core refuses with `KEITH_STEP_UP_REQUIRED` (an oRPC error or an attention answer, both
carry `code`) goes through `useStepUp().guard(act)`: the prompt opens, `client.stepUp({ pin })` (or `{ password }`)
is called, and `act` runs once more; its second error is the caller's. Used by the approval answers (`useApprovals`)
and `tasks.stop` (`TasksScreen`). While the prompt is open it owns the keys (the chat input, the approval dialog and
the screens are off; on a screen other than the chat it replaces the screen until it closes).

`StepUpDialog` is a `Dialog` titled `Confirm it's you`: a masked `PIN ›` input; `enter` confirms, `tab` switches to
`password ›` (and back), `esc` cancels (the waiting action fails with `Not confirmed.`, shown in the approval dialog as
`✕ Failed to answer: Not confirmed.`). A failed attempt keeps the prompt open with a `danger` row: `Wrong PIN or
password.`, `Too many attempts. Try again in N s.`, `No PIN or password is set. On the core machine: keith-core people
pin <username>` or `This login is an old token. On the core machine run \`keith-core token create\`, then \`keith login
--token\`.` (the last two have no input, only `esc close`; a refusal that already says "legacy token" opens straight on
the old-token row). `/stepup` opens the prompt with nothing to retry (`Confirmed. Sensitive actions are open for 10
minutes.`); on the local socket it says `This connection is always confirmed (local socket).`.

The core does not expose `elevatedUntil` in `whoami` (only `elevated`), so the TUI keeps the time `stepUp` returned:
the header shows `elevated 9:41` just left of the connection, counting down each second in its own component
(`StatusInfo.elevatedUntil`), and drops it at 0:00.

## Moved commands

`messages.ts` holds the fixed texts. Typing `/connect`, `/providers`, `/model`, `/pair` or `/budget <x>` shows (to a member: `This is set on the core machine.` / `Ask the owner.`) an info
notice (two rows: the sentence, then the command in accent) with the command to run on the core machine (`Models are set on the core machine: keith-core model set front
<id>`, `keith-core provider add <id>`, `keith-core pair`, `keith-core budget set <usd|none>`). `/budget` alone and
`/nodes` stay as read-only views (`/nodes` ends with `keith-core pair, keith-core nodes revoke`).

Heir caption: the heir (and no one else) sees one muted caption row in the slot under the orb while the run is in `grace` (`You can take over this Keith: the claim opens <date>`, the date being the heir view's `claimOpensAt`; without one it reads `You can take over this Keith once the grace period ends`) or `claimable` (`Claim is open`). It holds the slot after an alert and before a transient notice, takes no toast, and is read at mount and every minute (`useHeirSuccession`, `HEIR_POLL_MS`). Owners and members who are neither read nothing. The pure lines are in `@keith/app-model/manage` (`succession-state`).

Protocol proposals: `features/protocols` (`ProposalNotice`, mounted by `AppRoot` beside the presence reporter) reads `protocols.proposals` at mount and every 60 s and shows each new pending proposal once as one toast line `new protocol proposal: <reason> · Apps > Protocols` (top-right, 5 s). A failed read stops the polling until the app mounts again (a signed-out terminal does not keep asking).

Notices: `eh.notice` messages are shown in English when known (a notice row keeps its level: `info`, `warning` or `error`), matched by `data.code` first
(`EH_TURN_INTERRUPTED` → `The previous turn was interrupted: its process stopped before it finished.`,
`EH_TURN_TIMEOUT` → `This turn stopped because it ran past its time limit.`, `EH_CONTEXT_THRASH` →
`This turn was stopped: the conversation grew too long and kept being compacted without progress.`, `EH_RUN_FAILED` →
`Unexpected error (see server logs).`), then by the exact English text of old notices stored
without a code (interrupted, run failed). Any other notice (the core's own English texts, `EH_COST_CAP`,
provider errors) shows its stored message unchanged (`noticeText` in `packages/app-model/src/message-text.ts`). The codes and the `aborted` stop reason are keyed by `NOTICE_CODES` and `STOP_REASONS` from `@keith/client` (re-exported from `eharness/codes`), never typed as strings; the codes a user can see without a text of their own sit in `GENERIC_NOTICE_CODES`, and a test fails when eharness adds a code that is in neither table.

## Screens

| Screen | How | What |
| --- | --- | --- |
| Home | `keith`, `esc` from the idle chat, `ctrl+g` from the chat | The orb, the brain frame, the subtitle and two keys; see Home |
| Chat | `keith chat`, `enter` on Home | Messages of the current front session (`frontSessionOf(personId, generation)`, `front:<personId>` before the first reset, then `front:<personId>:g<n>`; the view is mounted again on each generation). After a reset the top of the conversation shows a rule and `new context` (`ContextDivider`, from the generation: none in generation 0). The generation is the last of `chat.generations`, read at mount, on each `chat.context.changed` record and on each feed resync (`use-front-generation.ts`), so a second TUI of the person switches without a restart. Messages of tool lines under the assistant message, the person's own words stored inside an assistant message (a `data-eh.input` part with `source: 'user'`, such as the "ya" to the front agent's own pending call) as a user message between the two halves of the assistant message (`toItems`), notices, the approval dialog, the input band. A message with the part `data-keith.proactive` (a worker report that woke the front agent) has the `◆` dot. A `data-eh.event` part named `protocol.ask` (a protocol's question, `message-text.ts` `questionOf`) is a question card (`question-card.tsx`). The newest question with options is a frame `Keith asks` with its text and the options `1  yes`, `2  later`, footer `tab to answer`. `tab` gives it the keys (`question-state.ts` `answerableOf`), like the approval bar: `1`-`n` or `↑↓` and `enter` answer, `tab` gives the keys back; a typed character never answers, the input keeps the keys until `tab`, and while an approval waits `tab` is the approval's. An answer calls `protocols.answer` with `runId` and `option`; the card then shows `answered: <option>` and takes no keys. `CONFLICT` (the core closed the question) gives the toast `question closed` and the card reads `question closed`, with no keys; any other error is a toast. The settled state is per view: after a restart the newest question is open again, and its answer is `question closed` if the core closed it. An older question, or one without options, stays the notice `Keith asks: <text>` with `answer here: <option> · <option>` (`answer here in the chat` without options), answered by a reply the front agent records with `protocol_answer` |
| Succession | `/succession` | The heir's panel over Home (`SuccessionPanel`, `manage/succession/succession-panel.tsx`): the state with its dates, read from `admin.succession.get`. In `claimable` the typed word `claim` and enter call `admin.succession.claim` through the step-up prompt; a refusal is an error toast and changes nothing. A success pushes two success toasts, `You are the owner now.` and `Sign in again to continue.` (one toast line clips at 40 cells, `TOAST_MAX_WIDTH`), then signs this device out the way `/logout` does (`signOut`, a 401 from the revoke is fine) and Home opens signed out with the sign-in panel: the core revoked both sessions, so no `whoami` is read again. The owner is told to use Manage; a member who is neither gets `You are not the heir of this Keith.`. Refused offline (`NEEDS_CORE`) |
| Inbox | `/inbox` | Every pending approval in the approval dialog (see "Approval dialog": `tab` gives it the keys, `y` `n` `N` `a`, `esc` back); `Nothing is waiting for you.` when empty. The only place the TUI answers a `device` or another person's request |
| Tasks | `/tasks` | Every task of the board: a summary line (`4 tasks · ✳ 1 running`), a muted table header and a list with `↑↓`, `enter` for the detail (the summary as markdown, or `No result yet.`; a failed task starts with `Failed: <error>`), `s` then `y` to stop |
| Nodes | `/nodes` | A count line, a muted table header (`name`, `status`, `platform`, `version`, `last seen`; platform from 56 columns of content, version from 72) and every paired node: `● online` / `○ offline` / `✕ revoked`, `os/arch`, version, last seen (`just now`, `3 min ago`), on the rows under it: one per driver the node announced (`desktop 0.1.0 · screenshot input`: the capabilities without the driver prefix), a muted `refused: iot.switch (unknown capability)` per refused capability, and the shell policy (`shell allowed` / `shell off`); read only, no selection; scrolls |
| Brain trace | `/brain trace` | The last 50 brain events with their arrival time (`HH:MM:SS`), the region and the rest; newest last, sticks to the bottom, updates while open |
| Presence | `/presence` | The framed `Presence` screen (`features/presence`, `esc` back): `you` and the state (`active`, `idle`, `away`, `offline`, or `busy until 14:30 · note` / `busy until you /free`), `clients` (a `●` online or `○` offline row per client: kind, label), then the audiences (`owner`, `@users`, each `group:<id>`) with the level each may read (`none`, `state`, `detail`); `↑↓` selects, `enter` cycles the selected level and sends `presence.disclosure.set`. Its content is `presence.mine`, read again after each change |
| Budget | `/budget` | From `rpc.budget.get`, read only. Owner (the answer has `people`): `Monthly limit`, `Spent`, `Reserved` (only while a turn reserves money), `Remaining`, `Period` (`1 Oct 2026 – 31 Oct 2026`, UTC) and a table of people (muted header `person`, `spent`, `cap`, `left`; `ListRow`; scrolls); limits are set with `keith-core budget set`. Member (scope `person:<id>`, no `people`): `Your cap` (`$5.00 (set by the owner)` or `no cap`), `Spent`, `Remaining`, `Period` and `The cap is set by the owner.` |
| Manage | `/manage`, `keith manage` | Sections and actions for the owner (read-only parts for a member): see Manage |
| Sign in | `enter` on the chat's logged-out block, `/login`, `start: 'login'` (Home signed out has the login panel below instead) | `features/login` (`LoginScreen`, contract in `tui-login.md`): address, who (identifier), the methods the core offers as tabs (PIN or password, device code, token). Drawn by `app-session.tsx`, which creates the `createSignIn` controller (`address` = the current core, saving to `configPath`) when the screen opens and disposes it when it closes. `Esc` on the first step returns to Home or the chat it came from. On success the saved `client.json` gives the new connection (`signedInConnection`: the rules of `--core <core>`; a `unix:` address is the socket and saved nothing), the app calls `switchConnection(next, { notice: 'signed in as <name>' })` and lands on Home with that line as a toast |
| Sign out | `/logout` | `LogoutScreen` as a `panel` of Home (a `FramePanel` `Sign out` of at most 46 cells over the orb, Home draws the legend; `esc`/`n` goes back to the screen it was opened from): `Sign out of <core>?` with `[y] sign out` `[n] cancel` (`esc` cancels too). `y` runs `signOut` (`sign-out.ts`: `revokeSelf()`, a 401 counts as revoked, then removes `client.json` when it holds this credential, and drops an in-memory sign-in; a core that cannot be reached still loses the local credential and the screen shows a one-line note), then `switchConnection` to the same core with no credential: Home opens signed out, its sign-in panel the way in. Over the local socket it says there is nothing to sign out, except a socket that carries a session (`local trust: none`, the default): `/logout` revokes it, drops it from memory and the panel asks again (switch user) |
| History | `/history` in the chat | Read-only list of the person's chat contexts, newest first (`features/chat/history-screen.tsx`, `history-state.ts`): each shows when it started, when it ended (by `/new`) or `running now`, its message count, and `compacted N×` when a `/compact` shortened it (`chat.generations.compactions`, shown only when above 0); `esc` back to the chat. The list is read once on open (`chat.generations`) |
| Plugin view | `enter` or `right` on a plugin entry in Home's `Apps` submenu | A plugin's Ink view run by the core, drawn in a `ScreenFrame` (label tag = the entry's label): see Plugin views |
| Help | `/help` | Framed groups, scrolling with the wheel and `alt+↑↓`: Commands; Keys by screen (Chat, Home, Tasks and other screens, Manage, Dialogs; the hidden `[` `]` and `ctrl+o` `ctrl+p` included); On the core machine (a member: Settings) |

`/whoami` is not a screen (see Identity). A screen takes the whole terminal as a `ScreenFrame` (tui-design 5.11, 5.18): the label
tag, `K E I T H`, the connection status, the content and one legend; no sidebar, strip or status line. `app-framed.tsx` draws Help,
Tasks, Nodes, Budget, Presence and Brain trace; `app-screens.tsx` draws Manage. The chat stays mounted underneath (hidden) so its stream and
draft survive. `Esc` returns to where the screen was opened from, Home or the chat (on Tasks it closes a detail first, then the
list). Each screen puts its key hints in `useFooter`; the frame draws them as its legend. While the step-up prompt is open it
takes the place of the content and holds the only legend.

**One legend while a dialog has the keys** (tui-design 5.7): the approval dialog after `tab`, and the step-up prompt, list their
keys in their own last row. The page says nothing then: `hintsOf` returns no hints (the chat's rule is a bare line), Home's legend
is empty, a screen's legend is dropped.

## Plugin views

`features/plugin-view/` (P18 step 6; protocol and sanitiser in `plugin-views.md`). The core runs a plugin's view; the TUI shows its frames in the screen `view` and sends keys. It reaches the core only through `packages/client` (`client.viewMenu()`, `client.openView(...)`).

- **Menu.** `useViewMenu(client, { ready, refreshKey })` reads `GET /plugins/tui/menu` when the identity is ready and again whenever the connection kind changes; a core with no plugin routes, a refusal or a dead core is an empty list (never an error on Home). Home's menu lists one entry per item (`MenuTarget { kind: 'view', viewId, label }`) at the top of the `Apps` submenu, before `Plugins` and `Reviews`; `enter` or `right` opens it (entries have no detail box). Guests never reach this: the guest screen has no menu and the guest listener has no `/plugins`. A member's list is already filtered by the core.
- **Over the socket.** A TUI on the local Unix socket needs no token: the client is built with `socketPath` and the view upgrades as `ws+unix` under the socket's own rules (a locked socket answers 423 and the panel says it could not open the view; trust `none` uses the stored socket session).
- **Panel** (`PluginViewScreen`). A `ScreenFrame` with the entry's label, the connection status and the legend `[esc] back  [ctrl+g] home`. The view is asked for `columns - 4` by `rows - 6` cells (clamped to the protocol's 20 to 400 by 4 to 200) at the theme's colour depth (truecolor 24, 256 gives 8, 16 gives 4, none gives 1); a resized terminal sends the new size. While it connects the panel says `connecting…`. A slow link: after 400 ms without `ready` the panel adds `still waiting: the link to the core may be slow` (the attempt goes on, and the view takes keys at once). A dropped link: after 10 s without `ready` the attempt is closed and the panel says `The view did not answer in 10 seconds.` with `[r] reopen` (`PENDING_TIMEOUT_MS`, `SLOW_LINK_MS` in `use-plugin-view.ts`; a late frame of the closed attempt is ignored). `esc` and `ctrl+g` work at every step, pending or not.
- **Drawing.** The frames come from the client already parsed and sanitised; the panel draws the runs with `StyledLines` (`@keith/ui`), one Ink `Text` per run. **No byte a view printed is ever written to the real terminal**, so an OSC 52, a title, a device report or a cursor move in a frame cannot act on the user's terminal (a real-pty test asserts it). With `NO_COLOR` the colours are dropped and the attributes stay.
- **Keys.** `keyBytes(input, key)` turns an Ink key into the terminal bytes a program reading a raw terminal would get (arrows, home, end, paging, delete, enter, tab, shift+tab, backspace, ctrl letters, alt as an `ESC` prefix, text and pastes with their controls stripped) and calls `sendKey`. `esc` leaves (the view is closed) and `ctrl+g` goes Home: both stay with the panel, the view never sees them; `ctrl+c` is the app's own exit and is not forwarded. No mouse, no wheel, no Kitty protocol, no focus events go to a view.
- **Ending.** The panel keeps the view's last screen and says why it ended in words: disconnected, closed after 10 minutes idle, no longer allowed (revoked), not available (refused), too many views (limit), error, protocol, could not open. `r` opens a fresh view on the person's action where it can work (not after revoked or refused); there is **no automatic reconnect** (a view lives only as long as its socket). A view that exits by itself returns to Home. Closing the screen closes the view (the client says `close`, then drops the socket).
- **Home motion (P19).** Home is not mounted while a view is open, so its intro and idle hide cannot run under it, and no timer of Home runs; a view's keys are not Home's activity because Home is not there to see them. Back on Home the parts are shown and the idle timer starts fresh. App-level keys (`ctrl+b`, `ctrl+t`) are off while a view is open so they are never taken twice.
- **Events.** A view's `useKeith().events` runs in the core, not in the TUI: the TUI only draws the frames. The core's port reads the same activity records the person's feed shows, so a view and the feed agree (`plugin-views.md`, "Data and operations"); the TUI adds nothing to it. A prune past a view's cursor reaches the view's `onResync` (`plugin-views.md`, "Data and operations"); the view refetches, and the TUI only draws the result.
- **Tests.** `plugin-view.test.tsx` (the panel against a fake `openView`: states, keys, resize, reasons), `plugin-view-app.test.tsx` (Home to a real WebSocket on the fake core), `key-bytes.test.ts`, and `cli.view.pty.test.ts` (a real pseudo-terminal: the menu, a hostile frame that never reaches the terminal, `esc` back). The fake core (`testing/fake-views.ts`) serves `/plugins/tui/menu` and `/plugins/views/ws`.

## Home

`features/home/` (`HomeScreen`; the app wires it in `home-host.tsx`). `start: 'home'` is the default of `App`; `keith chat`
passes `'chat'`, `keith manage` `'manage'`. Home takes the whole screen: the status line, sidebar, strip and footer are
not drawn (their facts are on the title row), and the chat stays mounted underneath (its stream and draft survive;
its `above` slot is empty while Home shows the dialogs, so a dialog is never mounted twice). Layout, top to bottom: a
margin row; the title row (the brain frame at the left, `K E I T H` centred on the same row as the frame's top border,
a `✳` before it in the connection's colour, plus a word only when not online); the
orb, centred, filling the rows left less one spare gap row (at most 48; its width in cells is `height / cellAspect`, see Cell aspect). The orb is a fixed-size box in a fixed slot: its size and place depend only on columns, rows and the cell aspect (`homeSize`), never on the state, the caption, the ask prompt, the legend, a dialog or the menu (those use reserved rows or absolute overlays); the
subtitle (2 rows); one blank row; the legend `[space] menu  [enter] chat  [tab] ask`; a margin row. The brain frame hides below 80
columns, the subtitle below 14 rows; below 60 columns the app's one too-narrow line shows instead.

- **Orb mode** (`orbModeOf`), real state only: `alert` when logged out, the core is down or the connection is
  offline; `speaking` when the front assistant's last block is text and a turn runs; `thinking` while a turn runs and no
  text streams; `listening` when the chat draft is not empty; else `idle`. `ChatView` reports `onTurn({ busy, speaking,
  text })` and `onDraftChange(draft)`; nothing else about it changed. With `NO_COLOR` the orb is the static `● <mode>`.
- **Brain trace**: the app's `useActivity` `onRecord` calls `trace.fire(region, strength)` for every brain event
  (`regionOf`, `strengthOf`: `cortex.step` 0.25, `amygdala.decide` 0.55, `broca.start` and `motor.act` 0.8). The trace
  steps only while Home is on screen.
- **Subtitle**: the plain words (markdown stripped by `plainText`) of the assistant turn this session saw run, typed out
  as they stream, at most 2 rows. They stay 8 s after the turn ends, then clear; the next turn replaces them.
- **Caption slot**: under the orb Home has one slot of 2 rows (1 row below 14 rows) and a blank row before the legend.
  The orb's size comes from the terminal rows, columns and the cell aspect only (`homeSize`), never from what is shown
  below it. One thing at a time goes into the slot: the alert state (up to 4 rows; a wrapped alert past 2 rows takes the extra rows from the orb, `homeSize`), else the first notice (the
  failed approvals refresh, hidden while the core is down or the device is logged out, then the app's chat notice), else the
  `dreaming…` while a memory dream runs (nothing else holds the slot), else the subtitle. A sign-in message is a toast, never in this slot. The menu, the approval dialog and the step-up prompt are overlays and never resize the orb.
- **Signed out**: core down turns the orb `alert` (it keeps animating) and the slot holds a two-row caption, no frame (`home-caption.ts`):
  `✕ Cannot reach the core at <address>` in `danger` and nothing else (no tip). A row that does not fit has its address shortened in the middle, never wraps to a third row. **Logged out** (a 401) shows the login panel instead
  (`features/login/login-panel.tsx`, drawn over the lower orb like the dialogs, tui-design 5.16; `app.tsx` passes it to `HomeHost`
  as `panel` when the connection is signed out, the app can swap it and it is not the socket). `app-session.tsx` (`LoginPanelHost`)
  creates the controller with the core as its address, starts it at once (`submitAddress(core)`: it lands on the identifier box),
  saves to `configPath`, remembers the identifier in `client-state.json` next to it, and disposes it when the panel goes. While the
  panel is up it owns the keys and the legend (`useFooter` of its step is drawn in Home's legend row); `space`, `tab` and `enter` of
  Home are off. The chat key is hidden and disabled. Without the panel (no `switchConnection`) the old caption
  `○ Signed out` and `enter` to open the Sign in screen remain. While the core is down `enter` does nothing. The chat keeps its framed `Sign in` / `Core down` panel.
- **Privacy panel**: the first-login notice (`Your privacy`, `tui-login.md`, "After sign-in") is a `FramePanel` over the lower orb like the login panel, at most 46 cells wide, drawn only on Home and only while the core says it is unseen; `enter` acknowledges it once. Home's keys are off while it is up.
- **Approvals and step-up**: `ApprovalDialog` and `StepUpDialog` render bottom-centre above the legend (76 columns at
  most); the key rules are the chat's: `tab` gives the approval the keys, and while it or the step-up prompt has them
  Home listens to nothing.
- **Menu**: `space` opens a HUD list at the bottom left (no frame, no background: `▸` in the accent and a bold label on
  the selection, the others dim). It has two levels (`menuTree` in `menu-state.ts`, keys in `menu-nav.ts`): **Overview**
  (a leaf); **People & access** (People, Groups, Devices & tokens, Access, Succession); **Apps** (first one row per plugin view, then
  Plugins, Reviews and Protocols); **Models & budget** (Providers & models, Budget); **System** (Nodes, Audit, Tasks, Brain trace);
  **Help**; and, directly below Help with no blank row, **Logout** (every signed-in person; it runs what `/logout` runs:
  the Sign out panel on a core with an address, the in-memory session of the local socket revoked and dropped, so the
  sign-in panel returns). A leaf shows only when the role may read it and a group with no leaf is left out. A group row
  ends with a muted `▸` and is not a target. `↑↓` (or `j` `k`) select (wrapping) in the current level; `enter` or `→` on a
  group opens its submenu in the same box (the group's title is a muted first row); `←` or `esc` goes back and the
  selection returns on that group; `esc` at the top level and `space` at any level close the whole menu. The position
  lives only while the menu is open: reopening starts at the top. Legend: `[↑↓] select  [enter] details  [→] open
  [←] back  [esc] close`. `enter` on a section leaf toggles a read-only box (a `FramePanel`
  titled with the item) to its right with one to four live lines built by `summaryOf` from data the app already holds
  (connection, health, roles, budget, nodes, tasks, whoami, brain state; sections without live data have a one-line description,
Audit's is `The record of sensitive actions.` and `→ open`). **Overview** shows the connection, core version and status,
who you are and the front model; **Budget** the month's spend over its limit and what is left. The facts that left the
header live here. When the spend is at 80 % of the limit or more, the Budget item (and its `Models & budget` group row) gets a `!` after its title and its box
adds `! over 80% of the limit` (`! limit reached` at 100 %);
  while it is open, moving the selection updates it. `→` opens the full screen (`ManageScreen` on that section through its
  `initialSection` prop); `enter` on Tasks, Brain trace, Help or Logout opens it. A list longer than the terminal scrolls to keep the selection in view. Closing the menu closes the box. While the
  menu is open the legend reads `[↑↓] select  [enter] details  [→] open  [esc] close`.
- **Quick ask**: `tab` on Home opens a one-line prompt (`TextInput`, no prompt mark, placeholder `ask keith…`, at most 76
  columns, centred under the orb). It sits in the blank row before the legend, so the orb and the two subtitle rows
  never move (below 14 rows, where there is no subtitle, it takes the one caption row). `enter` with text sends the line
  to the same front session as the chat (`ChatView`'s `sendRef`, so it lands in the chat history), clears the prompt and
  keeps it open for a follow-up; an empty line does nothing. A line starting with `/` closes the prompt, opens the chat
  and runs the command there (`onCommand`). While the prompt has text the orb is `listening`; then `thinking` and
  `speaking` from the turn, and the reply is the subtitle (8 s after the turn). A long reply is read in full in the chat
  (`[enter] chat`). `esc` closes only the prompt: a second `esc` on Home stops a running turn. `tab` does nothing while
  signed out, with the core down or offline, in the menu, or while an answer-able approval waits (`tab` then belongs to
  the approval dialog). While open the legend reads `[enter] send  [esc] close`; closed it adds `[tab] ask` (priority 60,
  dropped first).
- **Keys**: `enter` opens the chat (disabled while signed out), `space` the menu, `tab` the quick ask, `ctrl+c` quits. `esc` on Home stops the
  running turn (the legend then reads `[space] menu  [enter] chat  [tab] ask  [esc] stop`, priorities `esc` 90, `enter` 80, `space` 70)
  and does nothing when idle; it never leaves Home. In the menu `esc` closes it. `[` and `]` (and `ctrl+o` `ctrl+p` on Home and in the chat) make the orb's cell aspect narrower or wider by
  0.02 for the session (hidden keys; listed in `/help`).
- **Motion** (`features/home/use-home-motion.ts`; visual rules in `tui-design.md` 5.16). The first Home of a process fades its
  parts in (orb, graph, legend, title and status); after `idleHideSeconds` without a key the graph, legend, title and status fade
  out and the orb stays, and the next key brings them back and is swallowed (never `ctrl+c`). One `useInput` in `HomeScreen` sees
  every key: it skips the intro, re-arms the idle timer (`useHomeVeil`, one `Scheduler.after`), then passes the key to Home's
  actions unless it only woke a hidden screen; the wheel (`onWheel`) counts as activity. Mouse motion is not reported, so only the
  wheel counts. `HomeScreen` takes `attention` (an approval, step-up or other dialog) and blocks hiding for it, for the panel,
  `auth`, `alert`, notices, a running turn, typing, the open menu and the quick ask. Settings (read only in `platform/config.ts`,
  passed by `AppRoot` as `motion`, which `cli.tsx` may also pass): `KEITH_INTRO` (`0`/`off`/`false`/`no` = no intro; default on),
  `KEITH_IDLE_HIDE_SECONDS` (default 60; `0` never hides; invalid or negative = 60) and `KEITH_REDUCED_MOTION` (set and not
  `0`/`off`/`false`/`no`: no fades at all, parts switch instantly; the intro does not play) and `KEITH_DISABLE_ORB` (set and not
  `0`/`off`/`false`/`no`; `keith --disable-orb` on `home` and `chat` sets it for the run, `commands.tsx`): the orb is still. It is
  one fixed frame (frame 0 of the orb, the same shape in every state), drawn with no timer, no waves, no intro of its own and
  no flight between Home and the chat (a plain switch). Only its colour changes, at once, with the state (connected, disconnected,
  signed in or out, as the moving orb). `OrbCanvas` reads it from the motion context (`orbStatic`, `packages/ui`); the sidebar orb
  and the header orb are still too. The wave graph (the brain frame) and the other Home parts keep their own motion. `keith --guest`
  draws no orb, so the flag changes nothing there. They are environment settings like
  `KEITH_THEME` and `KEITH_CELL_ASPECT`, not client-state: `client.json` holds only the login. No colour (`NO_COLOR`) and 16 colours
  never animate. Tests of the still orb: `packages/ui/src/orb-static.test.tsx`, `features/home/home-orb-static.test.tsx`,
  `disable-orb-app.test.tsx` (the switch, no flight), `commands.test.ts` (the flag, its help), `platform/config.test.ts`, and the
  real-pty `cli.disable-orb.pty.test.ts` (two Home screens at different times: the same orb cells). The intro is per process (`claimIntro`), so it is not replayed by a swapped connection. The `[` `]` hidden keys in
  `App` are not gated by the veil. Tests: `home-motion.test.tsx` (fake `Scheduler`).
- **Cell aspect** (cell width over cell height; the orb is round only when the app knows it). `cli.tsx` asks the terminal
  once, before Ink reads stdin (`platform/cell-size.ts`): `ESC[16t` (the cell size in pixels) and `ESC[14t` (the window in
  pixels, divided by rows and columns) go out together and the first cell reply wins; it waits at most 150 ms, consumes
  every byte that arrives meanwhile, restores raw mode and pause exactly, and skips everything when stdin or stdout is not a
  TTY or `NO_COLOR` is set. A detected value is clamped to 0.3..0.8. `KEITH_CELL_ASPECT` (0.25..0.8, read in
  `platform/config.ts`) wins over detection; if nothing answers (Terminal.app does not answer these queries) the default is
  0.46, a typical macOS font (Menlo and SF Mono at 13 to 14 pt: cells 0.45 to 0.47 as wide as tall). The value is one
  prop (`cellAspect`) from `App` to Home, the chat header and the flight. It is read once per run: a font change needs a
  restart (or `[` `]`).

## Manage

`features/manage/` (`ManageScreen`), opened by `/manage` in the chat (`Esc` returns to the chat) or by `keith manage`
(`Esc` quits). It hides the sidebar and the activity strip. Every action calls the procedure the matching `keith-core`
command calls (`people-commands.ts`, `admin-commands.ts`, `auth-commands.ts`, `ops-commands.ts`); no logic lives only
here. The server still enforces every capability and step-up.

**Sections** (one folder each: `overview`, `people`, `groups`, `plugins`, `reviews`, `devices`, `nodes`, `providers`, `access`, `budget`, `logs`, `audit`) and
the capability that shows them (`sections.ts`, `visibleSections`; the capabilities come from `auth.whoami().capabilities`, the role table plus the person's grants, so a granted member sees the matching section):

| Section | Shown with | Content | Actions (need the manage capability) |
| --- | --- | --- | --- |
| Overview | always | person, core version, front and cortex models, spend, node and people counts, logins waiting | none |
| People | `people.manage` | `admin.people.list`, and `admin.capabilities.list` for the grant picker (core ids and loaded plugins' ids, never an owner-only one) | add; rename, set role, suspend, reactivate, set password (hidden), set PIN (hidden), clear password, clear PIN, unlock, show grants, grant, revoke grant, turn sign-in on or off (owner only, a delegate never sees it; a person with it off shows `no sign-in` in the status cell), transfer ownership (confirm and type the username), remove (confirm) |
| Groups | `groups.manage` (owner only: a member never holds it, a grant is refused) | `admin.groups.list` (each group with its members and how many resources use it) and the people list for the picker | `n` create a group (`admin.groups.create`); add a member (a choice among the active people not in the group), remove a member (a choice among the members), delete (confirm; a group in use is refused by the core and its message, with the count, stays in the dialog) |
| Plugins | `plugins.manage` (owner only) | `admin.plugins.list`: `PLUGIN STATUS VERSION REVIEWS`; the detail line names a failure's reason or says a toggle waits for the next boot | no section action; per plugin: Show details (a read-only note: status, reason, timers, capabilities, operations; `admin.plugins.show`), Disable or Enable (confirm; `admin.plugins.disable\|enable`; the notice says it applies when the core restarts; a failed plugin offers details only; a step-up goes through the usual PIN prompt) |
| Succession | `read: succession.manage` (owner, People & access) | `admin.succession.get` (the owner view): `heir`, `window`, `state` (with its date: `grace since …`), `pause` (`until …` or `none`), `last sign` (`today`, `N days ago`, `never`). Actions: `Set the heir` (a form: a choice of the active members who can sign in, `setHeir({ person })`), `Clear the heir` (confirm, `clearHeir`), `Set the window` (days 7 to 90, `setWindow`), `Pause for a trip` (days 1 to 180, `pause({ until })`), `Resume` (only while a pause runs). Every call is sensitive: the step-up prompt opens first (the guard retries it once). No rows: the lines are the section. A member never sees it (`manage-state.ts`) |
| Protocols | `chat` (every person) | `protocols.list`, `protocols.runs` (`limit` 100) and `protocols.proposals`: `NAME [OWNER] TRIGGER STATE LAST RUN`. The owner also gets every person's and `keith`'s protocols (`OWNER` column, `you` for their own). Pending proposals are the first rows (`! proposed`, `expires …`). A `● on`, `◐ paused until …` or `○ off` state; a failed run carries `✕`. The owner also gets `protocols.settings.get` and `admin.approvals.get` | above the list, one line `asks: <question>` per run that waits on an `ask` step (`openAskOf`, `askLines` in `protocols-state.ts`). The protocol's row gets `Answer` while its newest run waits on an `ask`: a choice field of the options (`←→`, the first is the default), or a text field without options; it calls `protocols.answer` (`CONFLICT` says `question closed`). Per row: Details (a note with the definition's steps and limits and the last five runs), Pause (`Hours`, then `protocols.pause` with an epoch ms) or Resume (`until: null`), Delete (confirm; not for built-ins). A proposal: Confirm (`protocols.confirm`), Dismiss (`protocols.dismiss`), Details. Section: `New reminder` (`n`: `Remind me to`, `When` as `HH:MM` or `YYYY-MM-DD HH:MM`, local time) saves a `time` protocol with `protocols.save`: a notify to the run's owner, and on a failed delivery one wait of 10 min and one retry. The owner also has `Set the limits` (`protocols.settings.set`, step-up) and `Set the expiry ping` (`admin.approvals.set`, step-up) |
| Reviews | `reviews.decide` (owner only) | `admin.reviews.list({ status: 'pending' })`: `REQUESTER OPERATION ASKED PAYLOAD (data)`, the payload is one line of **data** | per review: Show the request (a note with the full input, labelled as data from the requester and never an instruction), Approve (confirm; `admin.reviews.approve` runs it as the requester, the notice says whether it ran), Deny (a form with an optional reason; `admin.reviews.deny`); both are sensitive, so a remote owner is asked for the PIN first |
| Devices & tokens | `devices.manage` or `tokens.manage` | pending logins, devices (`admin.devices.list`), tokens (`admin.tokens.list`) | approve a login by code, deny a code, create a token (shown once); revoke a device or token (confirm) |
| Nodes | `nodes.read` | the app's live node list (`useNodes`); the selected node's detail line shows its drivers and refused capabilities (`driverLines`, `refusedLines`) | `nodes.manage`: pair (code shown once), revoke (confirm) |
| Providers & models | `settings.read` | the model of each role (`models.roles.get`), connections (`providers.list`, only with `settings.manage`) | `settings.manage`: add a connection (hidden API key; saves then tests), test, remove (confirm), set a model role (`connection:model`) |
| Access | `settings.manage` | `admin.access.get`, and the `audit` line (`admin.audit.retention.get`, shown when the person may read it) | change mode, public URL, bind address, proxy (`admin.access.set`); audit retention in days, `0` keeps everything (`admin.audit.retention.set`) |
| Budget | `budget.read` | the month's spend and limit; an owner also gets every person | `budget.manage`: set the limit (`USD` or `none`), set a person's cap |
| Logs | `logs.mine` (every person; the owner also has `logs.read`) | Four levels, one at a time in the pane (`logs-pane.tsx`, `logs-view.tsx`): the sessions (`logs.sessions`: date range, app, shortened id, primary model and provider, calls, cost; the caller's own, or every person's for the owner), one session with its overview (input tokens, cache hit) and generations (`logs.session`; a call under a low cache hit is marked `↓` with the legend `low cache hit`, `activity-logs.md`, "TUI"), one generation (`logs.call`: figures, messages sent, tool calls, response), then its raw request and response (`logs.raw`, scrollable, flagged when cut). Keys and the filter: `activity-logs.md`, "TUI" | none (read only): `↑↓` select or scroll, `enter` drill in, `esc` up (from the sessions level it closes the screen), `/` filters by the start of a session id (`enter` applies, `esc` cancels), `f` the next kind, `s` mine or everyone (owner only), `r` reads the level again or opens the raw JSON from a generation, `pgup` `pgdn` page; a failed read of a session the core no longer has (`NOT_FOUND`) says `This session is gone. Press esc to go back.` with no retry hint; there is no trigger filter and no purge key here (`logs.purge` is an RPC, `keith-core logs` the CLI) |
| Privacy | `audit.mine` (every person) | the last 100 lines about the person (`client.audit.mine` = `admin.audit.mine`): `WHEN (UTC)  WHO  WHAT`, newest first, `r` reloads; empty state "Nobody looked at your things. Lines appear here the moment someone does." No address and no listener are ever drawn: the core does not send them | none (read only) |
| Audit | `audit.read` (owner only) | the last 100 events (`admin.audit.list`), newest first; the selected row shows its detail | none (read only) |

A member therefore sees Overview, Protocols (their own, with `New reminder` and the row actions), Nodes, Providers & models (the model roles only), Budget (their own spend), Logs (their own sessions, with no Scope toggle) and Privacy. The sections follow the identity: a grant or a revoke, a role change or a suspension arrives as `identity.changed` and the sections appear or go at once (P27.3.6). A People action names the person by the row's id, never by the username shown (the server takes either), so a rename cannot move the action to another person. The Home menu puts Privacy under System, before Audit.

**Layout** (5.15 in `tui-design.md`): the screen is a `ScreenFrame` (`ManageScreen` takes the whole `width` and `height`, and `status`
for the right end of the title row; the label tag is `Manage`). From 100 columns a 24-column section list at the left (plain rows, no
frame) and the section in a framed pane at the right, its title as the frame label and `n/N` as the right tag; a member's role is the
muted bottom tag of that frame. Below 100 the pane takes the whole width, with `‹ ›` as the legend's `[tab] next section`. A dialog
replaces the pane (it is the frame, never a frame inside the frame). Status cells are a glyph and a word (`● active`, `◐ suspended`,
`○ revoked`, `! (not set)`); fact lines (`people    3`) are a dim key and a value.

**Keys**: section list focused: `↑↓` pick a section, `Enter` or `→` move to the rows, `Esc` leave. Rows focused: `↑↓` select a row,
`Enter` opens the **Actions** menu of the row (its actions, then the section's), `n` runs the section's first action (add, approve, pair,
create, set the limit), `r` reads the list again, `Tab` (or `←`) goes back to the section list (one pane: `Tab`/`→` next section, `←` previous), `?` shows the keys,
`Esc` leaves. An action without fields or a confirmation runs at once.

**Legend**: the one legend at the bottom follows the focus (`legend.ts`). List: `[↑↓] section  [enter] open  [esc] back`. Rows:
`[↑↓] select  [enter] actions  [n] <first action, named: add a person>  [r] reload  [tab] list  [esc] back  [?] help`. A dialog
says its own keys (`[enter] next` or `submit`, `[tab] next field`, `[←→] choose`, `[esc] cancel`; confirm `[y] confirm  [n] cancel`).
Every pair has a priority (esc, enter, select first; tab and reload last; `?` pinned), so a narrow terminal drops pairs and never
cuts a label or ends in `…`. A secret is never in a legend or a frame label.

**Dialogs** (`dialog-state.ts` is the pure state, `dialogs.tsx` draws them): a *form* has one row per field (`Field`): `Tab`/`↓`/`↑` change the field, `←`/`→` or space change a choice,
`Enter` goes to the next field and submits from the last, `Esc` cancels; an empty required field shows `<Label> is required` and calls nothing. A *confirm* (remove a person, revoke a device,
token or node, remove a connection, transfer ownership) answers to `y` (`n`/`Esc` cancel); transfer ownership asks the username to be typed
(`Enter` with a different word shows `That does not match.`; the confirm frame is `warning`). A *note* shows a result: a new token or pairing code says
`Shown once. Copy it now: it cannot be shown again.` and is gone for good once closed.

**Secrets**: API keys, passwords and PINs are hidden inputs (`Field secret`: `•` only, never the value). The values leave state when the form is submitted (the call keeps its own copy)
and again on a failure, which puts the focus back on the first secret; no frame ever contains one.

**Errors and step-up**: a failed call is an `error` notice with the core's message (a form stays open with it). A call refused with `KEITH_STEP_UP_REQUIRED` goes through
`useStepUp().guard`: the PIN prompt opens (the Manage screen stays mounted but hidden), the action runs once more after it; `Esc` on the prompt says `Not confirmed.` and nothing was done. The section reads its list again (`reload`) after every call, success or failure, so a refused or conflicting call shows the core's real state; a cancelled prompt reads it again too.
Every settings write is a `stepUp` procedure in the contract (`permissions.md`).

## Layout

`layout.ts` (`layoutOf(columns, { rows, sidebar })`) is the rule; `tui-design.md` section 4 has the drawings. The app
is full screen (`alternateScreen`). Width is `useWindowSize().columns` (the prop `columns` overrides it in tests).
Under 60 columns the app draws one line (`keith needs at least 60 columns`). 60-99 columns: one column, an activity
strip above the input band (`◐ cortex ×2   2 tasks running   nodes 1/2`); `ctrl+b` shows the 32-column sidebar anyway.
100-159: a 32-column sidebar on the right (Tasks and Nodes, plus Brain in the compact layout, each a btop frame). 160 and
more: a 40-column sidebar; the conversation column takes all the room up to the sidebar (no prose cap). Below 20 rows the footer hides; below 12 rows the sidebar
hides at any width. The chat keeps the margins of every screen: one blank row at the bottom (and one above the compact status line),
and with the sidebar a 2-column right margin (`layout.left` = columns - sidebar - 3 - 2: a blank column, the `│` separator and a blank column sit
between the left column and the frames), so the frames end where the header's status ends.
`layout.header` (80 columns and 20 rows, `HEADER_ROWS_MIN`) says the chat shows a header; `layout.headerVariant` says which.
**Wide mode**: with the sidebar shown, 100 columns and 40 rows (`ORB_SIDEBAR_COLUMNS`, `ORB_SIDEBAR_ROWS`) `layout.orbInSidebar` is true: the header
is the `title` variant (`ChatHeader variant="title"`: the title row and a blank one) and the sidebar reads orb (10 rows at 40 rows, 14 at 44, growing with the terminal up to the column's width, never under 8: `orbRowsFor`, `orbMaxRows`),
wave graph frame (7), Brain (7), Tasks, Nodes (`planSidebar` with `orb`, `sidebar-head.tsx`; the orb is never drawn partially). Below those sizes, or
when `ctrl+b` shows the sidebar at 60-99 columns, the orb stays in the header. The wide chat is two columns: the left one (header, conversation, input rules, legend; `ChatView`) and the sidebar beside it over the full height (`SidebarColumn`, `sidebarBox`). The Home flight starts (`esc`) and lands (`enter`) on the sidebar orb: `chatOrbBox` computes its box from the same numbers (`sidebarBox`, `orbRowsFor`, `sidebarOrbBox`) for the chat layout even while Home is the screen on view; with the sidebar hidden (`ctrl+b`), under the wide size or when the orb is in the header, the box is the header corner (`CHAT_ORB_BOX`). Every layout with a sidebar draws the separator `VRule` (`SidebarColumn`) in the `border` token.

**Chat header** (`ChatHeader` in `packages/ui`, tui-design 5.17), on the chat screen at 80 columns and 20 rows or more: 7
rows, the mini orb (14 x 7) at the left; right of it a title row `✳ KEITH  <mode>` with the connection status at the far
end, the brain graph, the region list and the trail. It replaces the status line, the footer row and the sidebar's
Brain panel (`ctrl+b` and `ctrl+t` still work; `/brain` toggles the Brain panel of the compact layout). The key hints
are the footer's content drawn as the one legend row under the input, which sits between two bare rules (`Rule`: plain dim
`─` lines the width of the left column; the legend is followed by the margin row). Where the left column is too narrow for
them all (about 100 to 106 columns with the sidebar) the lowest-priority hints are dropped, never cut with `…` (`priority`
on each hint; `enter send` and `esc home` stay, `/help` is always kept and lists every key). The same bottom (rule, input,
rule, legend) is used by the compact layout; under 20 rows its margin row goes first. While an approval or the step-up
prompt has the keys the legend row is empty and the input reads `tab to return to chat`.
The input has no prompt mark. `App`'s `header` prop (default on) turns
it off; tests of the compact layout do.

**Flight**: `enter` on Home and `esc` (idle) or `ctrl+g` in the chat move the orb between its Home box and the header box: 4 frames
75 ms apart (300 ms, 13 fps) of the orb alone, eased (`features/home/orb-flight.ts`, `OrbFlight`); the timer lives only
while it flies and no key is held (the screens underneath stay live and take the keys). It is skipped without colour and
below the header size. Under `--disable-orb` (`orbStatic`) there is no flight: the screen changes at once.

Compact header (`StatusLine`, under 80 columns or 20 rows on the chat, below a blank margin row): `✳ K E I T H` centred, the
`✳` coloured by the connection (green online, yellow connecting or reconnecting, red offline or logged out) and a word
(`connecting <target>`, `reconnecting`, `logged out`, `offline`) only when not online or without colour,
with `elevated 9:41` at the right while stepped up. Nothing else: the core version, the front model and the spend are in
the Home menu (Overview, Budget) and `/whoami`, `/budget`; a missing model is the notice that tops the conversation.
**Connection states** (`features/activity/use-connection.ts`, a thin hook over `watchConnection` in `@keith/client`, which has the rules: `client.md` Connection monitor): `connecting` (the first connect: nothing is said), `live`, `reconnecting` (amber `reconnecting… (3 s)`), `disconnected` (red `✕ disconnected: cannot reach the core (<target>, <reason>) · retrying in 12 s` with a live countdown) and `logged-out`. A drop is `reconnecting` for one window of 5 s; not live by then it is `disconnected` for 15 s; then one attempt (`reconnecting`, 5 s); success is `live`, failure `disconnected` again, forever. `logged-out` (a refused credential) and the locked socket stop the retries. Settings (read only in `platform/config.ts`, `loadLinkTuning`): `KEITH_RECONNECT_WINDOW_SECONDS` (default 5) and `KEITH_RECONNECT_WAIT_SECONDS` (default 15). The message picks the longest form that fits its row (the target and last error, then `cannot reach the core`, then `✕ disconnected · retrying in 12 s`) and is in the status line, the chat header's title row (narrow and wide) and Home's alert caption.

**Offline mode** (`features/activity/offline.tsx`): while the link is `disconnected` or `reconnecting` after a drop, `useLinkValue` (called by `App`) builds the mode and `LinkProvider` (a React context owned by that `App`, read with `useLink()`: two Apps in one process never share it) hands it down; every screen that needs the core is inactive. The screens read their keys through `useGuardedInput` (a drop-in `useInput`): Home (`space`, `enter`, `tab`), the approval and step-up dialogs, Manage and its sections, the Tasks screen and the plugin view only receive `ctrl+c`, `ctrl+g`, `esc` and the movement keys; `r` is the retry key (`OfflineKeys`, mounted once: an attempt now, once per 3 s, still with its 5 s window); any other key is refused with the one-line hint `offline: cannot reach the core (<target>, <reason>) · [r] retry now`, shown 3 s through the app's notice (on Home it takes the caption slot for its moment). The chat replaces its input row with `✕ offline: ... · [r] retry now · your draft is kept` (`offlineBar`; the draft lives in the chat view and returns with the input); scrolling the loaded conversation and `/help` stay (the input is the only way to type a command, so slash commands wait). An open plugin view is closed and is not reopened by itself. On `live` the activity feed's resync path refetches state and the screens are active again. Slash commands that need the core (`/manage`, `/tasks`, `/nodes`, `/budget`, `/stepup`, `/presence`, `/busy`, `/free`) are refused with the same hint (`CommandEnv.offline`); `/help`, `/quit`, `/logout`, `/login`, `/brain`, `/mouse` and `/whoami` stay. Manage's legend dims what needs the core and adds `[r] retry now` (`offlineHints`), because its screen has no notice row. Home dims what needs the core: the legend's `enter chat` and `tab ask` and every menu leaf but Logout are `text-muted` (groups still open, their leaves are dimmed the same way) (`LegendKey.dim`), the legend adds `[r] retry now`, and `space` still opens the menu because **Logout needs no core** (`useGuardedInput`'s `allow`: on a core with an address the Sign out screen clears the stored credential locally and warns when it could not revoke it).

## Panels

The sidebar shows three panels; `ctrl+b` shows or hides the sidebar, `ctrl+t` the Tasks panel, `/brain` the Brain
panel (state keeps updating while hidden).

**Brain** (`features/brain`): eleven regions in two columns (six rows; `corpus-callosum` is labelled `Rooms`). `●` lit (an event of the region arrived
less than 1.5 s ago, `success`), `◐` working (cortex with active workers, `◐ Cortex ×n`, from `brain.cortex.start`
until `brain.cortex.end` of each task id; amygdala while approvals wait, `warning`), `○` idle (muted). The last line is
the latest event as text (`› cortex.research step 4`; `stepIndex` is zero-based, the text counts from 1) or
`› no activity yet`. A dream run (`brain.hippocampus.dream`, `phase` `start` then `end`) lights the hippocampus lamp (`◐`) and the last line
reads `› dreaming…` from its start; its end reads `dream: 2 promoted, 1 merged` (`dream: nothing to change` when no count is set), and the
start never shows a count (P35.6.3, `brain-state.ts`: `dreamLineOf`). A feed resync (`use-app-feed.ts` `onResync`) forgets the
running dream (`resyncBrain`), since its end may have been missed while the link was down; a later start sets it again. Lit time uses the local arrival time, not the record's `createdAt`. State is a pure reducer
(`brain-state.ts`: `reduceBrain`, `resyncBrain`, `viewOf`, `viewKey`); events only touch a ref and a timer samples it every 100 ms
(`useBrain`), re-rendering only when a lamp or the last line changed, so a burst of events renders at most every
100 ms and the fade needs no timer per event.

**Tasks** (`features/tasks`): running tasks first, then the newest, as many as the panel's rows allow, then
`… +n more  /tasks`. Each row: the status glyph (`○` queued, `◐` running, `‖` waiting, `✓` done, `✕` failed,
`■` stopped, `⊘` timed out, `↯` interrupted) in its status colour, the short agent name (`research` for
`cortex.research`), the description (truncated) and the elapsed `mm:ss` (`h:mm:ss` from an hour; frozen at
`finishedAt`; running tasks tick every second). The title carries `n running`. Empty: `no tasks yet`.

**Nodes** (`features/nodes`): `Nodes  1/2 online` and the nodes (online first, then offline with their last-seen time
at the right; revoked nodes are not listed or counted), `… +n more  /nodes` when cut. Empty:
`no nodes · keith-core pair`. The count also shows in the activity strip. The panel does not list drivers; `/nodes` does.

**Dreaming** (pure logic in `packages/app-model` `dream-pending.ts` and `dream-marks.ts`; `features/memory/use-dream-activity.ts`): the chat shows the memory dream of the
person whichever trigger started it (`/dream now` or the schedule). The activity feed's `brain.hippocampus.dream` start puts one animated line
into the transcript where `thinking…` shows (`dreaming · 12 s`); its end replaces the line with one divider after the message that was last
when the run ended (`dream finished · …`, the words of tui-design 5.6). The end's status and reason come from `dream.status` (the run the end
names); when the status has moved on, the event's counts decide. A run this TUI started is settled by its own answer, so one run gives one
divider. The input is never held by a dream. A resync forgets a running line (its end may have been missed). Only the dividers that finish
after the chat mounted are shown (a new generation starts without them). Home's caption reads `dreaming…` while it runs.

**Presence** (`features/presence`): this terminal is one of the person's clients (docs/specs/client.md, "Presence reporter"). `PresenceProvider` (mounted by `AppRoot` for each connection) registers it as kind `tui` with the capabilities `chat`, `notify`, `open.view` and `render.markdown` (`TERMINAL_CAPABILITIES`; location is never announced), keeps its id in `client-state.json` beside `client.json`, and heartbeats; `touch()` runs on every key press (`use-app-keys.ts`) and on a sent message, so the core sees the person as `active` for 30 s. A `brain.parietal.deliver` for `notify` shows as the toast `Keith · <name>` and is acked `ok` (a handler that throws acks `ok: false`); the record carries the capability and the name, not the text, so the text arrives in the chat. A `open.view` delivery opens the plugin view (`plugin:<id>:<view>`, the menu's `<id>.<view>`) or the Tasks screen (`tasks`) named by its `name`, through `usePresenceViewOpener` (the app hands its opener up to the provider above it) and is acked `ok` with `result: 'opened'`; a view the menu does not list, or any other name, is acked `ok: false` with `unsupported`. Without a config path the id is kept in memory only, so nothing is written to disk.

**Amygdala** (in the Brain panel): lit by `brain.amygdala.wait` and `decide` like every region, and
it shows `◐ Amygdala ×n` while `n` approvals wait (`n` = the length of the approval list, so it
drops as they are answered).

## Approval dialog

**Consent routes (ADR-0036 §7, P39.4).** Each pending approval has a route (`routeOf` in `@keith/app-model`, from `extra.consent`): `conversation`
(the person's own request: Keith's message asked the question and the person's next chat message answers it), `device` and `other` (a member's
request the owner answers), or `legacy` (the core sends no `extra.consent`: an old core). The chat and Home draw the card only for `legacy` items
(`chatScope`), so an old core behaves as before. Everything else has **no card and no key shortcut in the chat**: one muted line above the input
(`ConsentLine`, `quietLineOf`), `Keith is waiting for your yes or no · <summary> · expires in m:ss · details /inbox` for a `conversation`
request and `Confirm in the Inbox (/inbox) · <summary> · expires in …` for the others (`Waiting for the owner to approve · …` for a member's own
request). A `device` or `other` request also raises the toast `Confirm in the Inbox (/inbox)` once (`useInboxToast`, `newInboxIds`). Typing and
sending a message is the whole answer to a `conversation` request (the core reads it); `tab` still completes a command and gives nothing to an
approval. **`/inbox`** (screen `inbox`, a framed screen labelled `Inbox`, Esc back) shows the one dialog below over every pending approval,
`conversation` ones included as the fallback, with the rule kept: keys only after `tab`. Empty: `Nothing is waiting for you.` The headline of a
known tool is a human phrase (`approval-headline.ts`: `switch the persona to butler`, `edit the persona`, `restore persona version 3`, `use <model> for
the <role> role`, `change how Keith talks to you`, `set your status`, `undo the last change`; any other tool keeps `<agent> wants to call <tool>`
with the clipped JSON). `a` (allow for task) is offered only when `offersTaskGrant`: the core marks the item scopable, it is not a `conversation`
request and the tool is not a persona, model, style, status or undo tool.

`features/approvals`. In the Inbox screen (and, for a `legacy` item, above the input band inside the chat screen) a dialog is shown: `Approval needed  1 of N`, the sentence (`research wants to run a shell command on laptop-e`, or
`<agent> wants to call <tool>` with the clipped JSON input), the whole command on its own row (`$ df -h`, never
truncated) and `task  <description>` when known. Oldest first (`createdAt`); `askOf` builds the rows. Items that
are not approvals (client tools, waits) are not offered.

A `desktop.input` call (P31.3.5) reads `<who> wants to run desktop.input on <node>` and lists its `actions` in words,
one row each, from the call's input (`item.input.input.actions`, which the core passes through unchanged; no core
change): `click (412, 230)`, `double click (412, 230)`, `right click (412, 230)`, `move (412, 230)`,
`drag (1, 2) to (3, 4)`, `scroll down` (the direction is `keys[0]`: `up`, `down`, `left` or `right`; the driver scrolls 3 lines, the contract has no amount), `type "hello"`,
`key cmd+space` (`keys` as a string or a list). An action of another shape is shown as its clipped JSON
(`actionWords`, `approval-state.ts` in `@keith/app-model`). A `desktop.screenshot` has no action rows: its input is shown as before (JSON, or
nothing when empty). The member's request keeps the rule of P24.1.6: `extra.scopable` is false, so no `a` key and no
`[a] allow for task` hint, and a member's own owner-routed item stays read only.

Each request shows its age (`askedAgo`, from the item's `createdAt`): `asked 3 h ago`, muted. The core sends
`extra.expiresAt` (the creation plus the lifetime, ADR-0027 §10); two hours before it the line turns `warning` and reads
`· expires soon`, and past it `· expired` with a toast `request expired` (the core denies it at its next sweep). The
line re-reads the clock every 30 s.

Two people (`amygdala.md`): for the owner an item with `extra.askedBy` reads `<askedByName> asks to run a shell command
on <node>` with the whole command (`extra.command`); answering from a remote client may open the step-up prompt, then
the answer is sent once more. For a member an item with `extra.waitingFor === 'owner'` is their own request: the dialog
is read only (`◐ Waiting for the owner to approve`, no legend row, no `tab`, the footer has no `tab approval`) and shows
only when nothing answerable waits. If the core still answers such an answer with `KEITH_WAITING_FOR_OWNER`, the dialog
shows `Waiting for the owner to approve`.

**Keys: the chat input keeps every key by default** (so a message that starts with `y`, `n` or `a`
is never taken for an answer; approving a shell command by accident is worse than one extra key).
`Tab` gives the keys to the dialog (its frame and title turn `warning`, the chat input reads `tab to return to chat`),
and there:

| Key | Answer |
| --- | --- |
| `y` | `approve`: allow this call |
| `n` | `deny` with no reason |
| `N` | asks for a reason (`reason › ` and a text input; Enter denies with it, an empty reason denies without one, Esc cancels) |
| `a` | `approveForSession`: allow, and the same node + capability for the rest of that task. Offered and answered only on an item with `extra.scopable` (the core sets it; ADR-0027 §14): the owner's answer to a member's request never sets a grant, so the hint is absent there |
| `Tab` / `Esc` | back to the chat |

The dialog gives the keys back by itself when nothing waits any more. A failed answer shows as a `danger` row
`✕ Failed to answer: <message>` inside the dialog and the item comes back; a failed refresh of the inbox (nothing
waiting) is a warning notice above the input; an item answered elsewhere (409) stays gone. The inbox refetches itself
on feed events and resyncs (`client.md`). While an approval waits `tab` belongs to the dialog; without one it
completes a `/command`.

## Room

`features/room` (`index.ts`, `room-state.ts`, `use-room.ts`) is the TUI side of a shared room (docs/specs/corpus-callosum.md, "TUI"). The state is pure and tested in `room-state.test.ts`; the hooks only read the client. The screen (`room-screen.tsx`: `RoomScreen` reads the state, `RoomPane` draws it) and the banner row (`room-banner.tsx`) are described in tui-design 5.21; the Home banner, the invitation notice and `/room` are wired in P30.5.3 (see "Commands and keys").

- **Banner** (`bannerOf(headers, me)`): one row. An active room the person is in reads `● Room "Planning" · Ana, Duta, Keith · /room` (every active member, then Keith; accent). Else an open room the person started, still waiting for invitees, reads `○ Room "Planning" · waiting for Duta · /room` (muted). Else nothing.
- **Where it shows**: the banner is one row on Home (in the caption slot, after an alert, the sign-in panel, the heir's line and a
  notice; not while a turn runs) and one row under the chat header (`ChatFrame`). The room view is the framed screen `room`
  (`app-framed.tsx`), labelled `Room`, `esc` back to Home. The app reads the rooms with `useRoomApp` (`use-room-app.ts`), which
  also owns the invitation toast (once per room), the accept and decline calls, and the `/room` command (`room-command.ts`,
  `parseRoomCommand` and `runRoomCommand`, tested in `room-command.test.ts`). A failed call is an error toast with the core's words.
- **Invitation notice** (`inviteNoticeOf(headers, me, now)`): the oldest invitation the person has not answered, of a room not ended and not past its expiry. The expiry is the server's `inviteExpiresAt` on each `rooms.list` item (`invitedAt` plus `rooms.inviteTtlMinutes`, null unless invited); the TUI has no TTL default. `more` counts the others. Text: `Ana invites you to a room with Keith.`; the keys `[enter] accept  [d] decline` are Home's: while an invitation waits, `enter` accepts (the room view opens) and `d` declines
  (toast `Declined.`). The notice is hidden while the core is down. Keys are read by `useGuardedInput`, so offline they are refused.
- **Transcript** (`lineOf`, `roomViewOf().transcript`): the events the person may read, sorted by `seq`. A line has the speaker's name, `keith` for Keith's glyph, and the body. A `handoff` reads `<name> asked in their own chat` (it has no text in the room). Join, leave and remove name the person. Events after the person's own `leftAt` are hidden.
- **Members**: the active and invited members, then Keith. The presence dot comes from the disclosed presence line: `online` (active), `busy`, `offline`; a member with no disclosed line reads `unshared`. An invited member reads `offline` until they answer.
- **Indicator** (`indicatorText`): `Keith is thinking…`, `Keith is answering <to>…`, `<who> is typing…`; `idle` shows nothing. Shown only while the person is in an active room.
- **Members and presence** (`roomViewOf().members`): each member's dot comes from the `presence` line `rooms.get` gives for that member (`dotOfPresence`): `busy` is busy; `active`, `available` and `idle` are online; any other state is offline; `not shared` is unshared (the dot `unshared`). An invited member is offline.
- **Confirmation**: the oldest pending request of `view.pending` that is still `pending` and unexpired. `rooms.get` lists only what the caller may confirm (the request names them, or it is a remove or an end and they are the owner), so the TUI does not filter by person (`remove`: `Remove Duta from the room?`; `end`: `End the room "Planning"?`; `post`: `Share this with Planning?`, the text quoted under it, cut at 80 characters, `detailOf`). Nobody else sees a request they may not confirm. The screen takes its keys only after Tab, like the approval bar.
- **Gates**: after the person left or was removed, or once the room ended, there is no input (`canSpeak`, `canControl` false), no indicator and no confirmation.
- **Hooks**: `useRooms(client, me)` (nothing is read while `me` is undefined, i.e. signed out) reads `client.rooms.list({})` at mount, on every feed resync and on any `room.event` or `brain.corpus-callosum.*` record. `useRoom(client, roomId, me)` keeps the view in `createRoomView` (`client.md`, "Rooms"): `rooms.get` is read again on each `room.indicator` and `room.event` of the room, on resync and on the room's `brain.corpus-callosum.*` records. The transcript comes through `createRoomEvents`. The feed is the one `App` starts.
- **Indicator**: `roomViewOf().indicator` is the `indicator` that `rooms.get` carries (the core holds it in memory). The feed record `room.indicator` names no value, so a change reads the view again.
- **Audit**: the owner's Manage Audit view lists the `room.*` rows like any kind: the time, the kind, the actor, the via and the JSON
  detail (`admin.audit.list`). No room section is added to Manage.
- **Presence and indicator are read by members only**: `rooms.get` gives presence and the indicator to an active member; an invitee, a past member and an owner who is not a member read `not shared` and `idle`, so the room view shows no indicator and no dots to them.

## Persona

Code: `apps/tui/src/features/persona/` (`persona-state.ts`, `style-state.ts`, plain functions, no React and no I/O; the screens and the Manage section are P33.5.3, the slash commands P33.5.4). The persona and the style are the core's (`prefrontal.md`, "RPC"); the TUI only shows and edits them through `client.persona`.

- **Persona state** (`personaScreenOf({ view, history, draft? })`). The state holds the summary (`professional · version 3`, or `custom (edited) · version 4`), the saved text by field, the draft, the dirty fields, the problems and the patch a save sends. The fields are the editable ones of `PersonaBody` (tone, attitude, humour, addressing, caresAbout and the two fixed lines). A save sends only the dirty fields, lines nested under `lines`, in the shape of `persona.edit`. The limits are the contract's `PersonaPatchSchema`: a text over its limit, an empty fixed line and a humour outside its words are problems, and no patch is built while one is open. A template picker offers the built-in templates only (`custom` is never chosen).
- **History.** Newest first; each row says its template and its reason (`template chosen`, `edited`, `restored`) and the author. Every row but the current version can be restored (restore writes a new version).
- **Style state** (`styleDraftOf`, `checkAddress`, `toggleTopic`, `stylePatchOf`). The "Me" form edits the person's own style: address, language, brevity, formality and up to five gentle topics (checkboxes over `GENTLE_TOPICS`). A save sends only the changed fields. A blank address clears the name (`null`).
- **The address check mirrors the core.** `checkAddress` calls the contract's `validateAddress` (the shape and the `ADDRESS_DENY_WORDS` deny list) on the address as typed, without trimming, so the form refuses the same values `AddressSchema` refuses. The message names the deny word when that is the cause. A test checks each candidate against `validateAddress` and `AddressSchema`.
- **Final check.** `stylePatchOf` ends with `PersonStylePatchSchema.safeParse`, the core's own schema; a refusal there is shown as a problem of the field it names, and no patch is sent.
- **Refetch.** The screen refetches through `watchPersona` (client, "Persona"): a `persona.changed` record or a feed resync reads `persona.get` and `persona.history` again.

- **Manage "Persona" (owner).** The section (`usePersonaSection`, `persona-section.ts`) is listed for `settings.manage` only; a member does not see it. It shows the summary and each field's saved text, and its rows are the history (newest first, `ver`, change, UTC time, author; the current version has no action). Its actions are `Choose template` (the built-in templates; `custom` is never picked) and `Edit persona` (the seven fields; `humour` is one of its words). `Restore version <n>` asks first and writes a new version. Every action runs through the Manage host's guard: a save the core refuses for a step-up opens the PIN prompt ("Confirm it's you") first and runs once more after it. A form that the schema refuses (`patchOf` problems) is an error and no call is made.
- **No client context row (ADR-0033 amendment, Nov 12, 2026).** The Me screen has no switch for the client context; the front agent always knows the
  client facts (`parietal.md`, "Client context block").
- **Presence reporter (ADR-0033 §2).** The terminal sends its environment (host, OS, device, time zone, locale; `detectEnvironment`) on its register.
  Detection never blocks the screen: a failed probe is left out.
- **Me (`/persona style`).** The framed screen `me` (label `Me`, `esc` back), `StyleScreen` in `style-screen.tsx`. Its last row, `Memory`, opens the Memory screen (`enter`; P35.6.3). It reads `persona.style.get` only and shows the person's own address, language, brevity, formality and the five gentle topics as checkboxes. `↑↓` move between rows, `←→` or space change a choice, space toggles a topic, typing edits the address, `enter` saves the changed fields with `persona.style.set` (no step-up: the style is the person's own). The address shows the `checkAddress` problem under its row; a refused save shows the first problem and sends nothing.

- **Memory (`Me > Memory`, P35.6.3).** The framed screen `memory` (label `Memory`, `esc` back to Me), `MemoryScreen` in `features/memory/memory-screen.tsx`. It reads `dreaming.status` and `dreaming.diary` of the person's own memory only: the mode, the last run (`runLineOf`), a staged plan with its counts and the `- ` entry lines of its own `## run <id>` section in the diary of its day (`stagedEntriesOf`), and the latest diary day. It changes nothing; `/dream` does. The contract has no list of diary days, so the screen shows the latest day; a list needs a `dream` procedure that the contract does not have yet. Tests: `memory-screen.test.tsx`, `dream-commands.test.ts` (parsing, each refusal's words, the outcomes, the staged entries) next to the code.

Tests: `persona-state.test.ts`, `style-state.test.ts`, `commands.test.ts`, `persona-section.test.tsx` (the section list by role, the restore rule, the step-up before a save) and `style-screen.test.tsx` (own values only, a save sends the changed field, a refused address is not sent) next to the code.

## Commands and keys

| Input | Effect |
| --- | --- |
| `/persona` | anyone: an info notice `Persona: <template> · version <n>` (`custom (edited)` after an owner edit); offline it is refused |
| `/persona style` | the Me screen (`Me`, see Persona), `Esc` back |
| `/persona template <id>` | owner: `persona.setTemplate` through the step-up (the PIN prompt opens when the core asks); toast `Persona: <template> · version <n>.`. `<id>` is one of `butler`, `friend`, `professional`; any other id is a usage line. A member's call is refused by the core and the core's message is the error toast |
| `/persona edit` | owner: opens Manage on the Persona section (see Persona); a member is told `Only the owner edits the persona.` |
| `/new` | the next front context (`chat.newContext`, flush first): the memory flush runs, then the chat starts empty and shows the divider `new context`; toast `New context started. Memory, persona and style are kept; this conversation's context is cleared.` A refusal is a warning toast with its reason in words: `a turn is still running`, `an approval is waiting`, `a task is still running`, or, when the flush failed, `Could not save to memory, so nothing was changed. Try /new again later, or /new --no-flush to start fresh without saving.` Offline it is refused (`packages/app-model/src/context-commands.ts`) |
| `/new --no-flush` | the same reset with no memory flush; the toast adds `Nothing was saved to memory first.` Any other argument is the usage line `Usage: /new · /new --no-flush` |
| `/compact` | shortens the current context (`chat.compact`, the same generation); toast `Context compacted. Memory, persona and style are kept; older messages are summarised.` When `flushed` is false (no flush ran: not configured, or nothing to drop) the toast adds `Nothing was saved to memory first.`; a running turn refuses it with `a turn is still running`; a flush that failed or was skipped refuses it with `Could not save to memory, so nothing was compacted. Try again later.`. Any argument is a usage line. While it runs the chat shows `compacting the conversation…` and holds a plain message (see Chat below); when it ends the stored marker shows as the divider `conversation compacted`. After 3 minutes without an answer the client gives up (warning `Still working in the core. Check again in a moment; your messages are not held any more.`, the hold is released; `chat-context.md`, "TUI") |
| `/room` | the active room's view (`features/room`, tui-design 5.21); with no room but an invitation, Home (its notice takes `enter` and `d`); else a line that says how to start one |
| `/room start <user> [<user>…]` | `rooms.start` with those usernames (the core resolves them); opens the room. A refusal, such as no `rooms.start` capability, is an error toast with the core's words |
| `/room invite <user>` | `rooms.invite` into the active room; toast `Invited <user>.` |
| `/room leave` | `rooms.leave` the active room; toast `You left the room.` |
| `/room remove <user>` | opens the room view with `Remove <user> from the room? [y] [n]` in the bar; the call runs only on `y` (after `tab`) |
| `/room end` | opens the room view with `End the room "<name>"? [y] [n]` in the bar; the call runs only on `y` (after `tab`) |
| `/tasks` | task list screen: `↑↓` select, `Enter` detail, `s` then `y` stops a running task via `rpc.tasks.stop` (any other key cancels; the legend reads `stop this task?  [y] yes  any other key cancels`), `Esc` back |
| `/manage` | the Manage screen (see Manage), `Esc` back |
| `/nodes` | node list (read only), `Esc` back |
| `/dream` | (P35, ADR-0031 §5, §8) the person's memory dreaming: mode, last run, a staged plan and an undo as an info notice (`statusRowsOf`, `packages/app-model/src/dream-state.ts`); the Me > Memory screen shows the same with the diary |
| `/dream now` | a manual run (`dream.now`, `too-soon` applies); on the chat screen the outcome is the chat's divider (`dream finished · …`, "Dreaming" below), elsewhere a toast names it (`applied`, `staged`, `skipped`, `failed`, `rejected`); refusals are warning toasts with their reason in words (`too soon, the last run is less than 20 hours old`, `not enough new messages`, `no model for the cortex role`, `over the budget`, `a turn is still running`, `dreaming is off; turn it on with /dream mode propose`). |
| `/dream apply` | applies the staged plan of the last `propose` run (`dream.apply`); without one the toast is `No staged plan to apply.`; the refusal `staged-changed` is a warning toast, and the plan is dropped (the next dream plans again). Only the person's own call applies a plan |
| `/dream undo` | restores the files of the last applied or `auto` run (`dream.undo`) while the 7-day undo lasts; a file changed after the run wrote it is kept and the toast says `kept <file>: it changed after this dream.` (a warning); `nothing-to-undo` is a warning toast |
| `/dream mode off`, `/dream mode propose`, `/dream mode auto` | sets the person's own mode (`dream.mode`, no step-up); the toast is `Dreaming mode: <mode>.`; any other argument is the usage line `Usage: /dream mode off · propose · auto` |
| `/budget` | budget screen (read only, see Screens), `Esc` back |
| `/presence` | the Presence screen (see Screens), `Esc` back |
| `/busy [30m\|2h] [note...]` | sets the person's manual status to busy (a duration of one minute to 24 hours, else until `/free`) through `presence.setStatus`; the reply says `Busy until 14:30 · note.` or the usage. Offline it is refused |
| `/free` | clears the manual status; the reply is `You are free.` |
| `/whoami` | an info notice in the conversation (see Identity) |
| `/login` | the Sign in screen (see Screens); `Esc` back |
| `/logout` | the Sign out panel over Home (ADR-0019): asks first, then revokes this device's credential, forgets it and shows the signed-out Home, whose sign-in panel is the way back in |
| `/stepup` | open the step-up prompt (see Step-up); not in the `/` hint row (it would not fit 88 columns) |
| `/connect`, `/providers`, `/model`, `/pair`, `/budget <x>` | an info notice with the `keith-core` command (see Moved commands) |
| `/continue` | after an interrupted turn: `session.continueTurn()` sends the continue message. With nothing interrupted: toast `No interrupted turn.` |
| `/retry` | after an interrupted turn: `session.retryTurn()` regenerates the interrupted reply (same toast when nothing is interrupted) |
| `/brain trace` | trace screen |
| `/brain` | toggle the Brain panel |
| `/help`, `/quit` | |
| `/` at the start of the draft | a row of the matching commands above the input; `Tab` completes when exactly one matches |
| `Enter` | send |
| `Shift+Enter` | adds a newline where the terminal speaks the Kitty keyboard protocol (kitty, WezTerm, Ghostty, foot, Alacritty, recent iTerm2 and Windows Terminal; `cli.tsx` asks for it with Ink's `kittyKeyboard`, mode `auto`). `Alt+Enter`, `Ctrl+J` and `\` then `Enter` add a newline in every terminal (Terminal.app cannot tell `Shift+Enter` from `Enter`). The legend names `[shift+enter]` only once the terminal has shown the protocol (its reply to the query, or a `Shift+Enter` Kitty sequence; `platform/terminal-input.ts`), else `[ctrl+j]`. A paste keeps its newlines and is never sent |
| `/mouse [on\|off]` | the wheel on or off for the session (no argument toggles). Off restores the terminal's own text selection and copy; on, `shift` (or `alt`) + drag still selects. `/help` says so |
| `Tab` | (a `legacy` approval waits in the chat, or the Inbox screen is open) the keys go to the approval dialog: `y` `n` `N` `a`, `Tab`/`Esc` back. A `conversation`, `device` or `other` request never takes it in the chat |
| `Ctrl+B` / `Ctrl+T` | show or hide the sidebar / the Tasks panel |
| `Ctrl+O` / `Ctrl+P` (`[` `]` on Home) | hidden: narrower / wider orb cells, 0.02 a step, for the session |
| Mouse wheel / `Alt+↑` `Alt+↓` / `End` | scroll the conversation 3 lines a notch / one line / jump to the latest message (sending does too); every scroll view (Help, Trace, Tasks, ...) takes the wheel and the keys. Scrolled up in the chat a pill `↓ latest [end]` shows (`↓ new messages [end]` when something arrived); a page with more below says `↓ more · scroll`. `PgUp` / `PgDn` (half a viewport) still work but are listed nowhere |
| `Esc` | one meaning per state. In the chat: while a turn runs, stop it (nothing else); while idle, go Home. On Home: while a turn runs, stop it; idle, nothing (the menu: close it). On Tasks, Manage, Help, Nodes, Budget, Presence and Brain trace: back to where it was opened from (Home or the chat) |
| `Ctrl+G` | go Home from the chat at any time, busy or idle; a running turn keeps streaming in the background and Home shows it (live orb, subtitle, approvals) |
| `Ctrl+C` | quit |

**Terminal input** (`platform/terminal-input.ts`, installed by `cli.tsx` before Ink renders). Ink has no mouse API and
keeps its Kitty state private, so the app reads the bytes first: it wraps `process.stdin.read` (Ink reads with `read()` in a
`readable` listener; an extra `data` listener would make the stream flow and starve Ink), strips SGR mouse reports from what
Ink gets, turns wheel notches (`ESC[<64;x;yM` up, `ESC[<65;x;yM` down; other buttons, motion and clicks are dropped) into
`emitWheel(±3)` for every active `ScrollView`, and notes the terminal's answer to Ink's `ESC[?u` query or a `shift+enter`
Kitty sequence (`kittyKeys`, which picks the newline hint). SGR mouse reporting (`ESC[?1000h ESC[?1006h`) is switched on at
start and off (`ESC[?1006l ESC[?1000l`) when the app ends, on `exit` (normal end, uncaught error), `SIGINT`, `SIGTERM`,
`SIGHUP`, and before the terminal is handed back; the terminal is never left in mouse mode.

## Data sources

- **Feed**: `client.feed()` (one eharness `ActivityFeed` per client) is started by `useActivity` in
  `App` and stopped on unmount. Each record goes through `brainEventOf` (brain panel and trace) and
  `taskChangedOf` (`task-changed`, payload `{ task }`, tasks panel). Other records are ignored.
- **RPC**: `rpc.tasks.list({ active: false, limit: 20 })` loads the board at mount and on every
  feed resync (`subscribeResync`: first connect, a reconnect, `resync` frame, new boot id, poll
  gap), because the feed sends no history. `nodeChangedOf` (`node-changed`, payload `{ node }`)
  updates the node registry, loaded by `rpc.nodes.list()` at mount, on resync 
  (an event that arrives while a list request is in flight wins over its response).
  The approvals come from `client.attention()` (`useApprovals`, read at mount). Rows merge by id and the newer `updatedAt` wins, so a
  slow list response never undoes a newer `task-changed`. `rpc.tasks.stop({ id })` stops a task and
  the board reloads. The header also reads `rpc.health.get` and `rpc.models.roles.get`.
- **Chat**: `eharness/client/react` `useChatSession` with `@ai-sdk/react` `useChat`, `clip:
  CHAT_CLIP`, and `client.attachChat(session)` in an effect (reconnect wiring, `client.md`). The session's `notify` shows the toast and calls
  `client.reportChatNotice` so a send cut before the first words re-attaches; when the session
  follows again the toast reads `reconnected` and goes when the turn ends. An effect calls
  `session.refreshBusy()` when the chat status changes.
  While the chat is busy (`state.busy`) `session.checkStalled()` runs every 3 s. When the
  conversation ends on an assistant message of stop `interrupted` (a core restart cut the turn)
  and no turn runs, a one-line warning notice (`The previous turn was interrupted: its process stopped before it
  finished.`) shows above the input (not repeated when the stored `eh.notice` of that turn is already the
  last row of the conversation; `/continue` and `/retry` stay listed in `/help`, not on screen); a failure of a turn the chat follows
  (`state.problem`) shows as an error notice. Tool parts of an assistant message render as lines under it
  (`packages/app-model/src/tool-view.ts`, `tui-design.md` 5.5); the conversation keeps the last 200 messages mounted.
- **Identity**: `rpc.auth.whoami()` at mount and on every resync (see Identity).
- **Budget**: `rpc.budget.get()` at mount, on every `budget-changed` record, on resync and every
  60 s (`budgetPollMs` prop in tests); the header and `/budget` read the same state. A failed read
  keeps the last value.
- **Connection**: `useConnection` (`{ kind, notice, loggedOut }`) reads `client.feed()` as a store (`useStore`); the
  app adds `offline` when the identity call failed and the feed is not live.
- **Hippocampus**: the brain panel counts `brain.hippocampus.write` and `.recall` like any region
  (their payload carries `region: 'hippocampus'`); the last line reads `hippocampus create
  /memories/profile.md` or `hippocampus recalls /memories/profile.md` (cut at the panel width).

## Fake core (tests)

`src/testing/fake-core.ts` (types and `MEMBER` in `fake-core-types.ts`, the step-up half in `fake-step-up.ts`) serves `/sessions/*`, `/rpc/*` (handlers by path in the `rpc` option; a handler that throws becomes an oRPC 500),
`/attention` (the `attention` option / `core.attention` array) and `POST /attention/:id/answer`
(recorded in `core.answers`, removes the item; `core.failAnswers(status)` makes it fail),
`/health`, `/activity` (page) and `/activity/stream` (SSE: `retry`, `: connected`, `event: boot`,
then `id:<seq>\nevent:<type>\ndata:<record json>`). `core.emit({ type, payload })` appends a
record and pushes it, `core.resync()` sends a `resync` frame, `core.streams()` counts open
streams (wait for it before `emit`: a feed delivers no history). Resilience: `core.dropNextAnswer(n, until?)`
errors the next chat response after `n` words, holding the cut until `until()` is true (at most
10 s; tests pass "the first words are on screen": a client that sees the drop before it made the
assistant message does not re-attach) (the turn then "runs" on the core, snapshot
`running`, until `GET /chat/stream` has replayed the whole answer and stored it; Bun prints the
stream error to stderr, that is expected), `core.reboot(id)` sends `event: boot` with a new id
(also served by `/health`), `core.feedDown(true, status?)` closes the activity streams and refuses
new ones and the polling fallback (503, or 401 for `unauthorized`), `core.setRunning(bool)` sets the snapshot,
`core.pushHistory(message)` stores a message, `core.chats` records every `POST /chat`
(`trigger`, `messageId`, `text`). Presence: the `presence/*` procedures are built in (`testing/fake-presence.ts`) with the `presence: { mine }` option as the start state; `core.presence` records every `registers`, `heartbeats`, `goodbyes`, `acks`, `statusSets` and `disclosureSets` call and holds `state`. `setupApp({ presenceHeartbeatMs })` shortens the heartbeat for tests. Budget: `rpc` `budget/get` and `auth/whoami` (owner, tcp, token) are built in
(`budget` option for the start state; an `rpc` entry overrides either) and `core.spend(usd)`
adds spending and emits `budget-changed`. `whoami` (overrides of the answer; `MEMBER` is a member), `stepUp` (`required`: attention answers and `tasks/stop` are refused with `KEITH_STEP_UP_REQUIRED` until `POST /auth/step-up` got the PIN `1234` or `password`; `fail`: `throttled`, `no_method` or `legacy`; `core.stepUps` records the bodies; every procedure the contract marks `stepUp` is refused too, through `isSensitive` in `fake-admin.ts`) and `waitingForOwner` (item ids whose answer is refused with `KEITH_WAITING_FOR_OWNER`) options. `budget` takes `scope` and `people`. `core.revoke()` makes every call but `/health` answer 401 and closes the streams (a revoked credential), as the real core now does for every open stream of a revoked, suspended or changed person (`thalamus.md`, Open streams). `testing/fake-admin.ts` (`createFakeAdmin()`) answers the admin procedures (people, devices, tokens, nodes, providers, models, access, budget set, audit) from small tables and records every call with its input (`admin.inputs('admin/people/add')`); pass it as `admin`. `testing/setup-app.tsx` renders
the App on a fake core for the feature tests (`columns`, `rows`, `theme`, `admin`, `start: 'manage'` options); `testing/manage-helpers.ts` has the keys and `openSection`, `selectRow`, `runAction`, `type`; `testing/fixtures.ts` has `task`,
`node` and `approval` builders, plus `waitingApproval` (a member's owner-routed request) and `askedByApproval` (the owner's view of a member's request).

## Tests

Tests render with colour off and the spinner static (`depth: 'none'`), so a frame is plain text; they assert
structure and text (rows, glyphs, order, truncation, which hints show), never colours. `testing/render.ts` is
`ink-testing-library`'s harness with a terminal size you choose; `testing/setup-app.tsx` renders the `App` on the
fake core at a given `columns` x `rows`. Run `bun test ./apps/tui/src/<file>` from the repo root, one file at a time.

- `platform/config.test.ts`: the old settings, plus `KEITH_THEME`, `COLORFGBG` (`15;0` dark, `0;15` light, missing
  dark), `NO_COLOR` set versus empty, `COLORTERM`, `TERM`.
- `ui/theme.test.ts`: tokens per depth (hex, `ansi256(n)`, the 16 names, none: no colour prop) and WCAG AA contrast.
  `screens.test.tsx` (every framed screen at 60, 80, 100 and 120 columns: no row wider than the terminal, one legend without `…`), `dialogs.test.tsx` (a dialog that has the keys lists them once, on the chat and on Home), `app-hints.test.ts`.
  `ui/components.test.tsx`: every ui component (glyph widths, StatusLine states, KeyHints and their fitting, Message, ToolLine, Notice), `ui/frames.test.tsx` (Surface, FramePanel,
  Dialog, Block, Panel, ListRow, Badge, PulseGlyph, Screen) and `ui/screen-frame.test.tsx` (ScreenFrame: margins, title row, legend);
  Markdown, ScrollView and TextInput have their own files.
- `features/home/home-state.test.ts`, `menu-state.test.ts`: orb mode, sizes, event strengths, markdown to plain
  words, the menu items and their summaries (Overview's connection, Budget's `!`), `orb-flight.test.ts` (the flight's boxes), `chat-orb-box.test.ts` (the chat end of the flight, wide and small),
  `platform/cell-size.test.ts` (reply parsing, garbage, partial and timeout, clamping, `[` `]` steps, a fake TTY) and
  `chat-header.test.tsx` (header at 100x30 and 120x40, absent at 70x30 and 100x18, a lit region, the hints on the rule,
  the flight with colour). `features/home/home.test.tsx`: the title, legend
  and orb word; the menu (`space`, `down`, `enter`, `esc`, `right`); the live detail; the chat and back; the member's
  menu; an approval on Home; logged out and core down (panel, no chat, the exit message; at 80, 100 and 120 columns no row is
  wider than the screen and the frame's borders are whole); below 60 columns.
- `layout.test.ts`: 59, 60, 99, 100, 159, 160 columns and 19, 12, 11 rows. `sidebar.test.ts`: the panel heights.
  `states.test.tsx`: connecting, offline, logged out at start, the header at each width, the footer by context,
  20/19/12/11 rows, sidebar widths 32 and 40, the conversation filling the room beside the sidebar.
- `brain-state.test.ts`: lamp lit then idle by timestamp, cortex count over several tasks, the one-line
  description, trace cap of 50, view key stability. `packages/app-model/src/tasks.test.ts`: merge by `updatedAt`, elapsed format,
  `task-changed` parsing. `nodes-state.test.ts`: `node-changed` parsing, order and counts, merge with events during a
  fetch, last-seen and countdown formats. `budget-state.test.ts`: header text (wide, compact, tone), period, rows.
- `packages/app-model` (docs/specs/app-model.md; the chat's pure logic moved there with its tests) and `features/chat`: `message-text.test.ts` (items, order of text and tools, notices, proactive, stopped),
  `tool-view.test.ts` (tool states, 3 output lines, delegations), `slash.test.ts`, `chat.test.tsx` (tool lines,
  notices, thinking, scrolling, `/` hints and tab, multi-line, paste, the empty and no-model states).
- `panels.test.tsx`: the Brain and Tasks panels, the tasks screen (list, detail, failure, stop), `/brain trace`,
  `ctrl+b`, `ctrl+t`, `/brain`, proactive dots, the sidebar at 100 columns and the strip at 99.
  `features/approvals/*.test.*`: the dialog rows, `y n a N`, focus, failure, `askOf`; `consent.test.tsx`: a `conversation` request has the quiet line and no bar, a `device` one has the line, the toast and the bar only in `/inbox` after `tab`, the empty Inbox. `features/nodes/*.test.*`:
  `/nodes` read only, the panel, resync. `budget.test.tsx` (header, `/budget`, the Hippocampus lamp),
  `server-turn.test.tsx` (a wake turn the core starts shows in an idle chat, several in a row),
  `resilience.test.tsx` (dropped answers, restarts, interrupted turns, the connection in the header),
  `app.test.tsx` (help, moved commands, `/whoami`, the session id, logged out, under 60 columns).
- `manage.test.tsx`: the sections per role, the two layouts, `/manage` and `?`. `manage-look.test.tsx`: the look (plain list, framed pane with `n/N`, glyph statuses, one legend, a dialog as its own frame) and that no row is wider than 60, 80, 100 and 120 columns for any section and the legend never has `…`. `manage-actions.test.tsx`: every action calls its procedure with its input, hidden secrets, shown-once dialogs, confirms, errors and the step-up retry. `manage-plugins.test.tsx`: the Plugins section (list, details, disable and enable with the restart note, a failed plugin, the step-up retry), the Reviews section (the payload as data, show, approve, deny, the step-up retry) and the plugin capability in the grant picker. `manage-groups.test.tsx`: the Groups section (list, create, add and remove a member, delete and the refusal of a group in use, the step-up retry) and the audit retention on Access. `features/manage/*.test.ts`: the section list per role. The section models, row builders, dialog state, navigation and Logs formatters live in `@keith/app-model/manage` with their tests (docs/specs/app-model.md); the sections are read through `useSectionModel`. `manage-protocols.test.tsx`: the Protocols section (a member's rows, the owner's `OWNER` column, the widths at 80 and 120, the reminder form, pause and resume, delete asked first, confirming a proposal); `features/manage/protocols/*.test.ts`: the cells, the proposal rows, the details note and the reminder ladder builder.
- `people.test.tsx`: the role tag in the header, `/whoami`, the step-up prompt (opens on the refusal, masked PIN, one retry,
  wrong PIN, esc, `tab` to the password, throttled, no method, old token, `/stepup`), the owner's `askedBy` dialog, a
  member's read-only waiting item, `KEITH_WAITING_FOR_OWNER`, `/budget` per role, a member's node refetch (timer and
  `/nodes`), `/help` and moved commands per role. `login-password.test.ts`: the text `keith login` method selection and the
  password flow (success, wrong, throttled, not allowed here, piped stdin, usage errors). `login-screen-choice.test.ts`: which `keith login` invocations open the Sign in screen and which stay text.
- `connection.test.ts`; `commands.test.ts` (`fakeIo`, a `Bun.serve` fake core: login waiting and result text,
  expired, denied, cancelled, `--token`, logout, whoami); `cli.process.test.ts` (the real entry).
- `cli.pty.test.ts`: a real pseudo-terminal (`Bun.spawn({ terminal })`, never `expect ... sleep`) against the fake
  core; the screen is rebuilt from the output by `testing/vt-screen.ts` (Ink redraws only what changed, so the raw
  stream holds no whole line). Chat and streaming, the sidebar at 120 columns and the strip plus `ctrl+b` at 80,
  dropped answers, logged out, `/quit` leaving the alternate screen, the approval with Tab and `y`, the whole flow under `NO_COLOR` (chalk forced on, no
  colour code in the output) the dark theme painting in truecolor and a member stepping up with the PIN (refused answer, prompt, retry, `elevated 9:` in the header).
- `cli.manage.pty.test.ts`: `keith manage` in a pseudo-terminal: the owner opens Groups, creates a group and adds a member with the keyboard (fake core with the groups procedures in `testing/fake-admin.ts`). `cli.plugins.pty.test.ts`: the owner disables a plugin and approves a held reminder from the keyboard (the fake core also answers `admin.plugins.*`, `admin.reviews.*` and `admin.capabilities.list`).
- `identity-grant.pty.test.ts`: a real core and an open member TUI: `/manage` lists no People row; the owner's `keith-core people grant <member> people.manage` shows the row in the same process (no restart, `identity.changed`), and `revoke-grant` removes it again.
- `cli.login.pty.test.ts`: `keith login --core <url>` in a pseudo-terminal opens the Sign in screen; against a fake core with no `/auth/identify` (an older core) the test types the identifier, then the password inside the app, lands on Home signed in, and the raw terminal bytes never contain the password. `cli.signin.pty.test.ts`: a signed-out Home against a fake core with the identifier-first routes (`testing/fake-flow.ts`): identify, the PIN, Home signed in; the password where the PIN is refused; the plain-HTTP warning on `lan` and absent on `loopback`; `esc` one step back, a made-up name with the same panel and the same failure; the raw bytes never hold the PIN or the password. `cli.nocore.pty.test.ts`: no core found opens the Sign in screen on the default address (nothing past it depends on what listens there), and the address changed to a fake core goes through who, the PIN and Home signed in. `home-login.test.tsx` (app level, the same panel): box, PIN, tab to the password, refused PIN with the reason, the lan warning, a decoy identifier looking the same, throttle, `esc`, an older core, the device code tab.
- `testing/frames.test.ts`: the gate frames, written when `KEITH_FRAMES_DIR` is set (`tui-design.md` section 8).
