# TUI: the Sign in screen

Contract of `apps/tui/src/features/login/` (P13, ADR-0013). It renders the sign-in controller of
`@keith/client` (docs/specs/client.md, "Sign-in controller") one step at a time. This file is the detailed
contract (props, keys, secrets, wiring); the look of the whole flow is tui-design.md 5.13, and which `keith login`
invocations open this screen is in tui.md. The app wires it in `app-session.tsx`.

## Public surface

`features/login/index.ts` exports `LoginScreen`, `LoginScreenProps`, `LoginResult`, `LogoutScreen` and `LogoutScreenProps`; nothing else.

```ts
interface LoginScreenProps {
  signIn: SignIn                 // the controller, injected; the screen never builds or disposes it
  initialCore?: string           // used when the controller's address is empty
  onDone(result: LoginResult): void   // { core, person? }: swap the connection to `core`
  onCancel(): void               // esc on the address step
  columns?: number               // default 100, at least 60 (layout.ts MIN_COLUMNS)
  now?: () => number             // clock of the countdowns (default Date.now)
  tickMs?: number                // countdown tick (default 1000)
  doneMs?: number                // how long "signed in" stays before onDone (default 700)
}
```

`onDone` fires once per `done` state, after `doneMs`, and also when the user continues on the `socket`
step (`{ core: <socket address> }`, no person). The screen does not touch `client.json`: the controller
saves the credential before it reaches `done`.

## Steps and keys

One component per controller `step`; a step change mounts fresh fields (nothing carries over).

| Step | Shows | Keys |
| --- | --- | --- |
| `address` | text field with the address, the controller's `problem` as `✕ ...` (a `Notice`) | enter check (`submitAddress`), esc `onCancel` |
| `checking` | spinner, "asking the core ..." | esc `cancel()` |
| `socket` | "The local socket needs no login" | enter `onDone`, esc `onCancel` |
| `identify` | (the Sign in screen: core and `Keith <version>`; Home's panel: neither) one box `who` (placeholder "id, username, email or phone", pre-filled with the identifier remembered for this core), the `problem` as `✕ ...` with a live countdown when throttled | enter `submitIdentifier`, esc `back()` (inside Home's panel: nothing) |
| `working` | spinner, "asking the core ..." (before the methods) or "signing in ..." | esc `cancel()` |
| `flow` | (the Sign in screen: core and the identifier; Home's panel does not echo it) the methods as tabs (`[PIN]` on screen in the accent, a refused one with `!` and, when on screen, "not available here: <reason>" and no field), the step's `help`, one `Field` per `current.fields` (masked for `secret`, and for any field with `mask`; `digits` keeps digits only), on `lan` next to a secret the warning `! plain HTTP on this network: others on it could read what you type`, the `problem` as `✕ ...` with a countdown when throttled | tab / shift+tab `chooseMethod` (the core's `default` is on screen first), enter on a field moves to the next one and on the last submits (`submitStep`), enter on a poll method (device code) asks for a code, esc `back()` |
| `device` | the approve command `keith-core devices approve <CODE> --label <name>`, the code in spaced letters (`K T P W - 4 C 7 M`), "waiting for approval", live "expires in N minutes" (seconds under a minute, then "expired") | esc `cancel()` (back to the `flow`) |
| `error` | `✕ <message>` (a `Notice`) for a failed health check | enter `retry()`, esc `back()` |
| `done` | `✓ signed in as <name> (<role>) on <core>` | none |

The screen has no code per method: the tabs, the fields and the help text come from the core's `MethodDescriptor` (client.md,
"Sign-in controller"), so a method that uses text or secret fields (TOTP later) needs no change here. The pieces are shared with
Home's login panel: `sign-in-body.tsx` (one controller state as a component), `login-form.tsx` (`IdentifyStep`, `FlowStep`),
`use-sign-in.ts` (the state hook, the countdown clock, the `done` timer).

Each step sets the one legend of the screen with `useFooter` (`[key] label` pairs, no `…`); the `ScreenFrame` draws it at the bottom. An expired or denied device code returns to the `flow` with the reason as its `problem`: enter asks for a new code.

## Home's login panel

`LoginPanel` (`login-panel.tsx`, exported by `features/login/index.ts`) is the same controller drawn inside a `FramePanel` labelled `Sign in`
for the signed-out Home (tui-design 5.16): `{ signIn, width, onDone, now?, tickMs?, doneMs? }`. It renders `SignInBody` with `embedded`: there is
no address step (the host starts the controller with `submitAddress(core)`, so it lands on the identifier box), `esc` on the box does nothing
(nothing is behind it) and `esc` on a method goes back to the box with the identifier kept. The keys, the countdowns, the masking, the LAN warning and the
failure wording are exactly those of the table above. The step's legend (`useFooter`) is drawn by Home in its legend row. `app-session.tsx`
(`LoginPanelHost`) owns the controller (`createSignIn({ address: core, store, remember })`) and disposes it when the panel goes; `onDone` is the
app's `signedIn`, the same as for the Sign in screen.

## Remember this device, and a saved login that is not used

**Remember this device.** On the `flow` step of a method that can be remembered (`signIn.canRememberDevice()`: a PIN or password answered through the
flow routes; never the device code, a pasted token or the socket) and only when the host passes `offerRemember` (`LoginPanel`, `LoginScreen`;
`FlowStep`), a single row under the fields reads `[ ] remember for 30 days  (ctrl+r)` and nothing else;
`ctrl+r` ticks it (`[x]`, accent).
Default **off**; the legend gains `[ctrl+r] remember`. The choice goes to the controller (`setRememberDevice`), which asks the core for a 30-days-idle
session and hands the store `{ core, token, remember: true }`. The app's store (`appStore`, `app-session.tsx`) always puts the credential in memory
(`session-vault.ts`) and writes `client.json` only with `remember: true`. The socket panel never offers it: a socket session is per process (above).

**A saved login that was not remembered.** Over the panel (`LoginPanelHost`, `SocketSignIn`) and the screen (`LoginHost`), `LegacyLoginNotice`
(`legacy-login.tsx`) shows one compact box on the `user-message` fill, muted, a single sentence that wraps by itself (`An old saved login (from before sign-in existed) is not used. Sign in below, or press ctrl+f to forget it.`) when `client.json` holds a login without `remember: true`. `ctrl+f` revokes it on the core (3 s at most, `forgetSavedLogin`), deletes the
file and removes the box, showing `The old saved login is forgotten.` as a success toast. It is the only action; nothing is deleted at start. No notice for a remembered login.

**Layout.** The login block is centred on the same axis as the orb and the legend. The panel is `min(available, 46)` cells wide (`loginPanelWidth`; compact: no blank rows between the identifier box, the tabs, the fields and the remember row), the
notice and the hint wrap inside that width and are centred as a block; rows inside the frame wrap, never widen it.

## The guest row

Under the panel, on a signed-out Home of an http core, `LoginPanelHost` draws `GuestEntry` (`features/guest/guest-entry.tsx`) when the core's guest listener says guest chat is available: `or continue as an anonymous guest  ·  [ctrl+g]`; `ctrl+g` opens the guest screen (`tui.md`, "Guest mode"). The status is `GET /guest/status` on the same host at the default guest port, asked once when the panel mounts; any failure, `enabled: false` or `available: false` draws nothing and takes no key. The Sign in screen (`LoginScreen`) has no guest row, and the socket panels never do.

## The locked socket

When the core answers `423 locked` on the local socket (`auth.md`, The local socket), `useWhoami` reports `{ status: 'locked' }` (it
asks again whenever the activity feed starts to reconnect, because a locked socket refuses the feed). Home then draws
`UnlockPanel` (`features/login/unlock-panel.tsx`) in the same place as the login panel: a `FramePanel` labelled `Locked`,
one masked PIN field (digits only), `enter` unlocks, a refusal shows one line (`wrong PIN`, a countdown line for a throttled
answer) and the field is cleared before the call returns, so the PIN is never in a state or a frame. `app-session.tsx`
(`UnlockPanelHost`) calls `unlockLocal`; on success the app swaps to a fresh connection on the same socket
(`switchConnection`, caption `unlocked`) so the feed and every read start clean. Any other screen goes back to Home while locked.
The panel mounts only for a socket connection (`swappable.kind === 'socket'`). `keith lock` and `keith unlock` are in `tui.md`.

## The socket that needs a session (`local trust: none`, the default)

Every party that talks to Keith is a signed-in User (ADR-0014 amendment of 2026-11-09), so with the default trust level `none` the socket
answers `401` until a session exists and a signed-out Home on a socket connection shows the same login panel as for an http core:
`SocketLoginPanelHost` (`app-session.tsx`) runs the same controller through `socketFetch(path)` (base `http://localhost`; the zone is
`loopback`, so the PIN is the default method and there is no LAN warning). **The session is per process and lives in memory only**: the
controller's store keeps the credential in the panel host and, on `done`, the app swaps to a socket connection that carries it
(`Connection.token`, in the state of `AppRoot`). Nothing is written to disk (no `socket-session.json`; `resolveConnection` deletes one left
by an earlier version, unread), so closing the TUI, ctrl+c or `/logout` ends it and the next `keith` start asks again. A visitor in the same OS
account cannot inherit a session by reading a file. Only the identifier is remembered (`client-state.json` next to `client.json`, never a secret),
as a convenience. `/logout` on such a connection revokes the session on the core, drops it from memory and the panel asks again: that is the
switch-user path (Duta signs out, Vian signs in). Home opens with `signed in as <name>` in the caption slot. The chat's
logged-out `enter` and `/login` go to Home on a socket (the Sign in screen is for a core with an address).

### The first owner (`FirstOwnerPanel`)

`keith-core setup` gives the owner a PIN and/or password, so this is the fallback for an install that is set up but has neither. Before the
sign-in panel mounts, the host asks `GET /auth/local/status`; when `needsFirstOwner` is true it shows the `First sign-in` panel instead: one masked
PIN field, then `Again`, digits only. A mismatch starts again with `the PINs differ: start again` and sets nothing; a match calls
`POST /auth/local/first-owner { pin }` (`setFirstOwner`), whose answer is a session, so Home signs in at once as the owner. The core allows this only
while the owner has no PIN and no password, only over the socket, once, and audits it (`auth.first_owner`, `docs/specs/auth.md`); a `409 closed`
turns the panel into the normal sign-in. A core without the status route (an older one) gets the normal sign-in.

## Secrets

- The PIN, password and token live only in the field being typed (a React state of that step). The
  controller never holds them either.
- A secret field draws one `•` per typed character while focused and a constant `••••••••` when not
  focused; the real text is never rendered.
- After a submit the field is cleared before the call returns; the step then changes, which mounts new
  fields. An empty password or token is not sent.
- Tests assert that no frame, at any time, contains the typed secret.

## Looks

The screen is a `ScreenFrame` (tui-design 5.18) labelled `Sign in`: one blank row on top, the title row
(`K E I T H`, the `Sign in` tag), the step in a 2-column margin, then the legend and one blank row at the bottom.
Drawn only through `@keith/ui` (`ScreenFrame`, `FooterProvider`/`useFooter`, `Field`, `TextInput`, `ListRow`,
`Notice`, `PulseGlyph`, `Txt`, `G`); no colour string, no filled background. The selected method row is `▸` in
the accent with a bold label; a busy step is the pulsing `✳` (`PulseGlyph`) and its muted text. With `NO_COLOR`
every state keeps its words and glyphs (`✓`, `✕`, `◐`, "not available here", the countdown text). The spaced
code is bold text indented under the command. At 60 columns long cores, commands and reasons wrap.

## How the app uses it

`app-session.tsx` (`SessionScreens`) draws the screen for `App` when its `screen` is `login`:

```tsx
const signIn = createSignIn({ address: core, store: { write: (c) => writeClientConfig(c, configPath) } })
<LoginScreen signIn={signIn} initialCore={core} onCancel={back} onDone={signedIn} columns={width} />
```

- The app creates the controller when the screen opens (one per opening) and calls `signIn.dispose()` when it closes.
  `core` is the current core as the user named it (`unix:<path>` starts on the `socket` step).
- `onCancel` returns to the screen it was opened from (Home or the chat; Home for `start: 'login'`).
- `onDone({ core, person? })` builds the new `Connection` from what the controller saved (`signedInConnection`, the same
  rules as `--core <core>`; the socket saved nothing) and calls `switchConnection(next, { notice })` of the app root
  (docs/specs/tui.md, "The app owns its connection"): the whole app is rebuilt on the new client and opens on Home with
  `signed in as <name>` (or `signed in`) in the caption slot.
- Entry points: Home's `Sign in` panel (`enter`), the chat's logged-out block (`enter`), `/login`, `start: 'login'`
  (`keith login` on a terminal with no flag, which opens the app with `start: 'login'`; after `/logout`, which also uses `LogoutScreen` of this feature, as a Home panel (`panel` prop): `Sign out of <core>?`, `[y]` `[n]`).

## After sign-in: the privacy notice

Once per person, after the first successful sign-in on a TUI, Home shows the notice as a panel: `Your privacy` (`PrivacyPanel`, `features/identity/privacy-notice.tsx`, drawn by `homePanelOf` in `app-panel.tsx` over Home's lower orb, tui-design 5.16). Home stays drawn with its orb and wordmark; the panel is a `FramePanel` at most 46 cells wide, its text wrapped. It is never a bare screen (ADR-0019). The text is the core's (`AUDIT_PRIVACY_NOTICE_TEXT`, English, two sentences): the owner can read what you keep in Keith, and each time they look Keith writes it down, under Manage > Privacy. Key hint `[enter] got it`; `enter` calls `admin.audit.notice.ack` and the panel goes. The panel takes keys only while it is on screen and is the last panel in line: a sign-in, unlock or sign-out panel is drawn first. The app asks `admin.audit.notice.get` when it mounts (a sign-in rebuilds the app, so it asks again) and draws Home meanwhile; any failure (signed out, locked socket, offline, an older core) is "nothing to show", so the notice never blocks a person. The notice is shown on Home only: a person who lives in the chat sees it the next time Home is on screen, and it is acknowledged only when it was drawn. The seen state is per person on the core (settings key `notice.audit-privacy.<personId>` and an audit row `person.notice.seen`), so a second sign-in on another device does not show it again. The owner sees it once too.
