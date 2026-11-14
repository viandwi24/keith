# Node drivers

The capability model of the nodes: what a capability is, how a node adds one through a driver,
how the core checks and refuses it, and how the first drivers (`desktop`, `sandbox`) and the
client capabilities use the same model. Decision: ADR-0023 (nodes are the body, plugins are the
mind), with ADR-0021 §2 and §3 (files by reference, the core never runs code) and ADR-0027 §7, §9,
§12, §13 and §28. Plan: `docs/plans/done/P31-node-drivers-and-sandbox.md`.

Status: built in P31 (Nov 11, 2026). The rules below describe the code as it is; the limits that remain
are listed in "Known limits".

Code: `packages/contracts/src/node-capabilities.ts`, `node-protocol.ts`, `nodes.ts`;
`apps/core/src/modules/nodes/node-capabilities.ts` (new); `apps/core/src/modules/motor/`;
`apps/node/src/{driver-command,manifest}.ts`, `apps/node/src/executor/`; `packages/driver-sdk/`,
`packages/driver-desktop/`, `packages/driver-sandbox/`.

## Purpose

A node is a body part. The owner installs a driver on a machine (`keith-node driver add desktop`),
the node announces it, and Keith finds the capability, checks that it understands the schema, asks
the owner before anything risky, and uses it. A driver adds capabilities; it adds no tools, no
prompts and no Keith data (ADR-0023 §3). Rights live on the node; approval lives in the core
(ADR-0023 §4). Client capabilities (`notify`, `open.view`, `location.share`) belong to one person's
ecosystem and are not drivers (ADR-0023 §5).

Vocabulary:

- **Capability**: a typed action, `<driver>.<action>` (`system.info`, `shell.exec`,
  `desktop.screenshot`, `sandbox.run`). The first segment is the driver name.
- **Capability spec**: the core's record of a capability: schema, risk, approval, the versions it
  speaks. It exists only in the core and is never sent.
- **Driver**: a package that registers capabilities in the node daemon. Built-in drivers are
  `system` (`system.info`) and `shell` (`shell.exec`).
- **Manifest**: what a node announces in `hello` and `join`. It says what exists, never what a
  capability needs.

## Capability model (contracts)

The model lives in `packages/contracts/src/node-capabilities.ts`. `node-protocol.ts` holds the static table
`CAPABILITIES` (`system.info` read, `shell.exec` destructive, `desktop.*`, `sandbox.run`) and re-exports the model.
A node that announces a well-formed id the core does not know is refused for that capability only; the node
stays online with the rest.

- **Id**: `CapabilityIdSchema` is a string matching `^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$`, at most
  64 characters, not an enum. `CAPABILITIES` and `capabilityRisk` stay exported with the
  same behaviour for the built-ins, so existing callers keep compiling.
- **Risk**: `read`, `write`, `external`, `destructive` (`RiskSchema`, the eharness names).

### Spec (core side)

`NodeCapabilitySpec` (contracts, `node-capabilities.ts`), never sent:

```ts
{ id, version: number /* newest */, supports: number[] /* versions the core speaks */,
  driver: string, layer: 'self' | 'ecosystem', summary: string,
  risk: Risk | ((input) => Risk), approval: 'by-risk' | 'never',
  input: ZodType, output?: ZodType }
```

- `approval: 'by-risk'` (default): `read` is approved, anything riskier asks the owner.
- `approval: 'never'` is allowed only when the spec can run an input unasked: a fixed risk of `write` or
  below, or a risk function where at least one example comes out at `write` or below. A spec with a
  fixed risk above `write`, or a risk function that no example brings to `write`, is rejected at
  registration. At call time an input whose computed risk is at most `write` runs without asking; a
  riskier input asks the owner by its risk.
- `risk` may be a pure function of the input (`sandbox.run` is `write` without network, so it runs
  unasked, and `external` with `network: true`, which asks the owner). It is decided from the input and the static tables, never from
  live state: `tool.approve` may run again on re-validation (AGENTS.md gotcha).
- A node can never lower risk or approval. The manifest says what exists, not what is needed.

## Manifest

The union is in the contracts (P31.1.3); the node fields `drivers` and `refused` are filled by the core's
registry at each connection (P31.1.5).

- **v1** (today, unchanged): `{ capabilities: string[], policy: { allowShell } }`. The core maps
  it to the drivers `system` and `shell` at schema version 1. A v1 node keeps working; its messages
  parse unchanged.
- **v2**: `{ manifestVersion: 2, name, os, arch, version, policy: { allowShell }, drivers:
  [{ name, version (semver of the driver), capabilities: [{ id, schemaVersion }], options?: JSON }] }`.
  `options` holds public facts only (`allowInput`, `network`, image names), never a secret or a path
  outside the node's own config. At most 16 drivers and 64 capabilities; more is a bad manifest
  (rejected as a whole, as today).

`NodeSchema` (`nodes.ts`) gains `drivers` (`name`, `version`) and `refused: [{ id, schemaVersion,
reason }]`. `capabilities` stays the list of **accepted** ids, so the TUI and `nodes_status` keep
working. A v1 node's `drivers` are `system` and `shell` at version `1.0.0`.

Accepted and refused are stored by `connect()` and read by `NodeRegistry`; no migration is needed,
because `nodes.manifest` is already JSON and the new shape is read by `registry.ts` with the union
schema (`db.md`, table `nodes`).

## Contracts

Protocol version 3 is additive on top of P26's version 2 (token rotation):

- `PROTOCOL_VERSION` is 3; `MIN_PROTOCOL` stays 1 (only a later ADR moves it).
- `invoke` gains an optional `capabilityVersion`: the highest version both sides support.
- The node `ErrorCodeSchema` gains `unsupported-version`, `driver-unavailable` and `busy`.
- The version table is in `node.md`.

A `join` or `hello` whose manifest does not parse at all is rejected as a whole (`welcome` with
`accepted: false`), as today. Per-capability problems are refusals, below.

## Core: registry, discovery, refusal

The registry is `apps/core/src/modules/nodes/node-capabilities.ts` (`NodeCapabilityRegistry`). The node
registry (`registry.ts`) calls `accept` at each `connect`, stores nothing new (the accepted and refused
lists are read from `nodes.manifest`), and the node row shows `drivers` and `refused`.

- `register(spec)` runs at boot only. The built-ins are `system.info` (read), `shell.exec`
  (destructive), and, with their drivers, `desktop.*` and `sandbox.run`. The registry is frozen
  before the agents start, so `tool.approve` and `ownerAnswers` read static data. Registering after
  the freeze throws.
- Boot seam (P31.2.6): `createCore({ nodeCapabilities })` (`CoreOptions`) adds specs to the built-ins
  before the freeze, so the registry, motor and approvals read the same extra specs. It is how a driver
  the core does not ship is registered; the end-to-end test `node-drivers.e2e.test.ts` uses it for a fake
  driver. No production path adds a spec this way yet.
- `accept(manifest)` returns `{ accepted: [{ id, schemaVersion, driver }], refused: [{ id,
  schemaVersion, reason }] }`. A capability is refused, and the node stays online with its other
  capabilities, when:

  | Reason | When |
  | --- | --- |
  | `unknown-capability` | the id is not in the registry |
  | `unsupported-schema` | the version is not in the spec's `supports` |
  | `driver-mismatch` | the driver name differs from the id's first segment (`desktop.screenshot` under driver `shell`) |
  | `wrong-layer` | the id belongs to P27's client capability registry (`open.view`, `location.share`: ids that match the regex); a node cannot announce a client capability |

  An id that does not match the regex is not a capability id at all: the manifest is rejected as a
  whole. `notify` has no dot, so a node that announces it fails the regex and its whole manifest is
  refused (`welcome` with `accepted: false`). A client id never reaches the registry's spec table.
- `NodeRegistry.byCapability(id, { version? })` returns the nodes that accept the capability,
  online first. `find` and `invoke` keep their signatures.
- `invoke` sends `capabilityVersion` (the highest version both sides support). A call to a refused
  capability is answered `unknown-capability` before anything is sent; a call with no common version
  is `unsupported-version`.
- Audit: `node.drivers` when a node's driver set changes between connections (ids and versions
  only, one row per change); `node.capability.refused` once per distinct refusal per connection.
  `node-changed` carries the new fields.

### Per-person limit for `approval: 'never'`

A call to a capability with `approval: 'never'` (risk `write` or below) is counted in memory per
principal (`ctx.principal`, the worker's own person, so a member cannot spend the owner's
allowance). The setting `nodes.sandbox.maxPerHourPerPerson` (default 60, 1 to 1000) is the limit;
the call over it is `rate-limited` with a message that names the setting.

## Motor: generic over the registry

`apps/core/src/modules/motor/{remote,risk}.ts` read the registry: `motor_remote` checks the
capability against the registry instead of `CAPABILITIES`, parses the input with the spec's schema,
and takes risk and approval from the spec (`tool.approve`). `ownerAnswers` reads the same registry:
anything that still asks is answered by the owner, even in a member's session (ADR-0027 §9; members
see nodes, only the owner answers risky approvals). The grant scope stays `<node id>:<capability>`.
`MOTOR_INSTRUCTIONS` list the registry's capabilities; the text for `desktop` and `sandbox` comes
with those drivers (P31.3.4, P31.4.4).

Image results (desktop): an image output becomes the MCP-style result `{ content: [{ type: 'image',
data, mimeType }] }`, which eharness stores as a media reference (`.ref/eharness/docs/specs/09-tools-and-mcp.md`,
"Media offload"; `03-messages.md` step 5b). The stored history keeps a reference in the person's
workspace; the model gets only the newest images (`toolOutput.keepImages`). No eharness gap: the
media path exists. The mapping is live (P31.3.1): `motor_remote` turns an output `{ data, mimeType: 'image/*', ... }`
into `{ content: [{ type: 'image', data, mimeType }, { type: 'text', text }] }`; the text part holds `ok`, `node`,
`capability` and the rest of the output (size, scale). The tool's `toModelOutput` (`modelOutputOf`) turns the image
parts into model images; an image still offloaded to a file has its bytes read back by eharness, and the newest
`toolOutput.keepImages: 3` of a run reach the model (`cortex.md`, Images).

## Driver package and `keith-node driver`

### Package format

A folder (or workspace package) with `keith-driver.json` and a built entry:

```json
{ "manifestVersion": 1, "name": "desktop", "version": "0.1.0", "entry": "dist/index.js",
  "capabilities": [{ "id": "desktop.screenshot", "schemaVersion": 1 }], "platforms": ["darwin"],
  "needs": ["screen-recording"] }
```

The entry exports `default defineDriver({ name, version, capabilities, start(ctx), offered(options)?,
invoke(call, ctx) })` from `@keith/driver-sdk`. `offered(options)` returns the subset of `capabilities`
the driver announces with these options (absent: all of them); the node announces and lists only that
subset, and an empty subset leaves the driver out (`offers no capability with these options`). The desktop
driver offers `desktop.input` only when `allowInput` is on. `ctx` gives a logger, the node's `workdir`, the driver's options,
`signal` (cancel) and `progress(chunk)`. `invoke` returns `{ ok, output, exitCode? }` or a failure
code. The SDK does not expose the core URL, the token, the node config or other drivers.

`@keith/driver-sdk` (`packages/driver-sdk/`) imports only `@keith/contracts`. It exports
`defineDriver`, `DriverManifestSchema`, `loadDriver(path)` (validates the manifest, checks
`platforms`, imports the entry). A check-imports rule restricts `packages/driver-*` to
`@keith/contracts` and `@keith/driver-sdk`. `loadDriver` rejects a bad manifest, a platform that
does not match, and a missing entry.

### Node config

The config (`apps/node/src/platform/config.ts`, the only place that reads env) holds `drivers:
[{ name, source: 'bundled' | 'path', path?, sha256, options }]`. An old config without `drivers`
still loads. `sha256` is the hash of `keith-driver.json` plus the entry file at install time
(`driverFingerprint`). `run` and `join` leave out a driver whose files changed (`driver changed since
it was added: run keith-node driver add again`, `verifyDriverFingerprint`): a driver is code with the
node's rights. No driver is downloaded; no signing (out of scope).

### CLI

`apps/node/src/driver-command.ts`, registered in `commands.ts`, built on `@keith/cli`, so `--help` is
generated. Every command takes `--config`. Commands touch only the local
config; nothing is sent to the core. The core learns at the next `hello`.

- `keith-node driver list`: installed drivers with version, capabilities, options, and whether the
  platform and OS permissions fit; plus the bundled drivers that can be added.
- `keith-node driver add <name|path> [--option key=value …] [--allow-input] [--runtime docker|podman]
  [--network] [--image lang=ref] [--yes]`: the flags are the driver's declared options. Before the
  confirmation it reads and checks `keith-driver.json` (shape, platform, entry file inside the folder) and
  hashes the folder; it prints what the manifest declares and what it needs (for example, "desktop needs
  Screen Recording and Accessibility permission for your terminal"), then asks to confirm (`--yes` skips).
  Only after the confirmation it imports the entry, prints what the driver can do and what is withheld with
  the options, writes the config and says `restart keith-node run to announce it`. Nothing of a path driver
  runs before the confirmation: a declined add imports nothing.
- `keith-node driver remove <name>`: deletes only the config entry.

### Announcement and executor

`buildManifest(name, policy, drivers)` (`apps/node/src/manifest.ts`) emits v2: the built-in drivers
first, then the drivers `prepareDrivers` (`apps/node/src/drivers.ts`) returns. That function loads each
installed driver (hash first, then the manifest and platform), calls its `start` with a context of the
node's `workdir`, the driver's options and a signal, and keeps the ones that succeeded. A driver that fails
to load (platform, changed hash, bad manifest) or throws in `start` is logged and left out; the node still
runs. The announced set stays within the manifest limits (16 drivers, 64 capabilities, the built-ins
counted). `run` and `join` both use it; `join` sends the same manifest.

The executor (`apps/node/src/executor/index.ts`) keeps `system.info` and `shell.exec` as the built-in
drivers `system` and `shell`, registered like any other driver. Every other capability goes to its
driver by id, after the node-side checks (driver loaded, version supported, the driver's own policy),
as `node.md` (Executor) orders them. `prepareDrivers` returns the loaded drivers (`runnable`) and the
ones left out (`left`), and `run` passes both to the executor. Cancel, timeout and progress pass through
the SDK (`CapabilityCall.timeoutMs`, `DriverContext.signal`, `progress(chunk, stream?)`). An unknown id
ends in exactly one `unknown-capability` result; a driver crash ends in `failed` and the node keeps running.

### Rights on the node

Each driver keeps its policy in its options: shell `--allow-shell`; desktop `allowInput`, the rate
limit and the pause file; sandbox `network`, the images and the runtime. The node may run as root;
what it allows is its manifest (ADR-0023 §4). Approval is never decided on the node.

## Driver `desktop` (computer use)

The three capabilities are built in: their specs and schemas are in contracts `CAPABILITIES`, next to
`shell.exec`, so the core accepts them before any node announces them (P31.3.1). Package
`packages/driver-desktop/` (bundled: `keith-node driver add desktop` builds `dist/index.js` from the checkout
first), macOS backend only
(`platforms: ["darwin"]`). No dependency: `screencapture -x -t jpg` for images, `osascript -l
JavaScript` for mouse events and `System Events` for keys and text. These are runtime programs of the
driver, not repo tools (ADR-0006 needs no entry).

| Capability | Schema v1 | Risk | Approval |
| --- | --- | --- | --- |
| `desktop.info` | `{}`; returns `{ displays: [{ id, width, height, scale }], frontApp? }` | `read` | none |
| `desktop.screenshot` | `{ display?, maxWidth? (default 1280) }`; returns an image and `{ width, height, scale }` | `external` (the pixels reach the model provider) | one approval; `remember: session` for the owner's own sessions (grant scope `<node id>:<capability>`) |
| `desktop.input` | `{ actions: [{ type: 'move'\|'click'\|'double_click'\|'right_click'\|'drag'\|'scroll'\|'type'\|'key', x?, y?, to?, text?, keys? }] }`, at most 10 actions | `destructive` | asked each time unless remembered |

Coordinates are in the pixel space of the latest screenshot; the driver maps them with the screen
scale. A `scroll` takes its direction in `keys[0]` (`up`, `down`, `left` or `right`, default `down`) and scrolls 3
lines; the approval reads `scroll down` (the contract has no amount). `desktop.input` is announced only with
`allowInput` (the driver's `offered`, see Package format). Node policy (driver options, set at `driver add`): `allowInput` (default off: screenshots
only), `maxActionsPerMinute` (default 60), and a pause file `<workdir>/../desktop.pause` whose presence
makes every desktop call `refused-by-policy` (the owner's brake). Without OS permission a call is
`refused-by-policy` and names the missing permission (`Screen Recording`, `Accessibility`); the OS
prompts are manual.

Image limits: a screenshot over 1 MB (1 000 000 decoded bytes) is refused by the node (`failed: screenshot too
large`; the WebSocket cap is 4 MB). The core refuses it again in `motor_remote` with the same code and message
(P31.3.1), so a node that does not check still cannot put a larger image in front of the model. A worker on a text-only model gets `image not supported by the model`, and
`doctor` warns (`cli/doctor/checks/vision.ts`).

Worker instructions (`DESKTOP_INSTRUCTIONS`, added by `motorInstructionsOf` only when an online node announces
`desktop.*`; read per turn, `motor.md`): observe,
act, observe; coordinates come from the last screenshot; stop and ask the person at any password,
payment or two-factor prompt; never type secrets; one action batch at a time.

Approval copy (P31.3.5, TUI): the dialog lists the actions in words (`click (412, 230)`, `type
"hello"`) and reads `Allow desktop.screenshot on laptop-e? [a] allow for this task  [y] once  [n] deny`.
A member's session never gets "allow for task" on these (ADR-0027 §14, P24.1.6).

Implementation (P31.3.2, `packages/driver-desktop/`): the checks run in this order, and the first one
that fails answers the call. (1) The pause file `<node folder>/../desktop.pause` refuses every call.
(2) The schema check (the contract's zod schemas). (3) `desktop.input` with `allowInput` off is refused.
(4) More than 10 actions is refused. (5) The points are mapped; a point outside the last screenshot
fails, and `desktop.input` before any screenshot fails with the call to make first. (6) The permission
the call needs is checked (Screen Recording for screenshots, Accessibility for input); a missing one is
`refused-by-policy` and names it. (7) The rate window spends one unit per action (a batch spends its
length, `desktop.info` and `desktop.screenshot` one each); a full window is `refused-by-policy`. A
screenshot over 1 MB is `failed: screenshot too large` and does not move the last screenshot.

Choices made where the contract leaves room: `display` is the 0-based index from `desktop.info`
(`screencapture -D` gets the index plus 1); a scroll names its direction in `keys[0]` (`up`, `down`,
`left`, `right`, default `down`) and moves three lines, because the contract has no amount field; a
screenshot is resized with `sips --resampleWidth` (a second runtime program, next to `screencapture`
and `osascript`); the JPEG size is read from its header in JavaScript. The driver reads no environment
variable; the programs get `PATH` and `LANG` only. `dist/index.js` is built by `bun run build` in the
package and is not committed; the bundle loads through `loadDriver` from the checkout.

## Driver `sandbox` (code execution)

The `sandbox.run` spec is in contracts `CAPABILITIES` (P31.4.1): the core accepts it before any node announces it, and
its risk and approval are the table below. The `driver add` flow is in `node.md` (CLI).
Package `packages/driver-sandbox/` (built to `dist/index.js`; the input is checked against the contract's
`CAPABILITIES['sandbox.run'].input`). It runs on a machine with Docker or Podman (`Bun.which('docker')`, else
`podman`, or the `runtime` option); with neither the driver refuses to start, so `driver add` and `run` leave it out. A dedicated machine or VM is the recommended node. Docker and Podman are runtime
programs of the driver, not repo tools (ADR-0006 needs no entry).

| Capability | Schema v1 | Risk | Approval |
| --- | --- | --- | --- |
| `sandbox.run` | `{ language: 'sh'\|'python'\|'node'\|'bun', code (1 to 100 000 UTF-8 bytes; 100 001 is invalid), stdin? (same limit), timeoutMs? (up to 120 000), network?: boolean }`; returns `{ stdout, stderr, exitCode, timedOut, truncated }` | `write` without network; `external` with `network: true` | `approval: 'never'` for `write`, so a snippet does not ask the owner; `network: true` asks the owner and works only when the node's `network` option is on |

Container per call: `run --rm --name keith-sbx-<callId> --pull never --network none` (without network),
`--read-only`, `--tmpfs /tmp:rw,size=64m`, `--tmpfs /work:rw,size=64m`, `-w /work`, `--memory 512m --cpus 1
--pids-limit 128 --cap-drop ALL --security-opt no-new-privileges`, `--user 65534:65534`, `--entrypoint <sh|python|node|bun>`
and the code as the one argument of that program's `-c` or `-e` flag. `-i` is added only with `stdin`. The
image comes from the node's allowlist (`image.sh`, `image.python`, `image.node`, `image.bun` options; the defaults
are pinned by tag in `src/images.ts`, because the driver-sdk manifest schema is strict; set with
`driver add --image python=…`). `--pull never`: a call never pulls. The runtime program gets a minimal
environment (`PATH`, `HOME`, `LANG`, the Docker or Podman connection variables), never the node's other variables. A hard timeout kills the container by its name (`docker kill`); the name is fixed,
`keith-sbx-<callId>`, so cancel and timeout always clean up. Output is capped like `shell.exec`
(head and tail, 30 000 characters). At most `maxConcurrent` containers per node (default 2); more is
`busy`. No host mounts, no secrets, no Keith environment. Images are pulled at `driver add` (with a
confirm, never during a call).

Worker instructions (`SANDBOX_INSTRUCTIONS`, `motor.md`, only while an online node announces `sandbox.run`): code
goes to `sandbox.run`, not to `shell.exec` on a real machine; say that it has no network; it sees only the files
named in `files`, and the outputs named in `outputFiles` are saved in the person's sandbox folder; return results
inline. While none is online, `NO_SANDBOX_INSTRUCTIONS` says code cannot run and that the
core is never offered as the place to run it. Schema v2 (files, P31.6.2). The announcement is schema 2; the driver accepts 1 and 2. The model gives
`files?: [{ ref, name }]` (at most 5; `name` is a plain file name: letters, digits, `.`, `-`, `_`, at most 128
characters) and `outputFiles?: [name]` (at most 5, each named once); the contract is `SandboxRunInputV2Schema`, the
node's is `SandboxRunWireSchema`. The core resolves each `ref` with `resolveWorkspacePath` for the person of the run
(`platform/workspace-resolve.ts`, rules in `cortex.md`); a refusal is `path-refused` and names the ref, and nothing
runs. It reads each file (at most 1 MB), sends `files: [{ name, data }]` with `data` as base64 in the invoke input,
and writes `workspace.file.send` per file before the call is sent. The node never sees a core path. The node's result
carries `files: [{ name, data }]` and `missing: [name]` (asked for and not produced, or over 1 MB). The core writes
each returned file to `people/<id>/sandbox/<name>` through the resolver (a name that was not asked for is dropped),
and gives the model `saved: [{ name, path, bytes }]` and `missing`, never the bytes. A v1 call that names files is
refused (`files need sandbox.run schema version 2`); a v1 call without files runs as before.

Mechanism (the choice, because the contract leaves it open). A call with files creates the container with the same
flags and `--entrypoint sleep` (`create`, kept for 600 s), starts it, copies each input file in with `exec -i`
(`sh -c 'base64 -d > "$0" && chmod 444 "$0"'`, the base64 on stdin), runs the code with `exec`, reads each output
with `exec` (`head -c 1000001` then `base64`, so a larger file is seen as too large), and removes the container with
`rm -f`, in every case. `docker cp` was rejected: the work folder is a `--tmpfs` mount, and a copy into it lands
under the mount and is hidden when the container starts. No host path is mounted and no folder on the node is
shared with the container. A timeout or a cancel kills the container by its name, which ends its `exec`s. The fake
runtime records the sequence (`create`, `start`, `stage`, `exec`, `read`, `rm`); a real container is the manual
scenario of P31.4.5. Each result file is at most 1 MB and five at most; the stdout cap is unchanged.

Core side: `cortex.general` stays the only worker that may call `motor_remote`; no core code runs code
(ADR-0021 §3). `doctor` lists `sandbox: node <name> online` or `no sandbox node: code cannot run (the
core never runs code for a worker)` (`cli/doctor/checks/sandbox.ts`). A test greps the `Bun.spawn`
and `$` call sites of `apps/core` against an allowlist.

## Core node shell

Built (P24.2.1, ADR-0027 §12, ADR-0021 §3). `apps/core/src/modules/nodes/core-node.ts`: `cwd` is
resolved against the workdir and `realpath`-ed; a result outside it (`..`, absolute path, symlink) is
`refused-by-policy`. The environment is `Config.shellEnv`, which holds only `PATH`, `HOME` and `LANG`;
a planted secret key is absent from a command. The core node keeps `shell.exec` only for the owner's
approved commands. It has no `desktop` or `sandbox` driver: it is not a daemon. Its parity tests are in
`core-node.test.ts` (P31.1.1).

## Client capabilities (ecosystem layer)

ADR-0023 §5, ADR-0025 §1 and §5. P27 owns the registry (`modules/parietal/capabilities.ts`: `notify`,
`open.view`, `location.share`, ids as in ADR-0023 §5, `layer: 'ecosystem'`) and the route
`parietal.callClient` (feed record `brain.parietal.deliver`, ack `presence.clients.ack` with
`result?`, one shot, 10 s, the same person and client id). This plan adds no second id space, no
`client.invoke` record and no bus.

- A node cannot announce a client capability: the node registry refuses it `wrong-layer`, the node
  stays online with its other capabilities, and `nodes_status` lists no client capability.
- Only that person's turns may call one, through two entries. The model tool `client_call({
  capability, input })` of the front agent (`modules/parietal/client-tools.ts`) always targets
  `ctx.principal.id`; it has no person parameter. And the system entry for a person: the P25 planner
  (`createPresencePlanner`) already reaches `callClient` for a `notify` step of P25 and P28, so no second
  entry exists. Workers, rooms (P30) and guests have no `client_call` tool.
- The `client_call` description is fixed text (audit F9). The capabilities an online app of the person has at that turn (ADR-0033 §6) are listed in the
  turn reminder line `Apps online now: ...`, so `location.share` is not offered while no app announced it; a capability not listed there is unavailable.
- `location.share` returns data only when the person turned sharing on in the client (opt-in,
  ADR-0025 §1); the result goes to P27 as a `device.location` signal. The terminal client
  announces `notify` and `open.view` (with `chat` and `render.markdown`), never `location.share`.
- An ecosystem call is never visible in the self layer or to the owner (ADR-0027 §9 does not reach it).
- Audit `client.call` `{ person, capability, ok }`: no input and no output. Visible to the person in
  `audit.mine`.

## Workspace references

ADR-0021 §2. `resolveWorkspacePath(caller, path)` (`platform/workspace-resolve.ts`; the rules are in `cortex.md`,
"Workspace references") resolves a path against the caller's own folder `people/<caller id>/` or a room the
caller is a member of, nothing else. It refuses `..`, absolute paths, symlinks out, another person's folder
and `keith/` (`path-refused`). A file that leaves Keith is audited as `workspace.file.send { person, path,
bytes }`: the path and the size, never the content. The leak and rights test (a worker asks for another person's file and for `keith/`; the output lands in its own folder only; the planted content appears nowhere of the caller's) is `apps/core/src/workspace-files.e2e.test.ts`.

## Errors

A call's outcome codes (`InvokeErrorCode` and the tool result codes of `motor.md`). Existing:
`unknown-node`, `offline`, `unknown-capability`, `refused-by-policy`, `timeout`, `cancelled`,
`failed`, `busy`. Also in use: `unsupported-version`, `driver-unavailable`,
`rate-limited`, `no-client`, `path-refused`. A driver's `busy` reaches the wire as `busy` (the node code of `node.md`) and the tool output reads `busy, try again later: <message>`. A message says what the owner can do, for
example `run keith-node driver add desktop on laptop-e`.

## Audit

| Kind | Written when | Holds |
| --- | --- | --- |
| `node.drivers` | a node's driver set changes between connections | node, driver name and version added, removed or changed; no paths |
| `node.capability.refused` | once per distinct refusal per connection | node, id, schema version, reason |
| `client.call` | a `client_call` of the front agent | person, capability, ok (no input, no output; the planner's calls write `delivery.sent` instead) |
| `workspace.file.send` | a file leaves Keith by reference | person, path, bytes |

The approval rows already carry node and capability (ADR-0027 §7) and gain the driver name. The two node kinds are registered in `AUDIT_SUBJECT_FIELDS` with no field (a node names no
person) and hidden from `mine` (`hideFromMine`, P23.2.3); the owner reads them in the audit log.

## Progress caps

A driver's `progress(chunk, stream?)` is forwarded to the core as `progress` messages (`node-protocol.ts`). The node caps the
progress of each call (`apps/node/src/executor/progress-cap.ts`, `createProgressCap`, one per dispatch). The numbers:

- **bytes**: 64 KiB of UTF-8 per call in all (`PROGRESS_BYTES_CAP = 65 536`); a chunk that would pass it sends the characters that
  still fit and closes the call;
- **line**: 4 KiB per line (`PROGRESS_LINE_CAP = 4 096`); a longer line keeps its first 4 KiB, the rest of that line is dropped (a line
  that continues across chunks counts as one line);
- **rate**: 100 chunks in any one second (`PROGRESS_CHUNKS_PER_SECOND = 100`), counted from the first chunk of the window.

The first time a cap is hit the node sends one marker line `[progress truncated]` (stream of the chunk that hit it) and the call's progress is
closed: nothing more is forwarded for that call, whatever the caps say after. The driver is never blocked: `progress()` returns at once, the
excess is dropped. The final result of the call keeps its own cap (`OUTPUT_CAP`, 30 000 characters, `shell.exec`).

## Settings

- `nodes.sandbox.maxPerHourPerPerson` (default 60, integer 1 to 1000): read by `motor_remote` (`motor.md`, Invariants) at each call.
- RPC `nodes.settings.get` (`settings.read`) and `nodes.settings.set` (`NodeSettingsSchema` `{ maxPerHourPerPerson }`, `settings.manage`,
  step-up from a remote caller). An out-of-bound or non-integer value is `BAD_REQUEST` and nothing is written. The handler writes one
  `settings.nodes.set` audit row with `{ from, to }` (no subject: the setting is the node's, not a person's). A corrupt stored value reads
  as the default.
- CLI: `keith-core nodes sandbox-limit [<n>]` (`cli/ops-commands.ts`, owner socket). No argument prints the value; a whole number
  1 to 1000 sets it (`nodes.settings.set`; a remote caller with the owner's token takes the step-up, as above). A value outside the
  bounds, a fraction or a word is a usage error (exit 2) and nothing is written. Tests: `cli/nodes-command.test.ts`.

Everything else is node-side configuration (the driver options above).

## Decision points

- ADR-0023 §1: the core is the authority; risk and approval come only from the core's specs (points
  P31.1.4, P31.1.6).
- ADR-0023 §2: a capability is id, schema, risk and approval (P31.1.3, P31.1.4).
- ADR-0023 §3: drivers, `keith-node driver add`, the manifest announces them, the core finds nodes by
  capability (`byCapability`), a driver has no tools or Keith data (P31.2.1 to P31.2.4, P31.1.5).
- ADR-0023 §4: rights on the node, approval in the core, nodes are the self layer (P31.1.6, P31.1.7,
  P31.3.5).
- ADR-0023 §5: client capabilities belong to the person's ecosystem; only that person's turns call them
  (P31.5.1 to P31.5.5).
- ADR-0021 §2: files move by reference, resolved against the caller, audited by path (P31.6.1 to P31.6.3).
- ADR-0021 §3: the core never runs code for a worker; a sandbox node runs it; the core shell is confined
  like a node (P24.2.1, P31.4.x).
- ADR-0027 §9 (self layer, `nodes.read`), §12 (core shell confinement), §13 (token and join rules for
  the node daemon), §28 (token rotation and message budget, protocol 2).
- ADR-0020 §3 (one principal per turn, no borrowed rights): P31.3.6, P31.5.3, P31.5.5.

## Invariants

The invariants below hold in the code (the core shell one since P24.2.1).

- Risk and approval for a capability come from the core's spec only; a manifest cannot lower them.
- A refused capability never reaches a node; the rest of the node stays online.
- A driver runs only with the node's own rights and a hash that matches its install.
- `approval: 'never'` is only for capabilities whose risk never exceeds `write`.
- The core never runs code or shell commands for a worker; no path in `apps/core` does.
- A client capability is only called for the person whose turn asked, never another person's client.
- Audit rows hold ids, paths, sizes and reasons, never content, input or output.

## Known limits

- Driver progress is capped per call ("Progress caps"): 64 KiB, 4 KiB per line, 100 chunks a second. A call whose progress is cut
  loses the rest of its progress (one marker line), not its result.
- Desktop JXA scripts (`osascript -l JavaScript`) are not run on a real Mac in tests; the tests use a fake backend.
- Sandbox image tags (`packages/driver-sandbox/src/images.ts`) are unverified until a real pull; the manual
  scenario of P31.4.5 is the check.
- The system `notify` path (a planner step of P25 and P28) is covered by planner tests only, not end to end.

## Tests

`node-capabilities.test.ts` (contracts: v1 and v2 manifests, 17 drivers and a bad id fail, a spec with
`approval: 'never'` and an external risk is rejected), the registry refusal table, the driver loader, executor
dispatch, desktop with a fake backend, the sandbox argument list with a fake runtime, the client-call isolation,
and the core shell confinement (`core-node.test.ts`). The member's screenshot through a desktop node (approval
routed to the owner, the image in the member's folder only, the owner's worker never sees it) is
`desktop-driver.e2e.test.ts`.
