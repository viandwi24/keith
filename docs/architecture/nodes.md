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
HTTP  POST /v1/auth/login  ──►  { token, person }
WS    GET  /v1/ws?token=…  ──►  upgrade
node  → hello { client, capabilities, nodeId? }
core  → welcome { nodeId, person, protocol, server }
node  → thread.open { threadId? }        (omit → the person's main thread)
core  → thread.opened { thread, messages }
      … input.text / message.* / thread.state / ui.render …
node  → thread.close | socket closes     → detach, presence update
```

- `nodeId` is issued by the core on first `welcome`. Nodes should persist it and send it back in later `hello`s so the core recognizes the same device. The TUI stores it in `$XDG_CONFIG_HOME/keith/tui.json` (default `~/.config/keith/tui.json`), since it may run on a different machine than the core, and the browser stores it in `localStorage`.
- The core must receive `hello` within 5 s of upgrade or it closes the socket with code `4001`.
- Heartbeat: the core sends `ping` every 25 s and drops a node silent for 60 s.

## Auth (phase 1)

- `keith setup` (interactive CLI) creates the **owner** Person with a username and password (Argon2id via `Bun.password`).
- `POST /v1/auth/login` returns an opaque random token. Its SHA-256 hash is stored with an expiry (`auth.tokenTtlDays`, default 30).
- HTTP uses `Authorization: Bearer <token>`. WS uses `?token=` because browsers can't set headers on upgrade.
- `POST /v1/auth/logout` deletes the token.
- The server binds to `127.0.0.1` by default. Remote access (Tailscale, reverse proxy) is the operator's job. Keith doesn't terminate TLS in phase 1.

> Planned (phase 5): adding members and guests (`keith person add`, invite links). Planned (phase 7): node pairing for headless nodes (6-digit code shown in an attended node, exchanged for a node token).

## Focus and presence

- **Focus** (per Thread) = the node of the most recent input. Audio output goes there only. Text and UI go to all attached nodes (I-7).
- If the focus node detaches, focus falls to the most recently attached remaining node.
- **Presence** (per Person) = at least one attended node has one of their Threads open. See [core.md](core.md#presence-and-arrival).
