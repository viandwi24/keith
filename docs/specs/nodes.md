# Nodes

Code: `apps/core/src/modules/nodes/{nodes,registry,gateway,pairing,core-node,procedures,types}.ts`,
wire types in `packages/contracts/src/{node-protocol,nodes}.ts`, storage in `packages/db`
(`nodesRepo`, `pairingRepo`). Tests: `registry.test.ts`, `gateway.test.ts`, `pairing.test.ts`,
`core-node.test.ts`, `apps/core/src/node-pairing.e2e.test.ts`, `motor.e2e.test.ts`.

## Purpose

Keith acts on other machines through peripheral nodes. Core pairs them, keeps their connection and
state, and sends them calls (`invoke`) that find their way back to the caller. Core itself is the
in-process node `core`. Layers (ADR-0020, ADR-0027 §9): nodes are Keith's **self** layer. Every person with
`nodes.read` (every member, `permissions.md`) sees every node: `nodes.list` is not filtered per person (the per-person rule of
OWN-008 covers the activity feed only). A node is not a client: the TUI or a web app a person uses is a client of that person's
**ecosystem** layer (`parietal.md`, ADR-0023 §5, ADR-0025), and only that person's turns may call it. No TLS: nodes belong on localhost or a private network (SECURITY.md); core binds to `KEITH_HOST` (default `127.0.0.1`).
The capability model (ids, specs, drivers, manifest v2, refusals) is in `node-drivers.md`; this file is the connection and the calls.

## Public API (`index.ts`)

- `createNodes(options)` returns `{ hub, gateway, pairing, close() }`. `options`: `nodes`
  (`NodesRepo`), `pairing` (`PairingRepo`), `store` (activity), `version`, `allowCoreShell`,
  `shellEnv`, `publicUrl()`, `timing`, `warn?`, `local?` (replaces `core`, tests), `capabilities?` (the
  core's capability registry; `createNodes` freezes it at boot, default the built-in specs),
  `onDriversChanged?`, `onCapabilityRefused?` (audit hooks, see "Audit").
  `timing`: `heartbeatMs` (10 000), `heartbeatTimeoutMs` (30 000), `sweepEveryMs` (5 000),
  `pairingTtlMs` (600 000), `timeoutGraceMs` (1 000). `close()` stops the sweeper and closes every
  socket (status offline).
- `NodeRegistry` (what the rest of core sees): `list()`, `find(ref)` (name, then id), `invoke(ref,
  capability, input, { timeoutMs, signal?, onProgress? })`, `byCapability(id, { version? })` (nodes
  that accept the capability, online first; `version` keeps those at that schema version), `revoke(id)`.
- `nodeProcedures({ registry, pairing })`: oRPC `nodes.list` (`nodes.read`), `nodes.pair` and `nodes.revoke` (`nodes.manage`, step-up over TCP; `permissions.md`).
- `createCoreNode`, `CORE_NODE_ID` (`'core'`), `PAIRING_TTL_MS`, `TIMEOUT_GRACE_MS`,
  `HEARTBEAT_TIMEOUT_MS`, `NodeSocketData`.

## Pairing

1. Owner calls `nodes.pair` (TUI `/pair`): a code `ABCD-EFGH` (`generatePairingCode`, 31 symbols
   without 0/O/1/I/L), stored as a SHA-256 hash in `pairing_codes`, valid 10 minutes, once. At most
   3 codes wait at a time (a fourth is `TOO_MANY_REQUESTS`). The reply carries `expiresAt` and
   `joinCommand` = `bun apps/node/src/main.ts join --core <public URL (KEITH_PUBLIC_URL, else the access.publicUrl setting) or
   http://localhost:<port> (the host when `KEITH_HOST` is not loopback or wildcard)> --code ABCD-EFGH`.
2. The new machine calls `POST /nodes/join` with `JoinRequest` (`code`, `manifest`). No owner token
   (the code is the credential). Order of checks: body at most 16 KB (413 `TOO_LARGE`, by
   `content-length` and by the real text length; the server caps 1 MB before that) → valid JSON and schema (400, no penalty) → the
   client's failure budget (429 when spent) → the code is 8 characters of the pairing alphabet (400
   `INVALID_CODE`, counts as a failure) → one transaction (`nodesRepo.joinWithCode`, ADR-0027 §13):
   the code is checked (unknown, used or expired: 400 `CODE_*`, counts as a failure; a name clash
   with an unknown code answers the code error, never 409) → the name is not `core` and not in use
   (409 `NAME_TAKEN`, counts as a failure; the code is **not** spent) → the node is created with a
   random token (`keith_node_…`, only its SHA-256 is stored) and the code is spent with
   `used_by_node` = the new node → `200 JoinResponse { nodeId, token, heartbeatMs }`, `node-changed`
   is emitted, the client's failures are cleared. An unexpected store error rolls the transaction
   back: a fixed 409 `could not pair` (counts as a failure), the detail goes to the log, never to the
   caller. Expired codes are deleted by the prune tick once they are `retention.pairingCodesMs`
   (1 day) past expiry (`purgeExpired`), so an old code still answers "expired".
3. Rate limit: `pairingGuard`, 5 failures per hour per client address (`server.requestIP`, passed to
   Hono as `env.ip`; `unknown` without it). The 6th attempt is `429 TOO_MANY_ATTEMPTS`, even with a
   good code.

Errors are `{ "error": { "code", "message" } }` with a readable message.

## Connection (`GET /nodes/ws`)

Bun's native WebSocket (`Bun.serve({ fetch, websocket })`; `hono/bun` is not used). The core `fetch`
handles this path before Hono. The `websocket` object that `createCore` returns is a dispatcher shared with the plugin view sockets (`thalamus.md`, `plugin-views.md`): this gateway's handler gets every socket whose data has no `kind: 'view'`:

1. `Authorization: Bearer <node token>` is hashed and looked up (`findByTokenHash`, revoked rows
   never match). Missing or wrong: `401`, no upgrade. Not a WebSocket request: `426`.
2. `server.upgrade(request, { data: { nodeId } })`.
3. First message must be `hello` (`HelloSchema`) within 10 s. A protocol version below
   `MIN_PROTOCOL`, bad JSON, a bad manifest, a revoked node or silence: `welcome { accepted: false,
   reason }` and close (4002).
4. Accepted: the manifest (os, arch, version, drivers, capabilities, `policy.allowShell`) is stored; the
   core's registry accepts or refuses each announced capability (`node-drivers.md`, "Core"), status
   `online`, `node-changed` emitted, `welcome { accepted: true, heartbeatMs }` sent. A second
   connection of the same node replaces the first (close 4001); the old socket's close does not
   take the node offline.
5. After the welcome: `heartbeat` refreshes `last_seen_at`; `progress` and `result` go to the call
   with that `callId` **of that node only**; unparsable messages are ignored with a warning. Every
   message after the welcome first passes the node's message budget (see "Limits"); a dropped one
   is never parsed or delivered.
6. The sweeper (every `sweepEveryMs`) drops a socket without a heartbeat for `heartbeatTimeoutMs`
   (close 4008): the node is `offline` and `node-changed` is emitted. Socket close does the same.
7. `Bun.serve` runs with `idleTimeout: 30` for HTTP (authorized requests lift it, see
   `thalamus.md`); the node WebSocket has its own idle timeout and heartbeats keep it busy.

Close codes: 1001 core shutdown, 4001 replaced, 4002 hello refused, 4003 revoked (the node daemon stops for good, `node.md`), 4008 heartbeat
timeout or message budget overload (see "Limits").

**Token rotation** (protocol 2, ADR-0027 §28; `gateway.ts`). Presenting the pending token on
the WebSocket upgrade completes a rotation: `commitTokenRotation` makes it the current token and
audits `node.token.rotated`. After the welcome, a node whose hello is protocol 2 or higher and whose
token is older than 30 days (`NODE_TOKEN_MAX_AGE_MS`, `rotateAfterMs`) gets a new token: core stores
its hash as pending and sends `rotate { token }`. The node stores the token and answers `rotated` on
the same socket; core then commits it (a repeat changes nothing). Until then the old token keeps
working, and a `rotate` in flight is replaced by the next one if the node connects again. A v1
node is never rotated. A revoked node is never rotated.

## Registry and calls

`list()` is `core` first, then the paired nodes (revoked ones are not listed). A node is `online`
only while it holds a socket; on boot every row left `online` by a crash is set `offline`.
`node-changed` (`NODE_CHANGED`, payload `{ node }`, `sessionId` null) is emitted on pair, connect,
disconnect, sweep and revoke.

`invoke(ref, capability, input, options)` settles with `InvokeOutcome`: `{ ok: true, output,
exitCode? }` or `{ ok: false, code, message }`, `code` one of `unknown-node`, `offline`,
`unknown-capability`, `refused-by-policy`, `timeout`, `cancelled`, `busy`, `failed`. It never rejects.

- Rejected at once, nothing sent: unknown node; capability not in the static table
  (`CAPABILITIES`) or not in the node's manifest; node offline.
  A capability the registry refused for a node is `unknown-capability` (the message names the reason), and
  `invoke` sends `capabilityVersion`: the schema version the core accepted for that node.
- Sent: `invoke { callId (UUIDv7), capability, input, timeoutMs }`. `progress` goes to `onProgress`.
  `result` settles (a node error keeps its code).
- `signal` abort: `cancel { callId }` is sent and the call settles `cancelled`.
- No result after `timeoutMs + timeoutGraceMs`: `cancel` is sent and the call settles `timeout`
  (the node normally reports its own timeout first).
- The socket closes mid-call: `failed`, "node disconnected". The node is revoked mid-call: `failed`,
  "node revoked".
- A late result for a settled call is ignored.

`revoke(id)`: `nodesRepo.revoke` (the token never matches again), the socket closes (4003), calls in
flight fail, `node-changed` is emitted. `core` cannot be revoked (`BAD_REQUEST` in oRPC).
`nodes.revoke` accepts the id or the name.

## The node `core`

`createCoreNode({ allowShell, version, env, workdir?, killGraceMs? })`: id and name `core`, always
online, capabilities `system.info` and `shell.exec`, `allowShell` = `KEITH_CORE_ALLOW_SHELL`
(default false). It is reached through `invoke` like any node, so approval and limits are the same.

- `system.info`: hostname, os, release, arch, cpu count, total and free memory, uptime, load.
- `shell.exec`: without `allowShell` the outcome is `refused-by-policy`. Otherwise
  `/bin/sh -c <command>` in `workdir` (default the process folder, `cwd` relative to it), in its own
  process group (`detached`), stdin closed, the environment is `Config.shellEnv` only (PATH, HOME, LANG;
  never Keith's secrets), stdout and stderr merged, streamed to `onProgress`. Time limit
  `min(input.timeoutMs ?? 120 s, call timeout)` and abort: SIGTERM to the group, SIGKILL after
  `killGraceMs` (2 s); a group that holds the pipes after the shell exited is killed. Output kept:
  first 20 000 and last 10 000 characters. This executor is separate from the one of `apps/node`, but it applies the same rules (ADR-0027 §12, ADR-0021): `cwd` is resolved through `realpath` and must be the workdir or inside it, else `refused-by-policy` (a missing workdir is `failed`); the environment is `PATH`, `HOME` and `LANG` only (`Config.shellEnv`).

## oRPC

`nodes.list` (`Node[]`, `core` first), `nodes.pair` (`PairingCode`), `nodes.revoke({ id })` (`/rpc/*`). `nodes.list` needs `nodes.read` (members hold it and see every node: nodes are Keith's self layer, ADR-0020 and ADR-0027 §9); `nodes.pair` and `nodes.revoke` need `nodes.manage` and a step-up over TCP (`permissions.md`).

## Invariants

- This module never decides approval. The only node state the approval hook reads is the shell-off check, which can only deny (`motor.md`).
- A node can only answer calls addressed to it.
- A revoked node's token never opens a socket.
- A node's messages are budgeted: over the budget a message is dropped, and an overload closes the socket (see "Limits").
- A capability refused in a manifest never reaches the node; the node stays online with its other capabilities, and a reconnect with a changed driver set writes one `node.drivers` row (`node-drivers.md`).
- A token rotation keeps the current token valid until the new one is in use: the pending hash lives in `token_next_hash` (db.md) and `findByTokenHash` matches either hash. Revoking scrambles both.
- The token of a node exists in clear only in the `join` reply, in a `rotate` message and in the node's config file; the database keeps its hash.

## Limits

- Message budget (ADR-0027 §28, `rate-limit.ts`): per node socket, 200 messages in a sliding 10 s
  window, counted from the welcome on (the hello is not counted). A message over the window is
  dropped unread. A message is at most 4 MB.
- `node.rate_limited { node }` is audited on the first drop, then at most once per 5 minutes per node.
- `node.drivers { node, name, drivers: [{ name, version, change: added | removed | changed }] }` is written
  once per connection whose driver set differs from the stored manifest; `node.capability.refused { node,
  name, id, schemaVersion, reason }` once per distinct refusal per connection. Neither names a person
  (`AUDIT_SUBJECT_FIELDS` lists them with no field; `mine` hides them).
- Overload: drops that last 30 s, with no calm 10 s window in between, close the socket with 4008.
  The node daemon reconnects with backoff, as after any other close.
- A node that heartbeats at `heartbeatMs` and answers its calls never reaches the budget.

## Tests

`registry.test.ts`: state, replace, sweep, boot reset, correlation, forged answers, offline/unknown,
cancel, timeout, disconnect, revoke, core. `rate-limit.test.ts`: the sliding window, the overload
clock and a burst that ends. `gateway.test.ts`: hello, version, bad messages, hello timeout,
revoked, the budget (drop at 201, audit throttle, 4008 close, normal traffic), the rotation (rotate
after 30 days, rotated commits once, a lost rotated completed by the new token, the old token
refused, a younger token and a v1 node not rotated). `pairing.test.ts`: format, limit, join, bad bodies, per-client lockout.
`core-node.test.ts`: policy, env, exit codes, timeout, cancel with process-group kill, output cap.
`node-pairing.e2e.test.ts` and `motor.e2e.test.ts`: the gate over a real socket.
