# P31 — Node drivers, desktop control and the sandbox node

Nov 11, 2026 · status: **done (Nov 11, 2026)** · depends on: P24 (node daemon hardening of ADR-0027 §13; the core shell confinement F-032 is P24.2.1), P26 (protocol v2: token rotation; this plan builds v3 on top), P27 (client capability registry and client route, for phase 5) · ADR: 0023, 0021 §2 and §3, 0020 §1, 0025 §1 and §5, 0027 §9, §12 · closes: ADR-0023 §2–§5, ADR-0021 §2 (files by reference, phase 6), ADR-0021 §3 (the core never runs code for a worker; execution happens on a sandbox node); relies on P24.2.1 for F-032 (verified in P31.1.1)

## Goal

A node is a body part that can grow new abilities without changing the core: the owner installs a driver on a machine (`keith-node driver add desktop`),
the node announces it, and Keith finds the capability, checks that it understands the schema, asks the owner before anything risky, and uses it. The
first two drivers make Keith more useful and safer at once: `desktop` (see the screen, move the mouse, type: computer use) and a `sandbox` node that
runs code the model writes in a disposable container, so the core never executes code. Client abilities (notify, open a view, share location) use
the same capability model but belong to one person only.

## Why

- ADR-0023 §2–§5: capability manifest entry with schema, risk and approval; drivers as the way to add capabilities; rights on the node, approval in the core; clients as nodes of a person's ecosystem. Consequence: "a manifest version per driver, the core refuses a capability whose schema it does not know".
- ADR-0021 §3: the core never runs code or shell commands for a worker; execution is on a node, including a sandbox node that is a disposable container; the core's own shell stays only for the owner's approved commands, confined like a node.
- F-032 (`docs/flow-review/2026-11-09-full/REPORT.md`, traceability row D3/REQ-139): the core node's shell had 8 env keys and a cwd that was only `resolve()`d (`apps/core/src/modules/nodes/core-node.ts`), while a node uses `PATH, HOME, LANG` and a realpath check. ADR-0027 §12 fixes it in P24.2.1; this plan only verifies it.
- ADR-0021 §2: workspace files move by reference and are audited by path; no plan owned it, so phase 6 here does (the sandbox and the next file-sending tools need it first).
- ADR-0027 §9: nodes are Keith's self layer, readable by members with `nodes.read`; capabilities and drivers are part of what they read, never an owner-only secret.
- Today the capability table is a static enum in `packages/contracts/src/node-protocol.ts` (`CAPABILITIES`, `CapabilityIdSchema`): a node announcing anything else fails its `hello` as a whole. Nothing can be added without a core release.
- P22 roadmap: this plan is the drivers and sandbox part (was M7).

## Scope

In:

- Capability model: manifest v2 (drivers, per-capability schema versions), a core registry of capability specs (risk, approval, schema, layer), discovery by capability, refusal of unknown ids and versions per capability (the node stays online with the rest), compatibility with v1 nodes.
- Driver package format, `@keith/driver-sdk`, `keith-node driver add|list|remove`, announcement in `hello`, per-driver options and policy on the node.
- First-party drivers `desktop` (`desktop.info`, `desktop.screenshot`, `desktop.input`, macOS backend) and `sandbox` (`sandbox.run` in a disposable container, no network by default).
- Computer-use guidance for workers (instructions, image results through eharness media support, approvals).
- Approval for risky capabilities through the existing amygdala path, with risk that may depend on the input.
- Client capabilities `notify`, `open.view`, `location.share` (ADR-0023 §5 ids): the registry and the route belong to P27; this plan adds only the front-agent tool `client_call`, the node-side `wrong-layer` rule and the TUI handler for `open.view`.
- Workspace references (phase 6): `resolveWorkspacePath(caller, path)` and files in and out of `sandbox.run` by reference (ADR-0021 §2).
- Verifying the core node shell confinement of P24.2.1 (F-032): tests only.

Out:

- A driver registry, signing or download from the internet: a driver is a bundled first-party package or a local folder the node owner points at. Remote install is a later decision (it needs a trust model).
- IoT and home security drivers (`iot.switch`): they will be drivers on this model; not built here.
- Linux and Windows desktop backends (the contract is backend-neutral; macOS first because that is the owner's machine).
- Plugin-provided capability specs (`k.nodes.register`) and the core part of a plugin that finds nodes by capability: the registry has `register()` and `byCapability()`, and a plugin host port is a follow-up once a plugin needs it (ADR-0023 §3 describes the intent; no plugin does yet).
- Mobile and web clients (capabilities are defined in P27; only the TUI is served).
- Moving a node's drivers while the node runs (add or remove takes effect at the next `keith-node run`).
- Disk quotas for the sandbox, GPU, long-lived containers. `sandbox.run` schema v1 takes inline code and returns text; files by reference arrive in phase 6 as schema v2.

## Design

### Capability model (contracts)

New file `packages/contracts/src/node-capabilities.ts` (exported through `index.ts`; the name avoids `capability-registry.ts`, which is for person capabilities):

- `CapabilityIdSchema`: string `^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$` at most 64 characters: `<driver>.<action>` (`system.info`, `shell.exec`, `desktop.screenshot`, `sandbox.run`). The first segment is the driver name. It replaces the enum of `node-protocol.ts`; `CAPABILITIES` and `capabilityRisk` stay exported with the same behaviour for the built-ins (they now read from the specs below), so existing callers keep compiling.
- `NodeCapabilitySpec` (core side, TypeScript, holds zod objects, never sent): `{ id, version (int, the newest), supports: number[] (versions the core can talk), driver, layer: 'self' | 'ecosystem', summary, risk: Risk | ((input) => Risk), approval: 'by-risk' | 'never', input: ZodType, output?: ZodType }`.
  - `approval: 'by-risk'` (default) is today's rule: `read` is approved, anything riskier asks the owner. `'never'` is allowed only when `risk` can never exceed `write` for any input (checked when the spec is registered), and is used only by `sandbox.run` without network.
  - `risk` may be a pure function of the input (`sandbox.run` is `write` without network and `external` with network). It is still decided from the input and static tables, never live state (AGENTS.md gotcha on `tool.approve`).
- Wire manifest, `NodeManifestSchema` becomes a union of v1 and v2:
  - v1 (today): `capabilities: string[]`, `policy: { allowShell }`. The core maps it to the drivers `system` and `shell` at schema version 1.
  - v2: `{ manifestVersion: 2, name, os, arch, version, policy: { allowShell }, drivers: [{ name, version (semver of the driver), capabilities: [{ id, schemaVersion }], options?: JSON (public facts only: `allowInput`, `network`) }] }`. At most 16 drivers and 64 capabilities.
- `NodeSchema` (`nodes.ts`) gains `drivers` (name, version) and `refused: [{ id, schemaVersion, reason }]`; `capabilities` stays a list of the **accepted** ids, so the TUI and `nodes_status` keep working.
- Protocol: `PROTOCOL_VERSION` becomes 3 (v2 is P26's token rotation and rate limit; v3 is additive: driver announce and capability schemas; `MIN_PROTOCOL` stays 1; the version table lives in `docs/specs/node.md`, added by P26.4.2); `invoke` gains optional `capabilityVersion`; the node `ErrorCodeSchema` gains `unsupported-version` and `driver-unavailable`.
- No database migration: `nodes.manifest` is already JSON (`db.md`, table `nodes`); the new shape is read by `registry.ts` with the union schema.

### Core: registry, discovery, refusal

`apps/core/src/modules/nodes/node-capabilities.ts` (a `NodeCapabilityRegistry`):

- `register(spec)` at boot only (built-ins: `system.info` read; `shell.exec` destructive; `desktop.info` read, `desktop.screenshot` external, `desktop.input` destructive; `sandbox.run`; the client capabilities live in P27's own registry and are only checked for the `wrong-layer` rule). The registry is frozen before the agents start, so `tool.approve` and `ownerAnswers` read static data.
- `accept(manifest) -> { accepted: [{ id, schemaVersion, driver }], refused: [{ id, schemaVersion, reason }] }`. A capability is refused (the node stays online and keeps its other capabilities) when: the id is unknown (`unknown-capability`), the version is not in `supports` (`unsupported-schema`), the driver name does not match the id's first segment (`driver-mismatch`), or the id belongs to P27's client capability registry (a node cannot announce a client capability: `wrong-layer`). A manifest that does not parse at all is rejected as a whole, as today (`welcome` with `accepted: false`).
- A node can never lower risk: risk and approval come only from the core's spec; the manifest says what exists, not what it needs.
- `NodeRegistry` gains `byCapability(id, { version? }) -> Node[]` (online first), the lookup a future core plugin or protocol uses; `find` and `invoke` are unchanged. `invoke` sends `capabilityVersion` (the highest version both sides support) and refuses a call to a refused capability with `unknown-capability` before anything is asked.
- Audit: `node.drivers` when a node's driver set changes between connections (added, removed, version changed; ids only), `node.capability.refused` once per distinct refusal per connection. Events: the existing `node-changed` carries the new fields.

`motor_remote` (`apps/core/src/modules/motor/remote.ts`) becomes generic: the capability is checked against the registry instead of `CAPABILITIES`, the input is parsed by the spec, `tool.approve` uses the spec's risk and `approval`, `ownerAnswers` (`motor/risk.ts`) reads the same registry (anything that still asks is answered by the owner, even in a member's session: ADR-0027 §9 stays, members see nodes, only the owner answers risky approvals), and the grant scope stays `<node id>:<capability>`. `MOTOR_INSTRUCTIONS` list the capabilities of the registry; the instruction text for `desktop` and `sandbox` is added by those drivers' phases.
Per-person limit for capabilities with `approval: 'never'`: `nodes.sandbox.maxPerHourPerPerson` (default 60, 1 to 1000, a setting) counted in memory per principal; the 61st call is refused with `rate-limited` and a message naming the limit. The principal is the worker's (`ctx.principal`), so a member cannot spend the owner's allowance.

### Driver package and `keith-node driver`

- **Package format.** A folder (or workspace package) with `keith-driver.json` and a built entry module:
  ```json
  { "manifestVersion": 1, "name": "desktop", "version": "0.1.0", "entry": "dist/index.js",
    "capabilities": [{ "id": "desktop.screenshot", "schemaVersion": 1 }], "platforms": ["darwin"], "needs": ["screen-recording"] }
  ```
  The entry exports `default defineDriver({ name, version, capabilities, async start(ctx), invoke(call, ctx) })` from `@keith/driver-sdk`. `ctx` gives: a logger, the node's `workdir`, the driver's options, `signal` for cancel, `progress(chunk)`. A driver has **no** tools, prompts or Keith data (ADR-0023 §3): the SDK does not expose the core URL, the token, the node config or other drivers; `invoke` returns `{ ok, output, exitCode? }` or a failure code.
- **`@keith/driver-sdk`** (`packages/driver-sdk/`, imports only `@keith/contracts`): `defineDriver`, `DriverManifestSchema`, `loadDriver(path)` (validates the manifest, checks `platforms`, imports the entry), the capability call and result types. A check-imports rule restricts `packages/driver-*` to `@keith/contracts` and `@keith/driver-sdk`.
- **Node config** (`apps/node/src/platform/config.ts`, still the only place that reads env, zod schema): `drivers: [{ name, source: 'bundled' | 'path', path?, sha256, options }]`; `sha256` is the hash of `keith-driver.json` plus the entry file at install time; `run` refuses a driver whose files changed (`driver changed since it was added: run keith-node driver add again`), because a driver is code with the node's rights.
- **CLI** (`apps/node/src/driver-command.ts`, registered in `commands.ts`, built on `@keith/cli` so `--help` is generated):
  - `keith-node driver list`: installed drivers with version, capabilities, options, and whether the platform and OS permissions fit; plus the bundled ones that can be added.
  - `keith-node driver add <name|path> [--option key=value …] [--allow-input] [--runtime docker|podman] [--network]…` (flags are the driver's declared options): a bundled name or a folder path; prints what the driver can do and what it needs ("desktop needs Screen Recording and Accessibility permission for your terminal") and asks to confirm (`--yes` skips); writes the config; says `restart keith-node run to announce it`.
  - `keith-node driver remove <name>`: removes it from the config. Both commands touch only the local config; nothing is sent to the core. The core learns at the next `hello` and audits `node.drivers`.
- **Announcement.** `buildManifest(name, policy, drivers)` (`apps/node/src/manifest.ts`) emits v2 with the drivers the node loaded successfully; a driver that fails to load (platform, changed hash, missing permission) is logged and left out, the node still runs. `join` sends the same manifest (`JoinRequest.manifest`).
- **Executor.** `apps/node/src/executor/index.ts` keeps `system.info` and `shell.exec` as the built-in drivers `system` and `shell` (the same code, now registered like any driver), and dispatches every other capability to its driver by id, after the node-side checks (driver loaded, version supported, node policy). A call to something unknown still ends in exactly one `unknown-capability` result.
- **Rights on the node.** Each driver keeps its own policy in its options (shell: `--allow-shell`; desktop: `allowInput`; sandbox: `network`, images). The node may run as root; what it allows is its manifest (ADR-0023 §4). Approval is never decided on the node.

### Driver `desktop` (computer use)

Package `packages/driver-desktop/`. macOS backend only (`platforms: ["darwin"]`), no dependency: `screencapture -x -t jpg` (built in) for images, `osascript -l JavaScript` with the `ApplicationServices` bridge for mouse events and `System Events` for keys and text.

| Capability | Schema v1 | Risk | Notes |
| --- | --- | --- | --- |
| `desktop.info` | `{}` returns `{ displays: [{ id, width, height, scale }], frontApp? }` | `read` | no approval |
| `desktop.screenshot` | `{ display?, maxWidth? (default 1280) }` returns an image plus `{ width, height, scale }` | `external` (the pixels reach the model provider) | one approval, then `remember: session` for the owner's own sessions as for shell (grant scope `<node id>:<capability>`) |
| `desktop.input` | `{ actions: [ { type: 'move'\|'click'\|'double_click'\|'right_click'\|'drag'\|'scroll'\|'type'\|'key', x?, y?, to?, text?, keys? } ] }`, at most 10 actions | `destructive` | asked each time unless remembered; coordinates are in the pixel space of the latest screenshot and the driver maps them with the screen scale |

Node policy (driver options, set at `driver add`): `allowInput` (default off: screenshots only), `maxActionsPerMinute` (default 60), and a stop file `<workdir>/../desktop.pause` whose presence makes every desktop call `refused-by-policy` (the owner's emergency brake). A call returns `refused-by-policy` without OS permission and names which permission is missing (`Screen Recording`, `Accessibility`); the OS prompts are manual.
Results and images: the driver returns the screenshot as base64 in the `output`; the core's `motor_remote` converts an image output to the MCP-style result `{ content: [{ type: 'image', data, mimeType }] }` that eharness understands (`.ref/eharness/docs/specs/09-tools-and-mcp.md` "Media offload", `03-messages.md` step 5b), so the stored history keeps a file reference in the person's workspace and the worker agent sends only the newest images to the model (`toolOutput.keepImages: 3`, set in `apps/core/src/modules/cortex/workers.ts` hardening). A screenshot over 1 MB is refused by the node (`failed: screenshot too large`; the WebSocket cap is 4 MB). **No eharness gap**: the media path exists; nothing goes upstream. The worker model must accept images; a worker on a text-only model gets a clear `image not supported by the model` note and `doctor` warns.
Instructions (`MOTOR_INSTRUCTIONS`, only when some online node announces `desktop.*`): the observe, act, observe loop; coordinates come from the last screenshot; stop and ask the person at any password, payment or two-factor prompt; never type secrets; one action batch at a time.

### Driver `sandbox` (code execution, ADR-0021 §3)

Package `packages/driver-sandbox/`. It runs on a machine with Docker or Podman (`Bun.which('docker')`, else `podman`; none: the driver refuses to load). The recommended node is a dedicated machine or VM; the driver itself keeps the container disposable.

| Capability | Schema v1 | Risk | Approval |
| --- | --- | --- | --- |
| `sandbox.run` | `{ language: 'sh'\|'python'\|'node'\|'bun', code (up to 100 KB), stdin?, timeoutMs? (up to 120 000), network?: boolean }` returns `{ stdout, stderr, exitCode, timedOut, truncated }` | `write` without network, `external` with `network: true` | `approval: 'never'` for `write`, so the owner is not asked for every snippet; a call with `network: true` is `external` and asks the owner (and only works if the node's `network` option is on) |

Container per call: `run --rm --network none` (without `network`), `--read-only`, `--tmpfs /tmp:rw,size=64m`, `--tmpfs /work:rw,size=64m`, `--memory 512m --cpus 1 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges`, user `65534`, image from the node's allowlist (`images: { sh, python, node, bun }`, defaults pinned by tag in the driver's manifest, configurable at `driver add --image python=…`), a hard timeout that kills the container by name (`docker kill`), a fixed name `keith-sbx-<callId>` so cancel and timeout always clean it, output capped like `shell.exec` (head and tail, 30 000 characters), at most `maxConcurrent` containers per node (default 2; more is `busy`). No host mounts, no secrets, no Keith environment. Pulling an image happens at `driver add` (`docker pull`, with a confirm), never during a call.
Instructions for workers: use `sandbox.run` for code (not `shell.exec` on a real machine), say that it has no network and no files from the person, return results inline. Files by workspace reference are out of scope here (ADR-0021 §2 later).
Core-side: `cortex.general` stays the only worker that may call `motor_remote`; no core code runs code (ADR-0021 §3). The doctor line lists `sandbox: node <name> online` or `no sandbox node: code cannot run (the core never runs code for a worker)`.

### Core node shell (F-032, ADR-0027 §12)

`apps/core/src/modules/nodes/core-node.ts`: cwd is resolved against `workdir` and `realpath`-ed, a result outside the workdir is `refused-by-policy` (same rule as `apps/node/src/executor/shell.ts`, `resolveCwd`); the environment is built by one function giving only `PATH`, `HOME`, `LANG` (`apps/core/src/platform/config.ts` `shellEnv`, today 8 keys). The core node keeps `shell.exec` only for the owner's own approved commands and still has no `desktop` or `sandbox` driver (it is not a daemon). P24.2.1 owns the change; step P31.1.1 only verifies it and adds the driver-dispatch parity tests.

### Client capabilities (ecosystem layer, ADR-0023 §5, ADR-0025): reuse of P27

- P27 owns the registry (`modules/parietal/capabilities.ts`: `notify`, `open.view`, `location.share`, ids exactly as ADR-0023 §5, `layer: 'ecosystem'`) and the route `parietal.callClient` (feed record `brain.parietal.deliver`, ack `presence.clients.ack` with `result?`, one-shot, 10 s, same person and client id). This plan adds no second id space, no `client.invoke` record, no `clients.result` RPC and no `ClientCapabilityBus`.
- A node cannot announce a client capability: the node registry refuses any id that P27's registry owns as `wrong-layer`.
- **Only that person's turns may call them.** Two entries: the model tool `client_call({ capability, input })` of the front agent resolves the target as `ctx.principal.id` (it has no person parameter) and calls P27's `callClient`; and the code path used by the delivery service and protocols (`notify` steps of P25 and P28), a system act for a person. Workers, rooms and guests have no `client_call` tool.
- `location.share` returns data only when the person turned sharing on in the client (opt-in, ADR-0025 §1); the result goes to P27 as a `device.location` signal. The TUI announces `notify` and `open.view` only.
- Audit: `client.call` `{ person, capability, ok }` (no input, no output); an ecosystem call is never visible in the self layer or to the owner.

### Audit, events, errors, settings

- Audit kinds added: `node.drivers`, `node.capability.refused`, `client.call` (registered in `AUDIT_SUBJECT_FIELDS` and `registerMySummary`, P23.2.3), `workspace.file.send` (phase 6); the existing approval rows already carry node and capability (ADR-0027 §7), and gain the driver name.
- Errors of a call (`InvokeErrorCode` and the tool result codes): `unknown-capability`, `unsupported-version`, `driver-unavailable`, `refused-by-policy`, `rate-limited`, `busy`, `no-client`, `path-refused`, `timeout`, `cancelled`, `failed`. Messages say what the owner can do (`run keith-node driver add desktop on laptop-e`).
- Settings: `nodes.sandbox.maxPerHourPerPerson` (above). Everything else is node-side config.
- TUI: Manage `Nodes` section (`apps/tui/src/features/manage/nodes/`, `apps/tui/src/features/nodes/`) shows, per node, the drivers and the capabilities as `desktop 0.1.0 · screenshot input` and a muted `refused: iot.switch (unknown capability)`; the approval dialog (`apps/tui/src/features/approvals/`) shows the capability and, for `desktop.input`, the action list in plain words (`click (412, 230)`, `type "hello"`). Copy: `Allow desktop.screenshot on laptop-e? [a] allow for this task  [y] once  [n] deny`.

## Phases

### Phase 1 — Capability model in the core

Goal: the core understands versioned capabilities and refuses what it does not know, with the built-ins unchanged for users, and the core shell confined.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P31.1.1 | Verify-only: the core node shell confinement landed in P24.2.1 (`SHELL_ENV_KEYS` is `PATH, HOME, LANG`; realpath cwd containment). Add only the missing parity cases to `core-node.test.ts`; no production change. If a case fails, the fix belongs to P24.2.1. | `apps/core/src/modules/nodes/core-node.test.ts` | nodes.md (core node), motor.md, ADR-0021 §3 | cwd `..`, absolute path and a symlink out of the workdir are `refused-by-policy`; the spawned env has exactly three keys (a planted `KEITH_SECRET_KEY` is absent); driver dispatch does not widen env or cwd | `bun test ./apps/core/src/modules/nodes` passes with no production diff |
| P31.1.2 | Write the specs: `docs/specs/node-drivers.md` (capability model, manifest v2, driver format, CLI, desktop, sandbox, client capabilities), update `nodes.md`, `node.md`, `motor.md` | `docs/specs/node-drivers.md` (new; it says that `docker`, `podman`, `screencapture` and `osascript` are runtime programs of the drivers, not repo tools, so ADR-0006 needs no entry), `docs/specs/README.md`, `nodes.md`, `node.md`, `motor.md` | those files | none (doc) | every rule of Design is in a spec, each ADR-0023 point cited |
| P31.1.3 | Contracts: capability id, `NodeCapabilitySpec`, manifest v1 and v2 union, `Node` fields, `invoke.capabilityVersion`, error codes, protocol version 3 (on top of P26's v2) | `packages/contracts/src/node-capabilities.ts` (new), `node-protocol.ts`, `nodes.ts`, `index.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`) | node-drivers.md "Contracts" | `node-capabilities.test.ts`: v1 manifest parses; v2 parses; 17 drivers and a bad id fail; a spec with `approval: 'never'` and a risk function that can return `external` is rejected at registration; `node-protocol.test.ts` still passes (`MIN_PROTOCOL` pinned at 1, v2 messages of P26 still parse) | `bun test ./packages/contracts` passes |
| P31.1.4 | Core registry: `register` (boot only, then frozen), `accept` (accepted and refused with reasons), the built-in specs `system.info`, `shell.exec`; `capabilityRisk` and `CAPABILITIES` read from it | `apps/core/src/modules/nodes/node-capabilities.ts`, `.../node-capabilities.test.ts`, `packages/contracts/src/node-protocol.ts` | node-drivers.md "Core: registry" | unknown id refused; version 9 refused `unsupported-schema`; `desktop.screenshot` announced by a node under driver `shell` refused `driver-mismatch`; a node announcing `open.view` refused `wrong-layer`; a node announcing `notify` or `location.share`: the manifest regex (`<driver>.<action>`) refuses the id and the whole manifest is rejected (node-drivers.md states that outcome; a client capability id never reaches the registry); registering after the freeze throws; v1 manifest maps to `system` and `shell` | tests pass |
| P31.1.5 | Registry integration: `connect()` stores accepted and refused, `Node` shows drivers and refused, `byCapability`, `invoke` sends the version and refuses a refused capability, audit `node.drivers` and `node.capability.refused` | `apps/core/src/modules/nodes/{registry,gateway,types}.ts`, `registry.test.ts`, `gateway.test.ts`, `apps/core/src/testing/test-node.ts` | nodes.md (Connection) | a node with one unknown capability stays online with the others; reconnect with a changed driver set writes one `node.drivers` row; a bad manifest is still rejected as a whole | tests pass |
| P31.1.6 | `motor_remote` generic over the registry (parse by spec, risk function, approval `never`, grant scope), `ownerAnswers` from the registry, instructions from the registry, per-person limit for `approval: 'never'` | `apps/core/src/modules/motor/{remote,risk}.ts`, `motor.test.ts`, `risk.test.ts`, `apps/core/src/motor.e2e.test.ts` | motor.md ("Who answers", Invariants) | every existing motor test unchanged and passing; a test spec with a risk function asks the owner only with the risky input; `approval: 'never'` runs without asking; the 61st call per hour per principal is `rate-limited`; a member's risky call is still answered by the owner | tests pass |
| P31.1.7 | TUI and `nodes_status` show drivers and refused capabilities; doctor lines | `apps/tui/src/features/manage/nodes/`, `apps/tui/src/features/nodes/`, `apps/tui/src/testing/fake-core.ts`, `apps/core/src/modules/motor/status.ts`, `apps/core/src/cli/doctor/checks/drivers.ts` (new, listed in the table of `cli/doctor.ts`) | tui.md (Nodes), motor.md (`nodes_status`) | state tests render `desktop 0.1.0 · screenshot input` and a muted refused line; a member with `nodes.read` sees the same | tests pass |

`bun run check` passes.

### Phase 2 — Drivers on the node

Goal: the node owner can install, list and remove drivers, and the node announces them.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P31.2.1 | New packages `@keith/driver-sdk`, `driver-desktop`, `driver-sandbox` (scaffold with `bun init` per AGENTS.md rule 6 after reading its current docs, delete the generated `CLAUDE.md` and `.gitignore` in each, then `bun add`/`bun pm pkg set` for dependencies with `catalog:`): `defineDriver`, manifest schema, `loadDriver` | `packages/driver-sdk/`, `packages/driver-desktop/`, `packages/driver-sandbox/` (scaffold only), `AGENTS.md` (three Map rows), `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `scripts/check-imports.ts` and its test (rule: `packages/driver-*` import only `@keith/driver-sdk` and `@keith/contracts`), root `package.json` only through `bun pm pkg` | node-drivers.md "Driver package" | `loadDriver` rejects a bad manifest, a wrong platform and a missing entry; a driver module cannot import `@keith/client` or `apps/*` (check-imports test) | `bun run check-imports` passes |
| P31.2.2 | Node config `drivers` with hashes; read only in `platform/config.ts` | `apps/node/src/platform/config.ts`, `config.test.ts` | node.md (Config file) | old config without `drivers` still loads; a changed driver file fails the hash check with the message | tests pass |
| P31.2.3 | `keith-node driver` subcommands `add`, `list` and `remove` | `apps/node/src/driver-command.ts`, `commands.ts`, `driver-command.test.ts` | node.md (CLI table), cli.md | add of a bundled name writes config after confirm; `--yes` skips; a path folder is validated and hashed; list shows what is installed and what can be added; remove deletes only the entry; every command takes `--config` | `keith-node driver --help` lists the three |
| P31.2.4 | Manifest v2 from installed drivers (drivers that fail to load are left out and logged), join sends it | `apps/node/src/manifest.ts`, `join.ts`, `run.ts`, `join.test.ts`, `run.test.ts` | node.md (Protocol behaviour) | a node with `shell` and a fake driver announces both; a driver that throws at `start` is absent and the node still runs; `join` body parses as v2 | tests pass |
| P31.2.5 | Executor dispatch to drivers; `system` and `shell` become the built-in drivers; cancel, timeout and progress pass through the SDK | `apps/node/src/executor/index.ts`, `executor/system-info.ts`, `executor/shell.ts`, `executor.test.ts` | node.md (Executor) | all existing executor tests pass; a fake driver capability runs, streams progress and is cancelled; an unknown id gives one `unknown-capability` result; a driver crash gives `failed` and the node keeps running | tests pass |
| P31.2.6 | End to end: a real core and a node with a fake driver announce, the core lists it, an approved call runs, an unknown version is refused | `apps/core/src/node-drivers.e2e.test.ts` | node-drivers.md | the full path over a real WebSocket; the refused capability appears in `nodes.list` with its reason | test passes |

`bun run check` passes.

### Phase 3 — Desktop driver and computer use

Goal: a worker can look at a screen and act on it after the owner approves, safely and visibly.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P31.3.1 | Specs of `desktop.info`, `desktop.screenshot`, `desktop.input` (schemas, risks) and image result mapping in `motor_remote` (MCP-style `content` image) | `apps/core/src/modules/nodes/node-capabilities.ts` (built-in specs), `packages/contracts/src/node-capabilities.ts`, `apps/core/src/modules/motor/remote.ts`, `motor.test.ts` | node-drivers.md "Driver desktop"; motor.md | a fake node returns a base64 image; the tool result is an image content part, text output capping does not truncate it; an image over 1 MB is refused; the approval for `desktop.input` is `destructive` and for `desktop.screenshot` `external` | tests pass |
| P31.3.2 | Driver package `desktop`: backend interface, macOS backend (`screencapture`, `osascript`), scale mapping, batching, rate limit, stop file, `allowInput` | `packages/driver-desktop/` | node-drivers.md | with a fake backend: coordinates are mapped by scale; more than 10 actions refused; the stop file refuses every call; `allowInput` off refuses `desktop.input`; rate limit; permission errors name the missing permission; no test touches a real screen | `bun test ./packages/driver-desktop` passes with no OS access |
| P31.3.3 | Bundle it: `keith-node driver add desktop` works from a checkout, prints the permission notes | `apps/node/package.json` (via `bun add`), `apps/node/src/driver-command.ts`, `docs/manual-testing.md` | node.md | `driver add desktop --yes` on a test config announces `desktop.*` | manual scenario in "Owner to run" |
| P31.3.4 | Worker side: `toolOutput.keepImages: 3` and the `toolMedia` offload into the person's workspace, desktop instructions, vision warning in doctor | `apps/core/src/modules/cortex/workers.ts`, `cortex.test.ts`, `motor/remote.ts` (instructions), `cli/doctor/checks/vision.ts` (new) | cortex.md, motor.md | only the newest three screenshots reach the model (scripted model sees three image parts after five calls); images are written under the calling person's folder and never another's; instructions appear only when a node announces `desktop.*` | tests pass |
| P31.3.5 | Approval copy for desktop actions (actions in words) | `apps/tui/src/features/approvals/`, `approval-state.ts` tests | tui.md (Approval dialog) | the dialog lists `click (412, 230)` and `type "hello"`; a member's session never gets "allow for task" on these (the rule of P24.1.6 holds, no change to it) | tests pass |
| P31.3.6 | Leak and rights test: a member's worker asks for a screenshot; the owner answers; the image lands only in the member's workspace and context; a member cannot approve it | `apps/core/src/desktop-driver.e2e.test.ts` | ADR-0020 §3; ADR-0021 | the file is under `people/<member>/`; the owner's worker does not see it; the approval is routed to the owner | test passes |

`bun run check` passes.

### Phase 4 — Sandbox node

Goal: code runs only in a disposable container on a node, never in the core.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P31.4.1 | Spec `sandbox.run` with the risk function and `approval: 'never'` | `packages/contracts/src/node-capabilities.ts`, `apps/core/src/modules/nodes/node-capabilities.ts`, `node-capabilities.test.ts` | node-drivers.md "Driver sandbox" | without `network` the risk is `write` and no approval is asked; with `network: true` it is `external` and the owner is asked; a 100 001-byte code is invalid | tests pass |
| P31.4.2 | Driver package `sandbox`: runtime detection, argument builder, per-call container name, timeout kill, output cap, concurrency limit, image allowlist | `packages/driver-sandbox/` | node-drivers.md | with a fake runtime that records the command line: flags include `--network none`, `--read-only`, `--cap-drop ALL`, `--pids-limit`, `--memory`, the fixed name and a non-root user; `network: true` is refused when the node's option is off; timeout calls `kill` on the name; a third concurrent call is `busy`; no host mount appears in any argument list | `bun test ./packages/driver-sandbox` passes without a container runtime |
| P31.4.3 | Add flow: `driver add sandbox` asks to pull the images (confirm), records the runtime; `list` shows runtime and images | `apps/node/src/driver-command.ts`, `packages/driver-sandbox/` | node.md | with the fake runtime: confirm pulls, decline records nothing; no runtime found: add fails with the install hint | tests pass |
| P31.4.4 | Worker instructions and doctor: code goes to `sandbox.run`; doctor shows `sandbox: node <name> online` or the warning; the worker never offers to run code on the core | `apps/core/src/modules/motor/remote.ts`, `cli/doctor/checks/sandbox.ts` (new), `modules/cortex/workers.ts` | motor.md, cortex.md, ADR-0021 §3 | scripted worker asked to run Python picks `sandbox.run` when a sandbox node is online and says it cannot when none is; there is no code-running path in `apps/core` (a test greps the `Bun.spawn`/`$` call sites against an allowlist: the core node's shell, `cortex` web search none) | test passes |
| P31.4.5 | Manual and opt-in real-container check (not part of `check` or `smoke`: the machine overheats) | `docs/manual-testing.md` | manual-testing.md | the Owner-to-run scenario with a real Docker or Podman | scenario written and run once |

`bun run check` passes; `bun run smoke` extended (see P31.5.4).

### Phase 5 — Client capabilities (ecosystem layer, on P27's registry and route)

Goal: Keith can notify a person and open a view on that person's client through the one route P27 built, and nobody else's turn can.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P31.5.1 | Node registry layer rule: an id owned by P27's client registry (`notify`, `open.view`, `location.share`) announced by a node is refused `wrong-layer`; client capabilities are not listed by `nodes_status` | `apps/core/src/modules/nodes/node-capabilities.ts` | node-drivers.md "Client capabilities"; ADR-0023 §5 | a node announcing `open.view` is refused `wrong-layer` and stays online; `nodes_status` lists no client capability | tests pass |
| P31.5.2 | Verify-only: P27's `callClient` returns the client's ack `result` and enforces same person, same client id, one shot, 10 s; add only the missing tests, no new bus, record or RPC | `apps/core/src/modules/parietal/client-route.test.ts` | parietal.md "Client capability registry" | a result from another person is ignored; a second result is ignored; no reachable client gives `no-client` | tests pass, no production diff |
| P31.5.3 | Front-agent tool `client_call` (self only, calls `parietal.callClient`) and the system entry for delivery and protocols; audit `client.call`, registered in `AUDIT_SUBJECT_FIELDS` and `registerMySummary` (P23.2.3) so the person sees it in `audit.mine` | `apps/core/src/modules/parietal/client-tools.ts`, `modules/wernicke-broca/agent.ts`, `compose-regions.ts`, `client-tools.test.ts`, `packages/contracts/src/audit.ts` (registers `client.call` in `AUDIT_SUBJECT_FIELDS`), `apps/core/src/modules/audit/mine.ts` (`registerMySummary`) | node-drivers.md; wernicke-broca.md | the tool has no person parameter and always targets `ctx.principal.id`; a worker, a room (P30) and a guest agent have no such tool (tool list assertions); the audit row has no content | tests pass |
| P31.5.4 | TUI handler for `open.view` (the `notify` toast is P27.5.1); the TUI announces `notify` and `open.view` only; opt-in location left unannounced | `packages/client/src/presence.ts` (handler registration), `apps/tui/src/features/activity/`, `apps/tui/src/features/plugin-view/`, tests | client.md, tui.md | a delivery for `open.view` opens the named view and posts the result; an unknown capability answers `unsupported` | tests pass |
| P31.5.5 | **Leak and rights test (phase 5):** A's turn calls `client_call` while B is more recently active; B's client never receives anything; a system `notify` for A reaches only A's clients | `apps/core/src/client-calls.e2e.test.ts` | ADR-0023 §5, ADR-0020 §3 | B's captured feed has no `brain.parietal.deliver` for A; the tool result for A names only A's client | test passes |
| P31.5.6 | Smoke: a node with the bundled `desktop` driver (fake backend through a test flag in the smoke harness only), `driver list`, an approved `desktop.info`, a refused unknown capability, a toast on the TUI from `notify`; docs and README updates | `scripts/smoke/node-drivers.ts` (hooked from `scripts/smoke.ts`), `docs/ARCHITECTURE.md`, `README.md`, `apps/node/AGENTS.md` | manual-testing.md | smoke block green; no real screen or container touched | `bun run smoke` passes |

`bun run check` and `bun run smoke` pass.

### Phase 6 — Workspace references (ADR-0021 §2)

Goal: a workspace file moves by reference, resolved against the caller, audited by path and never by content.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P31.6.1 | `resolveWorkspacePath(caller, path)` in `cortex/workspace.ts`: the caller's own folder or a room the caller is in (P30), nothing else; refuses `..`, absolute paths, symlinks out, another person's folder and `keith/`; returns the real path and an audit record `workspace.file.send { person, path, bytes }` (never the content) | `apps/core/src/modules/cortex/workspace.ts`, `workspace.test.ts`, `docs/specs/cortex.md` | cortex.md (workspace), ADR-0021 §2 | the refusal table above; a path of person B asked by A is `path-refused`; a room path is allowed only for a member | table passes |
| P31.6.2 | `sandbox.run` schema v2 (v1 stays): `files?: [{ ref, name }]` copied read-only into the container work folder (up to 5 files, 1 MB each) and `outputFiles?: [name]` returned and written back to the caller's `people/<id>/sandbox/` folder; the core reads and writes only through `resolveWorkspacePath`; the node never sees a core path | `packages/contracts/src/node-capabilities.ts`, `apps/core/src/modules/motor/remote.ts`, `packages/driver-sandbox/`, `docs/specs/node-drivers.md` | node-drivers.md "Driver sandbox"; cortex.md | a file of the caller reaches the container and a result file lands in the caller's folder; a path outside refuses before anything runs; v1 calls unchanged; the audit row has the path, not the content | tests pass with the fake runtime |
| P31.6.3 | Leak and rights test: A's worker asks `sandbox.run` with a reference to B's file and to `keith/`: both refused; a result file never lands in another person's folder; the audit holds only paths | `apps/core/src/workspace-files.e2e.test.ts` | ADR-0020 §2, ADR-0021 §2 | the planted content of B's file appears in no result, context or audit row of A | test passes |

`bun run check` passes.

## Exit criteria

- [x] No "Changes in P31" marker of this plan is left in `docs/specs` (`grep -rn "Changes in P31" docs`). (evidence: `grep -rn "Changes in P31" docs/specs` finds nothing, Nov 14, 2026)
- [ ] `docs/specs/node-drivers.md` written; `nodes.md`, `node.md`, `motor.md`, `cortex.md`, `client.md`, `thalamus.md`, `tui.md`, `permissions.md` (if a row changes), `docs/ARCHITECTURE.md` and `apps/node/AGENTS.md` updated by the steps that changed them.
- [x] Contracts in `packages/contracts` (capability model, manifest v2, protocol 3); exports snapshot regenerated; no migration needed (stated in `db.md`). (evidence: `bun scripts/check-exports.ts` prints ok, Nov 14, 2026)
- [ ] Tests green: registry refusal table, v1 compatibility, driver loader, executor dispatch, desktop with a fake backend, sandbox argument list with a fake runtime, client-call isolation, the core shell confinement.
- [x] `bun run check` and `bun run smoke` pass; nothing in either touches a real screen or container runtime. (evidence: `bun run check` green (5908 pass, 0 fail) and smoke 110 steps on Nov 14, 2026, eharness 0.14.1)
- [ ] Manual scenarios (Owner to run) executed once on a real Mac and a real container runtime.
- [ ] P22 row marked done; F-032 verified (owner P24.2.1); no eharness gap was found (media results exist), so nothing goes upstream.

## Risks and mitigations

- **A driver is code with the node's rights.** Drivers are bundled or a local folder the machine's owner points at; the config stores a hash and `run` refuses a changed driver; no download. Core approval still gates every risky call, and risk comes from the core's spec, never from the node.
- **Computer use is powerful.** `desktop.input` is `destructive`, asked each time unless the owner remembers it for their own session, off by default on the node (`allowInput`), rate limited, with a stop file brake; the prompt tells the worker to stop at password, payment and two-factor screens. Screenshots can contain private data, so they are `external` and approved once per session at least, stored only in the calling person's workspace.
- **Image size and cost.** 1280 px JPEG, 1 MB cap, only the newest three images reach the model, older ones become a note; a vision-capable model is required (doctor warns).
- **Sandbox escape or abuse.** No network and no mounts by default, read-only root, dropped capabilities, resource limits, non-root, a dedicated machine recommended, per-person hourly limit. Network access asks the owner and needs the node's own option. Residual: a container runtime bug; documented, not solved here.
- **Approval fatigue.** `sandbox.run` without network needs no approval (the reason it exists); screenshot grants stay per session; `desktop.input` is the one that keeps asking.
- **Protocol drift between old nodes and the core.** v1 manifests remain accepted for at least this release (P24's node hardening is assumed in place); the core refuses per capability, so a new driver on an old core does not take the node down. `MIN_PROTOCOL` moves only by a later ADR.
- **Machine load.** No test starts Docker or reads the screen; real checks are manual and opt-in (`AGENTS.md` memory note about laptop heat).
- **P27 not ready.** Phase 5 starts with reading the P27 spec for the client capability registry, `callClient` and `activeClient`; if something is missing it is added to that spec first. Phases 1 to 4 do not depend on P27. Phase 6 needs P30 only for the room path (a room folder is accepted once P30 lands).

## Traceability

| Id | Closed by step |
| --- | --- |
| ADR-0023 §1 (core is the authority: plugins, tools and decisions stay in the core) | P31.1.4, P31.1.6 (risk and approval only from core specs) |
| ADR-0023 §2 (capability = id, schema, risk, approval) | P31.1.3, P31.1.4 |
| ADR-0023 §3 (drivers, `keith-node driver add`, announced in the manifest, core finds nodes by capability, a driver has no tools or Keith data) | P31.2.1, P31.2.3, P31.2.4, P31.1.5 (`byCapability`) |
| ADR-0023 §4 (rights on the node, approval in the core, nodes are self layer) | P31.1.6, P31.1.7, P31.3.5 |
| ADR-0023 §5 (client capabilities belong to the person's ecosystem; only that person's turns; registry and route are P27's) | P31.5.1, P31.5.2, P31.5.3, P31.5.5 |
| ADR-0021 §2 (files move by reference, resolved against the caller, audited by path) | P31.6.1, P31.6.2, P31.6.3 |
| ADR-0023 consequences (manifest version per driver, core refuses unknown schemas, computer use and IoT as drivers) | P31.1.3, P31.1.4, P31.3.1, P31.3.2 |
| ADR-0021 §3 (core never runs code for a worker; sandbox node; core shell confined like a node, same env) | P24.2.1 (verified in P31.1.1), P31.4.2, P31.4.4 |
| F-032 (core node env and cwd) / ADR-0027 §12 | P24.2.1 (verified in P31.1.1) |
| ADR-0027 §9 (nodes are Keith's self layer, `nodes.read` sees them) | P31.1.7 |
| ADR-0027 §7 (approval rows carry node and command) | P31.1.6 (driver name added to the row) |
| Approval copy for desktop actions (the rule of ADR-0027 §14 is P24.1.6) | P31.3.5 |
| ADR-0020 §3 (one principal per turn, no borrowed rights) | P31.3.6, P31.5.3, P31.5.5 |
| eharness gap check (ADR-0011) | recorded: none; image results use the existing media support (P31.3.1, P31.3.4) |

## Gate evidence (Nov 11, 2026)

- `bun run check`: Biome, tsc, check-imports, check-size and check-exports pass; 4821 tests pass. One test failed once in the full run (`packages/host` view-host teardown timer count), passes alone and in `bun test ./packages` (1303 pass): an order-dependent flake, not a P31 change.
- `bun run smoke`: SMOKE PASS, 90 steps (block `scripts/smoke/node-drivers.ts`: desktop driver with a fake backend, `driver list`, an unknown capability refused). No real screen or container.
- Leak and rights tests: `desktop-driver.e2e`, `client-calls.e2e`, `workspace-files.e2e`, `sandbox-driver.e2e`, `node-drivers.e2e`.
- Commits 60e4118 to the closing docs commit. No migration (nodes.manifest is JSON).

## Deviations from the design

- `approval: 'never'` means no approval for an input whose computed risk is at most `write`; a riskier input (`sandbox.run` with `network`) still asks the owner.
- `location.share` passes the id regex and is refused by the registry as `wrong-layer`; only `notify` (one segment) rejects the whole manifest.
- Desktop specs live in `CAPABILITIES` (contracts) like `shell.exec`. `motor_remote` has `toModelOutput` so the model sees the image. Scroll direction is `keys[0]`, 3 lines.
- Sandbox files use create, copy, start and copy out (no host mounts). The workspace resolver lives in `platform/workspace-resolve.ts` (cortex re-exports it).
- The delivery service already used `callClient`, so the system notify entry reuses it (no `client.call` row; `delivery.sent` covers it).

## Not verified

- Manual scenarios on a real Mac (permissions, JXA scripts) and with real Docker or Podman (image tags, `docker cp` flow); real-model use of computer use.
- Known limits (listed in `docs/specs/node-drivers.md`): driver progress output has no cap; `nodes.sandbox.maxPerHourPerPerson` has no owner route; `busy` maps to `failed` on the wire; the system notify path is covered by planner tests only.
  Status (Nov 14, 2026): the progress cap is in 040ffb3; the owner route is `nodes.settings.set` / `keith-core nodes sandbox-limit` (2eba5ea, 5e0a658); `busy` is its own wire code since dc1ac25. The system notify path is also covered by the smoke step `p27 notice` (97cd422).

## Owner to run

Use `bun run manual:setup`, `bun run manual:core`, `bun run manual:tui`, `bun run manual:node` (KEITH_HOME=.data/test; `rm -rf .data/test` to reset). Scenarios 3 to 6 need a Mac with the permissions granted by you in System Settings, and scenarios 7 to 9 need Docker or Podman. Nothing here is automated on purpose.

1. Pair a node as in `docs/manual-testing.md` (`keith-core pair`, then `bun run manual:node` with `--allow-shell`). In the TUI open `System > Nodes`: the node shows `system` and `shell` as drivers. Expect no `refused` line.
2. Stop the node. Run `keith-node driver list --config .data/test/node.json`: expect `system` and `shell` installed and `desktop` and `sandbox` available to add. Run `keith-node driver add nonsense`: expect a clear error and no config change.
3. `keith-node driver add desktop --config .data/test/node.json`: expect a list of what it does, a note that macOS needs Screen Recording and Accessibility for your terminal, a confirm, and "restart keith-node run". Restart the node. In `Nodes` expect `desktop 0.1.0 · info screenshot` (input is absent because you did not pass `--allow-input`).
4. Ask Keith in the chat, "take a screenshot of the laptop and describe what you see". Expect an approval `Allow desktop.screenshot on <node>?`, then (after `y`) a description of your screen. A second request in the same task may use `a` (allow for this task). Deny once and see that Keith reports it was denied.
5. Re-add with input: `keith-node driver add desktop --allow-input --yes`, restart, ask "open Notes and type hello". Expect an approval for each `desktop.input` showing actions in words (`click (412, 230)`, `type "hello"`). Create the stop file `.data/desktop.pause` next to the config folder: the next call is refused with the policy message; remove it to continue.
6. Add a member (`bun run manual:admin`), sign in as them, ask for a screenshot: the approval goes to the owner (you answer), and the image file appears under `.data/test/data/workspace/people/<member id>/`, not in yours. A member cannot answer it.
7. Add a sandbox node: `keith-node driver add sandbox --yes` (pulls the small images, takes a minute), restart. `keith-core doctor` shows `sandbox: node <name> online`. Ask "run this Python: print(sum(range(10)))". Expect `45` without an approval prompt; ask for a program that fetches a web page: expect it to fail with no network, and if you ask Keith to allow network it asks you first and still fails unless the node was added with `--network`.
8. Ask for an endless loop: expect a timeout in at most the limit and no container left (`docker ps -a` shows no `keith-sbx-` rows). Ask for a fork bomb: it is stopped by the process limit.
9. Stop the sandbox node and ask again: Keith says no sandbox node is online and that it will not run code on the core.
10. Send yourself a notification: ask "send me a notification that says hi"; expect a toast in the TUI and an audit row `client.call` with no text. Sign in as the member and ask Keith to notify the owner: Keith cannot (the tool only reaches the asking person).
11. `keith-core audit list`: rows `node.drivers` (after each driver change) and `node.capability.refused` (if you announced an unknown capability by editing the node config by hand, optional).
