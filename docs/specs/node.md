# Spec: node (apps/node)

The peripheral node daemon. It pairs with the core, keeps a heartbeat and runs motor commands.
Protocol types live in `packages/contracts/src/node-protocol.ts`; this file is the behaviour of
the node side.

## CLI

Binary `keith-node` (`bin` in apps/node/package.json, `#!/usr/bin/env bun`); from a checkout also
`bun apps/node/src/main.ts <command>` or `bun run start` in apps/node. Built on `@keith/cli`
(`runCli`/`defineCommand`): `--help` is generated, `--version` prints `keith-node <version>`, typos
are suggested. Exit codes: 0 ok, 1 runtime error (one line `keith-node: <message>` on stderr),
2 usage error, 130 cancelled. Every command takes `--config <path>`; without it the file is
`$KEITH_NODE_CONFIG`, `$KEITH_HOME/node.json` or `~/.keith/node.json` (env is read only in
`src/platform/config.ts`).

| Command | Behaviour |
| --- | --- |
| `setup [--core <url>] [--code <code>] [--name <slug>] [--allow-shell] [--workdir <dir>] [--insecure] [--non-interactive] [--force]` | Interactive `join`. Asks core URL (checked by the core URL rule), pairing code (hint: run `keith-core pair` on the core machine), node name (default: host name), allow shell (confirm, default no; each command still needs the owner's approval), work folder (default `defaultWorkdir()`). A question is skipped when its flag is given. `--non-interactive` never prompts: missing `--core` or `--code` is a usage error (exit 2); name and workdir take their defaults and shell stays off. If a config already exists it is shown and confirmed (default no; declining exits 0 and changes nothing); `--force` skips the question, and with `--non-interactive` an existing config without `--force` is a usage error. Ends with next steps: `keith-node run` and a hint to run it under a service manager. |
| `join --core <url> --code <code> [--name <slug>] [--allow-shell] [--workdir <dir>] [--insecure]` | `POST <core>/nodes/join` with `JoinRequest` (code as typed, manifest of this machine). Saves the config, creates the workdir, prints the next command. Exit 1 on any failure and writes nothing; exit 2 when `--core` or `--code` is missing. |
| `run [--insecure]` | Loads the config and connects until SIGINT/SIGTERM (exit 0). Exit 1 if core refuses the node or there is no config. Exit 3 if the node was revoked (no retry). |
| `status` | Prints the config without the token. Exit 1 when there is no config. |
| `driver list` | Installed drivers with version, source, state (loaded, or why not: platform, changed files, bad manifest), the capabilities the driver offers with its options (`desktop.input` only with `allowInput`), and options (a sandbox shows its `runtime` and `image.*`); then the bundled drivers that can be added (`desktop`, `sandbox`) with platform fit. A bundled driver whose entry is missing is built first (`bun run build` in its folder). Exit 1 when there is no config. |
| `driver add <name\|path> [--option key=value] [--allow-input] [--runtime docker\|podman] [--network] [--image lang=ref] [--yes]` | A bundled name is built first, always (`bun run build` in its folder), so the entry matches the checkout. Reads the manifest and hashes the folder (a bundled name or a folder), prints what it declares, its platforms, and on macOS the permissions to grant to the terminal (Screen Recording and Accessibility, by hand in System Settings; Keith cannot grant them), then asks to confirm (default no; `--yes` skips; without a terminal and without `--yes` it refuses). Nothing of the driver runs before the confirmation; after it the entry is imported and the add prints what it can do (and what is withheld with the current options). Writes the entry with the hash and options (a same-name entry is replaced) and says to restart `run`. `sandbox` (bundled): finds the runtime (`--runtime`, else Docker, else Podman on PATH; none is a refusal with the install hint), then asks once to pull the four images (`--yes` skips the question; a declined question pulls and records nothing), pulls each through the runtime (`docker pull`, `podman pull`), and records `runtime`, `network` (with `--network`) and `image.sh|python|node|bun` (defaults, or `--image python=…`). A failed pull refuses the add and writes nothing. Exit 1 when the driver does not load, cannot be built, a sandbox runtime or pull fails, or a built-in name is used; exit 2 for a bad flag. |
| `driver remove <name>` | Deletes only that config entry. Exit 1 when no driver has the name. |

The `driver` commands touch only the local config; nothing is sent to the core, which learns at the next `hello`
(`node-drivers.md`, CLI).

Core URL rule (`src/core-url.ts`, `checkCoreUrl`): `join` and `run` accept `https://` / `wss://`
always, and `http://` / `ws://` only for loopback (127.0.0.0/8, `::1`, `localhost`) and Tailscale
(100.64.0.0/10, `*.ts.net`). Any other plain URL fails (exit 1, before any request or socket)
unless `--insecure` is given, which logs a warning. `--insecure` is never saved in the config.

Name defaults to the host name as a slug (`node` if nothing usable). `--allow-shell` defaults to
off. `--workdir` defaults to `$KEITH_HOME/workspace` (`KEITH_HOME` set, made absolute) or `~/.keith/workspace`. 

## Config file

JSON, directory mode 0700, file mode 0600. A rotated token is written back here (protocol 2). The
write goes to a temp file beside the config, which is renamed over it, so the file is always either
the old or the new one.

```json
{ "core": "http://host:port", "nodeId": "...", "token": "...", "name": "laptop-e",
  "policy": { "allowShell": false, "workdir": "/home/me/.keith/workspace" },
  "drivers": [{ "name": "fake", "source": "path", "path": "/home/me/drivers/fake",
    "sha256": "<64 hex>", "options": {} }] }
```

`drivers` lists the drivers installed with `keith-node driver add` (`bundled` drivers are found by name
in the checkout; a `path` driver needs an absolute folder). A file without `drivers` still loads with
none. `run` and `join` leave out a driver whose files changed since `driver add` and log
`driver changed since it was added: run keith-node driver add again` (`node-drivers.md`, Node config).
A re-join keeps the drivers.

## Protocol behaviour

- URL: `http` to `ws`, `https` to `wss`, path `<core base>/nodes/ws`. Header
  `Authorization: Bearer <token>`.
- On open the node sends `hello` with the manifest: every capability is listed, and
  `policy.allowShell` tells core whether `shell.exec` will run.
  The manifest is v2 (`manifestVersion: 2`): the built-in drivers `system` (`system.info`) and `shell` (`shell.exec`), then each installed driver that loaded and started, with its version, capabilities and schema versions. A driver that fails to load (changed files, bad manifest, platform) or throws in `start` is logged and left out; the node still runs (`node-drivers.md`, Announcement). `join` sends the same manifest.
- `welcome` with `accepted: false`: print the reason, stop, no reconnect, exit 1.
  `accepted: true`: state `online`, heartbeat every `heartbeatMs`, reconnect attempt counter reset. Token rotation and the message budget (ADR-0027 §28): see `rotate` below and `nodes.md` "Limits".
- Revoked (ADR-0027 §13, F-033): a close with code 4003 sets state `revoked` at once. A socket that
  never opened (failed upgrade) gets one plain `GET` of the same URL with the bearer header; status
  401 sets `revoked`, any other status or a network error reconnects with backoff. A revoked node logs
  one error line, sends nothing more, never reconnects and `keith-node run` exits 3.
  No `welcome` within 10 s counts as a lost connection.
- `rotate { token }` (protocol 2): the node stores the token in its config file (atomic write),
  then sends `rotated` on the same socket and reconnects with the new token. Running calls stop, as
  on any reconnect. If the file cannot be written the node keeps its token, sends nothing and logs an
  error; core offers a new token at the next connection. A node started without a config file
  never accepts a token.
- `invoke` and `cancel` are honoured only while online; bad or unknown messages are logged and
  ignored.
- Reconnect after a close: delay = min(30 s, 1 s * 2^attempt) with +-20% jitter.
- Connection states: `idle`, `connecting`, `online`, `backoff`, `stopped`, `revoked` (`src/connection.ts`;
  WebSocket factory and clock are injectable).
- A result for a call that started on an earlier socket is discarded.

### Protocol versions

The node says its version in every message (`v`); core accepts from `MIN_PROTOCOL` up and never sends a message a node cannot read.

| Version | What it adds | Plan |
| --- | --- | --- |
| 1 | Base: `hello`, `welcome`, `heartbeat`, `invoke`, `progress`, `result`, `cancel` | P1 to P23 |
| 2 | `rotate` (core to node) and `rotated` (node to core): token rotation after 30 days. Core sends `rotate` only to a node whose hello is 2 or higher | P26 (ADR-0027 §28) |
| 3 | Drivers: manifest v2 (drivers and per-capability schema versions), `invoke.capabilityVersion`, the errors `unsupported-version` and `driver-unavailable`. Additive: a v1 or v2 node keeps working; `MIN_PROTOCOL` stays 1 | P31 (`node-drivers.md`, Contracts) |

A v1 node keeps working against a v2 core: it is never sent `rotate`, its messages parse unchanged, and its token is not rotated. The same holds for a v2 node against a v3 core.

## Executor

`src/executor/`. Every invoke ends in exactly one `result`.

| Capability | Behaviour |
| --- | --- |
| `system.info` | OS, platform, release, arch, hostname, CPU count/model, memory, uptime, disk usage of the workdir (`df -k`, parsed, `null` if it fails). Not subject to `allowShell`. |
| `shell.exec` | See below. |
| anything else that a loaded driver owns | The driver's capability (`node-drivers.md`, Announcement and executor). Checked in this order: the driver is loaded (else `driver-unavailable`, the message names the driver and its reason from `keith-node driver list`); `capabilityVersion`, when core sends one, equals the schema the driver declares (else `unsupported-version`); then the driver's own policy inside the driver. |
| anything else | `unknown-capability`: exactly one result, no driver is called. |

The built-in drivers are `system` and `shell`, registered like any other driver; `system.info` and
`shell.exec` keep the behaviour below.

### Driver calls

- The driver gets the call's `callId`, capability, schema version, input and `timeoutMs`, a logger, the
  node's `workdir`, its options and a signal (`@keith/driver-sdk`, `DriverContext`).
- Timeout: the call's `timeoutMs` starts a clock that aborts the signal with reason `timeout`; cancel and a
  socket drop abort it with reason `cancelled`. A driver's own answer wins if it arrives in time; a driver
  that is still running one second after `killGraceMs` (2 s by default) is given up. An aborted call ends
  `timeout` or `cancelled` whatever the driver answered.
- Progress: `ctx.progress(chunk, stream?)` sends a `progress` message for the call (stream `stdout` by default).
- A driver answer `{ ok: true }` gives `ok: true` with `output` and `exitCode` when it has one. A failure gives
  its own code (`failed`, `refused-by-policy`, `timeout`, `cancelled`, `busy`) with the driver's message. `busy` is a node
  code (`ErrorCodeSchema`): the machine is busy, try later; core reads it as `busy, try again later: <message>` (`motor.md`).
- A driver that throws, or answers something that is not a result, gives `failed` (`driver <name> crashed: …`
  or `returned no result`). The node keeps running and its other calls are unaffected.

### shell.exec safety

- `allowShell: false` gives `refused-by-policy`, even if core allowed the call.
- `cwd` is resolved against the workdir and `realpath`-ed; a result outside the workdir (`..`,
  absolute path, symlink) gives `refused-by-policy`. A missing cwd gives `failed`.
- Runs `/bin/sh -c <command>` with stdin closed and env limited to `PATH`, `HOME`, `LANG`.
- Own process group: `Bun.spawn({ detached: true })` makes the child a session and group leader
  (pgid = pid), so timeout and cancel signal `-pid`. SIGTERM, then SIGKILL after 2 s.
- Timeout = min(`input.timeoutMs`, `invoke.timeoutMs`, 120 s); result `timeout`. `cancel` gives
  `cancelled`. A socket drop kills every running call.
- stdout and stderr stream as `progress` chunks (at most 30 000 characters in total).
- Final `output` is stdout and stderr interleaved in arrival order, capped at 30 000 characters:
  head 15 000 + marker line `[... N characters truncated ...]` + tail 15 000.
- Normal exit: `ok: true` with `exitCode` (non-zero included). Killed by an outside signal: `failed`.

## Limits

- Background children that leave the process group (own `setsid`) survive a kill.
- After a normal exit the node waits at most 1 s for the pipes to drain; a background child that
  keeps them open does not block the result and is not killed (it is not a timeout or cancel).
- No OS-level isolation: the workdir check constrains `cwd` only, the command itself can touch any
  path the user can.
