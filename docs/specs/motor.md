# Motor

Code: `apps/core/src/modules/motor/{remote,status}.ts`. Tests: `motor.test.ts`,
`apps/core/src/node-pairing.e2e.test.ts`, `motor.e2e.test.ts`.

## Purpose

How Keith acts on a machine: the `motor_remote` tool (a capability on a node) and `nodes_status`
(which nodes exist). The `brain.motor.act` event of every tool call is `brain-events.md`. The capability model behind it (registry, specs, drivers, desktop and sandbox) is `node-drivers.md`.

## Public API (`index.ts`)

- `motorRemote({ nodes })` and `nodesStatus({ nodes })`: plugins (`keith-motor`,
  `keith-nodes-status`); `nodes` is a `NodeRegistry` (`nodes.md`).
- `MOTOR_REMOTE_TOOL`, `NODES_STATUS_TOOL`, `MOTOR_INSTRUCTIONS`, `REMOTE_TIMEOUT_MS` (120 000),
  `OUTPUT_MAX_CHARS` (30 000), `MotorResult`, `ownerAnswers(toolName, input)` and `motorAskOf(toolName, input)` (who answers an approval, below).

## Who has them

`cortex.general`: `motor_remote` and `nodes_status`. The front agent: `nodes_status` only. It
delegates machine actions to `cortex.general` (see `wernicke-broca.md`). `cortex.research` has
neither.

## `motor_remote`

Input `{ node, capability, input? }` (`node` = name or id; `core` is a node). Metadata `{ risk: 'external', source: 'outside' }`
(ADR-0036: what a machine prints is outside text). `execute` is an async generator:

1. Resolve the node; check the capability against the core's capability registry
   (`modules/nodes/node-capabilities.ts`: the built-in specs and the drivers' specs, `node-drivers.md`, Motor);
   parse `input` with the spec's schema. Failures here are results, nothing is sent.
2. Time limit: 120 s, or the input's own `timeoutMs` when smaller (`shell.exec` accepts up to 120 s).
3. `nodes.invoke(...)` with the call's `abortSignal` (aborting the turn or `tasks.stop` becomes a
   `cancel` to the node).
4. Progress is yielded as preliminary outputs `{ ok: true, running: true, output: <last 2 000
   characters> }` at most every 500 ms; the last yielded value, the result, is the output the model
   sees.

The result is always an object, never a throw for an expected failure:

- An image output (base64 `data` and an `image/*` `mimeType`, as `desktop.screenshot` returns it) becomes the MCP-style
  result `{ content: [{ type: 'image', data, mimeType }, { type: 'text', text }] }`: the text part is the outcome with the
  rest of the output, and the text cap never touches the image. An image over 1 MB is refused: `failed`, `screenshot too
  large` (`node-drivers.md`, Motor).
- success: `{ ok: true, node, capability, output, exitCode? }`; text output is capped at 30 000
  characters (first 60 %, last 40 %, "[N characters omitted]" between); an object output longer than
  that becomes its capped JSON text. Three caps apply in a row and each keeps a different split: the node executor (`node.md`: 15 000 + 15 000 of 30 000), the core node (`nodes.md`: first 20 000 and last 10 000) and this 30 000 cap at the motor (60/40); the agent's own tool-output cap may cut again. A test that names "20 000" refers to that agent cap.
- **Framing (ADR-0036 §6).** What the model reads is `framedModelOutputOf(output)` (`toModelOutput`): the platform facts (`ok`, `node`, `capability`, `exitCode`, a refusal's `code`
  and message) stay outside, and the text the machine produced (`output`; a plain string; the text parts of a content result) is wrapped by eharness
  `untrustedContent(text, { source: 'node', name: <capability> })`. An image part is not wrapped. The stored message keeps the raw result.
- failure: `{ ok: false, node, capability, code, error }`. `code`: `unknown-node`,
  `unknown-capability`, `invalid-input`, `shell-off` (same message as the denial, when the call got
  past `tool.approve`, e.g. through a session grant), `offline`, `refused-by-policy`, `timeout`, `cancelled`,
  `failed`, `busy`, and `rate-limited` (a person past `nodes.sandbox.maxPerHourPerPerson` for a capability with
  `approval: 'never'`; the message names the setting). `unsupported-version`, `driver-unavailable`,
  `path-refused` and `no-client` join the list with their steps (`node-drivers.md`, Errors). `error` is readable ("node laptop-e is offline", "refused by the node's policy: …",
  "timeout: …", "busy, try again later: …", "no node "x" (known: …)"). A denial by the owner is not a result of this tool:
  eharness hands the model the denial and the reason, and `execute` never runs.

## Approval

`tool.approve` decides from the input and the static table (eharness calls it again when it
re-validates an approved call). The shell-off check also reads the registry, but only to deny: a registry miss (unknown or renamed node) falls through to the ask and never approves:

Approval lifetime (ADR-0027 §10, P24): a pending `user-approval` is denied as `expired` after `approvals.ttlHours` (default 24) by the amygdala sweeper (`amygdala.md`); a stopped task's parked approval is denied with reason `the task was stopped` (ADR-0027 §11). Neither reaches the node.

| Hook | Behaviour |
| --- | --- |
| `tool.approve` | Risk and `approval` come from the capability spec (`node-drivers.md`, Spec); a risk function decides from the input, and `approval: 'never'` with a risk of `write` or below runs without asking (counted against the per-person limit: the call is admitted once per tool call id, and `execute` refuses it as `rate-limited` past the limit). `shell.exec` on a node whose manifest says shell is off (`allowShell: false`, `core` without `KEITH_CORE_ALLOW_SHELL` included) → `denied` with the reason "node <name> does not allow shell; rejoin with --allow-shell" (for `core`: "core does not allow shell; start core with KEITH_CORE_ALLOW_SHELL=true"), before anyone is asked; capability risk `read` (`system.info`) → `approved`; any other known capability (`shell.exec` is `destructive`) → `user-approval` with the reason "<capability> on <node>"; unknown capability or input without `node` and `capability` → `denied`. Combined with the worker's `approval.risk` (`external: approved`) by most-restrictive-wins, so the owner is asked. |
| `tool.grantScope` | `<node id>:<capability>` (the name is resolved to the current node id in the registry); `null` for an unknown node or input that cannot be read, so that call is not remembered and asks. eharness stores the grant (`state.core.grants`), so `a` approves that node and capability for the rest of the session (one task), never another node, and not a node re-paired under the same name (new id). |

The worker agent sets `grants: { by: 'principal', applyAt: 'now' }` (eharness 0.10, ADR-0070): a
grant is keyed by the person who **asked**, not the one who answered, and applies to the very next
call (no ask right after the `a`). For `shell.exec` this means a grant covers the asking person only.
Since a member's `shell.exec` is always answered by the owner and `remember` is dropped from that
answer (`amygdala.md`), a member never gets a grant; the owner's `a` covers the owner's own sessions
and the workers the owner started. The plugin keeps no grant memory of its own.

### Consent (ADR-0036)

`motor_remote` is `external` as a tool, but a call that runs unasked is a `read` for consent. `motorConsentRisk(capabilities)` (`motor/risk.ts`, pure over the registry)
is the `riskOf` option of amygdala's consent hook: a call that `runsUnasked` (`system.info`, a read capability, an `approval: 'never'` capability at `write` or below) is `read`;
a capability whose risk for the input is `destructive` is `destructive`; every other call (an unknown capability or an unreadable input included) is `external`. The consent table
(`amygdala.md`) then gives `user-approval` with the tier `conversation` when the conversation is clean (a command the person asked for in their own words, or delegated from
such a message and with no outside content read by the worker since) and `device` when tainted. The plugin's own `tool.approve` above is unchanged and still decides who is
asked and what is denied: most restrictive wins, so shell-off still denies, a `read` still runs without asking, and the member-to-owner routing and the step-up are untouched.
The node's output is `outside`, so a worker that ran a command (or read a page) is tainted for the rest of its task.

### Who answers (P9)

`tool.approve` does not know who is asking and does not change: it stays a pure function of the input
and the static table (`motor/risk.ts` adds nothing to it). Who answers is decided by the attention
routes (`amygdala.md`) with `ownerAnswers(toolName, input)`: `motor_remote` with a capability whose
`capabilityRisk` is not `read` (and any call that cannot be read) is answered by the OWNER, even
when it comes from a member's front or worker session. `motorAskOf(toolName, input)` gives
`{ node, capability, command? }` for the owner's view (the attention item also shows the driver, the first segment of the capability id, in the approval audit row). `ownerAnswers(toolName, input, capabilities)` reads the core's capability registry, the same one `tool.approve` reads: a call that runs without asking is never routed, and every other call (a risky input, a capability with `approval: 'by-risk'`, an unknown one) is answered by the owner (`node-drivers.md`, Motor). The owner's answer for a member's call never
sets a session grant. This is the member's `shell.exec` rule of `permissions.md`; it covers `core` as
a node too. `decideByRisk` of `eharness/identity` is not used: it decides allow or deny by role, not
who is asked.

## `nodes_status`

Risk `read`. Returns `{ nodes: [{ name, status, os, arch, drivers, capabilities, refused, allowShell,
lastSeenAt (ISO) }] }`, `core` included. `drivers` is `[{ name, version }]`; `capabilities` are the accepted
ids; `refused` is `[{ id, reason }]` for the announced ids the core refused (`node-drivers.md`). Client
capabilities are never listed.

## Instructions

The machine instructions are added by the plugin to the agent's instructions, read on every turn
(`refresh: 'turn'`): capabilities, that `shell.exec` waits for the owner, to use `nodes_status` for names, and to say
plainly when a node is offline, refuses, or a command is denied or times out.
The capability list comes from the registry: the built-in drivers (`system`, `shell`) always, and a driver's
capabilities only while an online node announces that driver (`announcedDrivers`). Each listed spec has its
summary, its input keys and what it needs (no approval, runs without asking below `write`, or the owner's approval).
The desktop instructions (`DESKTOP_INSTRUCTIONS`, `node-drivers.md`, Driver desktop) are added only while an online
node announces `desktop.*`; an offline node announces nothing for the turn. The code instructions follow the same rule:
`SANDBOX_INSTRUCTIONS` only while an online node announces `sandbox.run` (code goes to `sandbox.run`, never to
`shell.exec` on a real machine; no network and no files from the person; results inline). While no online node announces
it, `NO_SANDBOX_INSTRUCTIONS` is added instead: code cannot run now, say so, never run code on a node with `shell.exec`,
never offer to run it on the core. Both texts are read per turn, like the rest.

## Invariants

- `shell.exec` never reaches a node without the owner's `user-approval` (or a session grant the
  owner gave for that node and capability, for their own requests only).
- An unknown capability is denied before anything is asked; so is `shell.exec` on a node that keeps shell off.
- The per-person limit for calls that run without asking (`approval: 'never'`, risk `write` or below): the 61st call a person makes in an hour is `rate-limited` (default 60, setting `nodes.sandbox.maxPerHourPerPerson`, 1 to 1000). The count is in memory, per `ctx.principal`: a member never spends the owner's allowance. A call is counted once even when `tool.approve` runs again on re-validation.
- The owner answers every risky registry call, a member's included (`node-drivers.md`, Motor).
- No code-running path in `apps/core` besides the core node's own shell (`shell.exec`, owner-approved, confined). Code goes to `sandbox.run` on a sandbox node (`node-drivers.md`, Driver sandbox). A test (`modules/motor/code-paths.test.ts`) greps the process-spawning call sites of `apps/core/src` against an allowlist with a reason for each, so a new one fails until it is listed.
- A cancelled call always sends `cancel` to the node.
- The one exception (ADR-0024 §3, P28.2.6): an `act` step of a protocol runs `shell.exec` (or another capability above `read`, or a
  plugin operation above `read`) without a live `user-approval`, when the protocol's owner recorded a pre-approval of the exact
  `{operation, input}` (SHA-256 of the canonical JSON, `actApprovalHash`). Only protocols the owner or Keith owns (never a member's).
  The static risk table still decides which operation needs it. A changed input or operation is another hash and is refused. Every
  execution writes a `protocol.act` audit row (node, capability, hash, never the command). `hypothalamus.md` "`act`" has the rest.

## Tests

`motor.test.ts`: execute (limits, id lookup, readable failures, cap, preliminary progress, abort),
the two hooks (read/shell/unknown, input-only decisions, grant scope by node id), `nodes_status`.
Gate rows in `node-pairing.e2e.test.ts` and `motor.e2e.test.ts`: denied, approved, remember (a grant applies at once), node policy, `system.info` without
approval, cancel, timeout, output cap, core node, front `nodes_status`.
