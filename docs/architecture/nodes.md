# Nodes

A Node is any process connected to the core through the public protocol ([contracts/protocol.md](../contracts/protocol.md)). No Node is special (I-8), and that includes the web client served by `@keith/web`.

## Kinds

| | Attended | Headless |
|---|---|---|
| Has a signed-in Person | yes | no |
| Opens Threads, sends input | yes | no |
| Typical capabilities | `chat.text`, `ui.render`, `audio.in/out`, `workspace` | `fs`, `screen.capture`, `notify`, `audio.in/out` (shared speaker) |
| Examples | TUI, web browser, mobile app | Rust system node on a home server (phase 7) |
| Auth | Person token | Node token from pairing (phase 7) |

A Node can be both: the phase-7 system node on the owner's laptop exposes `fs@1` and also lets the owner sign in.

## Capabilities

Declared in `hello` as `name@major` strings. The core offers only the features a Node declared.

| Capability | Meaning | Phase |
|---|---|---|
| `chat.text@1` | Sends `input.text`, renders `message.*` frames | 1 |
| `ui.render@1` | Renders standard UI blocks (`ui.render` frames) | 2 |
| `audio.in@1` | Streams microphone audio (binary frames) | 3 |
| `audio.out@1` | Plays assistant audio (binary frames) | 3 |
| `workspace@1` | Renders the workspace state | 6 |
| `notify@1` | Shows OS notifications | 7 |
| `fs@1` | Executes file tools on its machine | 7 |
| `screen.capture@1` | Provides screenshots | 7 |

Tool routing: a tool with `requires: ['fs@1']` executes on a Node that has `fs@1`, through `node.call` frames (phase 7). Until then, such tools are not offered.

## Connection lifecycle

```
HTTP  POST /v1/auth/login  ──►  { token, person }      (or POST /v1/auth/invite with an invite code, phase 5)
WS    GET  /v1/ws?token=…  ──►  upgrade
node  → hello { client, capabilities, nodeId? }
core  → welcome { nodeId, person, protocol, server }
node  → thread.open { threadId? }        (omit → the person's main thread)
core  → thread.opened { thread, messages }
      … input.text / message.* / thread.state / ui.render …
core  → thread.updated { thread } | thread.removed { threadId }   (phase 5, any time: the thread list changed)
node  → thread.close | socket closes     → detach, presence update
```

- `nodeId` is issued by the core on first `welcome`. Nodes should persist it and send it back in later `hello`s so the core recognizes the same device. The TUI stores it in `$XDG_CONFIG_HOME/keith/tui.json` (default `~/.config/keith/tui.json`), since it may run on a different machine than the core, and the browser stores it in `localStorage`.
- The core must receive `hello` within 5 s of upgrade or it closes the socket with code `4001`.
- Heartbeat: the core sends `ping` every 25 s and drops a node silent for 60 s (close `4010`). Any frame from the node counts as a sign of life, so a node answers `ping` with `pong`.

### How the core handles a connection

Implemented in `packages/core/src/server/`.

| Situation | Core behavior |
|---|---|
| `?token=` missing, unknown or expired | Upgrade, then close `4003`. An expired token is deleted. |
| No `hello` within 5 s | Close `4001` |
| Envelope `v` ≠ 1 or `hello.protocol` ≠ 1 | Close `4009` |
| Any other frame before `hello`, or a second `hello` | `error { INVALID_FRAME }`, connection stays open |
| `hello.nodeId` names a known node that is not connected right now | Reused. Otherwise the token's earlier node id is tried, then a new id is issued. Two live sockets never share a node id (two browser tabs with one `localStorage` get different ids) |
| `hello` accepted | `nodes` row upserted (name, capabilities), `auth_tokens.node_id` filled, `welcome`, then the [notices](../contracts/protocol.md#notices) (an owner node: one `warn` per plugin in state `failed`; a node that declared `audio.in@1` while there is no `[voice]` section: one `info`), then `node.connected` |
| `welcome` can't be built (fails validation) or sent | Close `1011` (the standard "internal error" code, as for any other handshake failure). No `node.connected` |
| `thread.open` | Arrival decided (see [core.md](core.md#presence-and-arrival)), `ThreadManager.open` (with `historyLimit`), node attached, then one `thread.opened` with the last `historyLimit` messages of what `open` returned |
| `input.text` / `input.cancel` for a thread this node has not opened | `error { FORBIDDEN }` |
| `input.text` from a node that didn't declare `chat.text@1` | `error { FORBIDDEN }` |
| `thread.close` or socket close | Node detached from the thread (or from all threads). The person becomes away when their last node detaches (`person.left`). `node.disconnected` on socket close |
| `<namespace>.*` frame registered by a plugin | Payload validated with the plugin's schema, then its handler runs |
| `audio.start` (phase 3) | `FORBIDDEN` unless the node declared `audio.in@1` and has the thread open. Then `VoiceInput.start`; a refusal (e.g. `opus` in v1) becomes `error { INVALID_FRAME, message }` |
| `audio.end` (phase 3) | `VoiceInput.end`; an unknown stream gets `INVALID_FRAME` |
| Binary frame (phase 3) | Header parsed with `decodeAudioFrame`. A kind-1 chunk goes to `VoiceInput.chunk`. A malformed header, a kind-2 frame, or a chunk of a stream this node hasn't started gets `error { INVALID_FRAME }`; the connection stays open |
| Any audio frame while voice is off (the server has no `VoiceInput`) | `error { INVALID_FRAME, "voice is not configured" }` |
| Unknown type | `error { UNKNOWN_FRAME }` |

Frames from one node, text and binary, are handled in order, so a chunk never overtakes its `audio.start`. Socket close also drops the node's open audio streams (`VoiceInput.detach`). The core sends audio to a node with `AttachmentRegistry.sendBinary`. A spoken input's transcript reaches the speaking node too, as `message.user` (see [voice.md](voice.md#turn-taking-with-voice)), and so does the input the core runs for a `ui.action` click; typed input is echoed only to the other nodes ([protocol.md](../contracts/protocol.md#delivery-rules)). `input.text` is handed to the ThreadManager without waiting for the turn, so a later `input.cancel` is not blocked. Errors thrown by the ThreadManager become `error` frames (`UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED` and `PROVIDER_ERROR` pass through, everything else is `INTERNAL`).

`AttachmentRegistry.send` follows the [delivery rules](../contracts/protocol.md#delivery-rules): a node that didn't declare `chat.text@1` in `hello` gets no `message.user`, `message.started`, `message.delta`, `message.completed` or `tool.activity` frames (the registry learns the capabilities in `connect`). The server takes the plugin host's `status()` (`pluginStatus`) and whether `[voice]` is configured (`voiceConfigured`, default: whether a `VoiceInput` is set) as optional construction options for the notices.

## Auth (phase 1)

- `keith setup` (interactive CLI) creates the **owner** Person with a username and password (Argon2id via `Bun.password`).
- `POST /v1/auth/login` returns an opaque random token. Its SHA-256 hash is stored with an expiry (`auth.tokenTtlDays`, default 30).
- HTTP uses `Authorization: Bearer <token>`. WS uses `?token=` because browsers can't set headers on upgrade.
- `POST /v1/auth/logout` deletes the token. A WebSocket already open with that token stays open; the token is checked only on upgrade.
- Tokens are 32 random bytes, base64url. An expired token is deleted the first time it is presented. A login for an unknown username still runs one password verification, so it takes about as long as a wrong password.
- `GET /v1/threads/:id/messages` answers `404 NOT_FOUND` for a thread the caller is not a participant of (the same as a missing one).
- The server binds to `127.0.0.1` by default. Remote access (Tailscale, reverse proxy) is the operator's job. Keith doesn't terminate TLS in phase 1.

> Planned (phase 7): node pairing for headless nodes (6-digit code shown in an attended node, exchanged for a node token).

## Adding people

> Planned (phase 5, P5-N1): accepting a link (`POST /v1/auth/invite`, the fourth bullet). The `keith person` commands are built. Rules: [ADR-0017](../decisions/0017-tier-rules-for-relays-and-group-threads.md).

- The owner adds a member or a guest on the host with `keith person add <name> [--tier member|guest]` ([config.md](config.md#keith-person)). It creates the person without a username or password, their relationship card and their main thread, and prints an **invite link**, `<publicUrl>/#invite=<code>`, plus `keith-tui --url <publicUrl> --invite <code>`. Only the owner makes invite links.
- The code is 32 random bytes, base64url (43 characters). Only its SHA-256 hash is stored (`invite_links`), like auth tokens. A link works once and expires after `auth.inviteTtlHours` (default 72). A new link for a person (`keith person invite`) revokes their older unused ones; it doubles as a password reset.
- The code sits in the URL fragment, so it never reaches a server log. The web app reads `#invite=<code>`, removes it from the address bar, and asks for a username and a password (twice). The TUI takes `--invite <code>`.
- The node sends `POST /v1/auth/invite { code, username, password }` ([protocol.md](../contracts/protocol.md#invite-links)). The server hashes the code and checks the link: a missing, used or expired link is `401 UNAUTHORIZED`, one answer for all three, and an unknown code still runs one password hash. A username taken by someone else is `400 INVALID_REQUEST`, and the link stays unused. Otherwise it marks the link used (a conditional update, so two requests with one code can't both win), sets the username and password hash, deletes the person's existing auth tokens (old sessions end), and answers `LoginResponse` like a login.
- `keith person add`, `list`, `invite`, `tier`, `card`, `block` and `unblock` don't take the home lock, so they change the database while Keith runs; the core reads tiers and cards on the next turn. `keith person remove` needs Keith stopped ([ADR-0018](../decisions/0018-deleting-a-person.md)).

## Thread list (phase 5)

> Planned (phase 5, P5-N1): the server side below.

- `GET /v1/threads` lists every thread the person is a current participant of, groups included. A group's `ThreadDto` carries `purpose` and `formerParticipants`.
- The server subscribes to `thread.participant_joined` and `thread.participant_left`. On a join it sends `thread.updated { thread }` to every connected attended node of every current participant (`AttachmentRegistry.nodesOfPerson`), whether or not the node has the thread open. On a leave it sends `thread.updated` to the remaining participants' nodes and `thread.removed { threadId }` to the leaver's nodes, and detaches the leaver's nodes from the thread, so they get no more of its frames.
- Access doesn't change: `thread.open` and `GET /v1/threads/:id/messages` are for current participants only. A former participant gets `FORBIDDEN` / `404` like anyone else.

## Focus and presence

- **Focus** (per Thread) = the node of the most recent input. Audio output goes there only. Text and UI go to all attached nodes (I-7).
- If the focus node detaches, focus falls to the most recently attached remaining node. `AttachmentRegistry.attachedTo(threadId)` lists nodes in attach order, most recent last.
- **Presence** (per Person) = at least one attended node has one of their Threads open. See [core.md](core.md#presence-and-arrival).
