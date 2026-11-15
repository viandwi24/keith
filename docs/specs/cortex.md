# Cortex (workers)

Code: `apps/core/src/modules/cortex/{cortex,workers,web-search,search-gate}.ts`, wired in
`apps/core/src/compose.ts`. Tests: `cortex.test.ts`, `apps/core/src/delegation.e2e.test.ts`,
`apps/core/src/spike-park.test.ts`.

## Purpose

The worker agents the front agent delegates long work to. Each worker is a `HarnessAgent` that
runs as a background subagent in park mode (ADR-0046 of eharness): it survives a core restart
because everything it needs is in the shared SQLite adapters.

## Public API (`index.ts`)

- `createCortex(options)` returns a `Cortex`:
  - `worker(key)`: the worker agent of a catalog key, or `undefined`;
  - `leadPlugin(self)`: the `subagent(...)` plugin for the front agent (`self` returns that agent);
  - `reconcile(parent)`: `reconcileBackgroundChildren` for the background children of a lead
    session (idempotent: boot and a timer both call it);
  - `close()`: closes every worker.
- `CortexOptions` = `WorkerDeps` without `self`: `providers`, `storage` (`messages`, `state`,
  `inbox`, shared with the front agent), `store` (activity), `tasks`, `logger`, `lead`, `dataDir`,
  `timezone`, `inboxPollMs`, `nodes` (the `NodeRegistry` for `motor_remote`, `nodes.md`).
- `hardening?: { budget, instanceId }` (M4; without it a worker is the M3 one): the shared monthly ledger, notice, stable instance id, memory, `toolOutput` and `stepBudget` below.
- `WORKER_KEYS`, `WORKER_DESCRIPTIONS`, `WORKER_BUDGET`, `WORKER_STEPS`, `createWorker`, `workspaceDir(dataDir)`
  (`<dataDir>/workspace`), `personWorkspaceDir(dataDir, personId)` (`<dataDir>/workspace/people/<personId>`),
  `workspaceOf(dataDir, ctx)`, `migrateLegacyWorkspace(dataDir)`, `createSearch`, `searchModel`, `SEARCH_MODEL`.
  The core never changes the modes of a workspace file: `secureDataDir` walks only Keith's own entries (`OWNED_ENTRIES`, `db.md`),
  so a script a worker marked executable stays executable across restarts.
  `<dataDir>/workspace/keith/` is Keith's own (the layout of ADR-0021 §1): `keith/removed/<personId>/` holds a removed person's
  kept data for 30 days (`people.md`, Rules). No worker mounts `keith/`; a worker sees only `workspace/people/<its person>`.

## Worker catalog

| Key | Tools | Use |
| --- | --- | --- |
| `cortex.research` | `web_search`, `web_fetch` | questions that need current or external information |
| `cortex.general` | the research tools, plus `list_files`, `read_file`, `write_file`, `edit_file`, `grep`, `glob` in the workspace, plus `todo_write`, plus `motor_remote` and `nodes_status` (`motor.md`) | multi-step tasks that produce or edit files, and anything to do on a machine |

- No `delete_file` and no local shell. Machine actions go through `motor_remote` only, and
  `shell.exec` waits for the owner's approval (`amygdala.md`).
- Workspace tools run on `diskFs({ root: <dataDir>/workspace/people/<personId> })` (ADR-0021): the fs
  is a resolver called at session open, and `personId` is `ctx.principal.id`, the person of the task (a
  worker inherits the principal of the turn that sent it). The folder is created on first use; paths
  stay `/notes.md`, so a worker never sees another person's files. A run with no principal, or an id
  that cannot name a folder, gets no workspace (an empty in-memory fs; with `hardening`, only the
  memory mount). Only `cortex.general` gets it. With `hardening` that disk is the `/` mount of a
  `mountFs` next to `/memories/` (`hippocampus.md`).
- **Images.** A screenshot (`desktop.screenshot`, `motor.md`) reaches the worker as an image result. The
  filesystem's `toolMedia` service (default, on in the person's folder) writes the bytes to
  `people/<personId>/.eharness/tool-media/` (hidden from `list_files` and `grep`, the newest 20 kept), and the
  stored output keeps only a reference. `toolOutput.keepImages: 3` gives the model only the newest three images
  of a run; older ones become a text note. The stored messages keep every reference. An image is never written
  outside the caller's folder, and a run with no person keeps its images in memory only.
- **Legacy folder.** At worker creation, every entry of `<dataDir>/workspace` other than `people/`,
  `rooms/` and `keith/` (the old shared folder) is moved once to `workspace/keith/legacy-shared/`,
  never deleted; a second run finds nothing to move.
- **Workspace references (ADR-0021 §2).** A file moves to another machine by reference, never by path. `resolveWorkspacePath(caller, path)` (`platform/workspace-resolve.ts`, re-exported by `modules/cortex/workspace.ts`) resolves it for the person of the run: a bare relative path is in that person's folder, `people/<id>/…` only for that person's own id, `rooms/<id>/…` only for a room the person is a member of (the caller passes `isRoomMember`; cortex has no rooms port). `keith/` is never reachable. Refused with `path-refused`: `..`, an absolute path, a NUL byte or a backslash, another person's folder, a room the person is not in, and a symlink (or dangling link) whose target leaves the folder the path names. A missing file is allowed (an output is written under a new name). The resolver returns the real path and the logical path (`people/<id>/…`). `sandbox.run` (`node-drivers.md`) uses it for the files it sends and for the outputs it writes to `people/<id>/sandbox/`. Each file sent to a node is audited as `workspace.file.send { person, path, bytes }`: the path and the size, never the content.
- `web_fetch` uses `nodeResolveHost` (eharness blocks private hosts).
- Every worker also has `clock`, `activity({ messages: false })`, `brainEvents({ role: 'worker' })`,
  `taskBoard` (`tasks.md`) and the `roleModel('cortex')` plugin: the model is the `cortex` role,
  resolved on every turn (`providers.md`); without one the turn ends with the readable notice.
- Instructions: the worker is told the person who asked is not watching, that its final message is the report
  (answer first, then points with their sources, what could not be verified), and never to invent
  sources. The machine instructions (`motor.md`, Instructions) add the desktop loop only while an online node
  announces `desktop.*`. Code goes to `sandbox.run` on a sandbox node; with none online the worker says code cannot
  run and never offers to run it on the core (`node-drivers.md`, Driver sandbox).

## Approval policy and budget

- `approval.risk`: `read`, `write`, `external` are `approved` by policy; `destructive` is
  `denied`. The decisions surface as `brain.amygdala.decide` with `by: 'policy'`.
- `motor_remote` has risk `external` but its own `tool.approve` hook returns `user-approval` for
  everything above `read`; most restrictive wins, so the policy does not open it. The worker parks
  until the owner answers (`amygdala.md`); the answer is `by: 'user'`.
- **Consent (ADR-0036).** `WorkerDeps.consent` is the worker's `consent.plugin('worker')` (`amygdala.md`, "Consent"), added after `aclGuard()`. The web tools are `external` for eharness
  but read as `read` for consent (`EHARNESS_TOOL_TRAITS`), so research never asks. `motor_remote` asks with a tier: `conversation` when the front call that delegated the worker was
  clean and the worker has read nothing `outside` since, `device` otherwise. **Worker context.** A worker session has `ctx.session.parent = { sessionId, toolCallId }`; the front
  consent hook decides every call (the `agent` call included) and caches its context by `<session id>|<tool call id>`, and the worker's hook reads the delegating call's entry: `clean`
  gives the origin `delegated-clean` (the whole worker transcript must hold only `trusted` calls), anything else, an unknown call, an evicted entry, a restart, or a delegation from a
  wake turn, gives `tainted`. Limit: a worker resumed later by another call keeps the context of its first delegation. The worker's static instructions end with
  `UNTRUSTED_CONTENT_INSTRUCTIONS`. A request a worker raises with tier `conversation` is voiced by the person's front agent: `watchPending` tells `createConsentVoice` about each new approval, which writes `consent.asked` and wakes the
  person's front session through the delivery service (`consent.request`, `needs.immediate` unset: it may be held while the person is away, then it simply expires with the request after `conversationTtlMs`) with the one-line
  summary (command, node, capability) framed as outside text; the front agent says what, where and why with one yes/no question, and the person's next message answers the worker's approval (`amygdala.md`, "Asked in conversation").
  Tests: `amygdala/consent.test.ts`, `consent.e2e.test.ts`, `consent-conversation.e2e.test.ts`, `tool-sources.test.ts`.
- `WORKER_BUDGET`: `maxTurnUsd: 1`, `maxSessionUsd: 3`. The eharness default
  `toolCalls.maxIdenticalResults` stays on.
- With `hardening` (M4): the ledger scopes global + the person of its root session (`budget.md`) and its stop notice; `toolOutput: { maxChars: 20_000 }`
  (a larger result becomes a truncated preview, `W_TOOL_OUTPUT_LIMITED`); `loop.maxSteps` 20 plus
  `stepBudget({ chunk: 20, cap: 60, wrapUp: true })`, so a turn may run up to 60 steps and is nudged
  to wrap up near the cap; `recovery.instanceId`, `streams` and read-only memory on both workers (only the front writes).

## web_search

`web_search` is `webSearch({ search: createSearch(providers) })`. One search is one `generateText`
call on `SEARCH_MODEL` (the OpenRouter `front` default, a small fast model) with the OpenRouter
`web` plugin (`max_results: 5`, `allowedDomains` and `blockedDomains` mapped to
`include_domains`/`exclude_domains`). The result is the model's text plus the deduplicated URL
sources. No extra API key.

- The search function gets the session context (`ctx`, eharness 0.13.0). Its model call is observed as `aux:web-search:<person>`, the
  person of `ctx.principal` (the person who asked; a worker's principal is the delegating turn's person), and `unknown` only when the
  context has no principal (`web-search.ts`, `WEB_SEARCH_AUX_PERSON`).
- `searchModel(providers)` resolves `<connection>:<SEARCH_MODEL>` on the first enabled profile
  whose `definitionId` is `openrouter`; with none it returns `undefined` and `createSearch` throws
  "no connection can search the web (add OpenRouter)".
- `searchGate` (plugin `keith-search-gate`): in `step.prepare`, when `web_search` is among the
  tools and `searchModel` is `undefined`, it returns `activeTools` without `web_search`. The check
  runs every step because connections change at runtime (`/connect`); the tool list only changes
  when the answer changes, so the prompt cache stays stable otherwise. Without an OpenRouter
  connection the workers have no `web_search` (research keeps `web_fetch`).

## Languages

A worker works and reasons in English and writes its final report, and any file it makes for the person, in the language the task
names for the result (the front agent always names it, `wernicke-broca.md` "Languages"); a task that names none gets an English report.
Example: the owner asks in Indonesian for research; the task text is English and ends with "Write the report in Indonesian.", so the
report and its saved document are in Indonesian.

## Delegation wiring

Lead side (`leadPlugin`, on the front agent):

```text
subagent({ agents: { 'cortex.research', 'cortex.general' }, selfAgent, approvals: 'park',
  background: { default: true, timeoutMs: 3_600_000 }, maxDepth: 1, maxConcurrent: 3,
  outputTool: true, stopTool: true, messageTool: false })
```

Tools the lead gets: `agent`, `agent_output`, `agent_stop`. A fourth concurrent background
delegation is refused with a result the model can read. `send_message` is off: two-way talk with a
worker is Draft in eharness and the M2 scenario does not need it.

Worker side (each worker):

```text
subagent({ agents: {}, approvals: 'park', parentAgent: lead, selfAgent: self(key),
  onPark: 'notice', messageTool: false })
```

- `agents: {}`: workers cannot delegate further.
- `onPark: 'notice'`: a parked worker leaves a notice instead of adding a model call to the lead.
- `messageTool: false` is required: subagent offers `send_message` by default.
- Lead and workers share the same SQLite message/state/inbox adapters, so the child session
  registers in the parent's state.

## Task id and sessions

The child session id is the task id (`tasks.id`). A worker session is opened with
`worker.session(taskId)`; with the shared lock (`{ lock }`) when the code opens a root session of
the lead, see `AGENTS.md` (`W_SESSION_OPTIONS_IGNORED`).

## Reconcile

`reconcile(parent)` calls `reconcileBackgroundChildren(parent, { openChild, timeoutMs: 3_600_000,
stopOnTimeout: true })`. `openChild` picks the worker from `info.agent` (the catalog key) and throws
for an unknown key. A worker whose process died, or that ran past one hour, is repaired and
reported to the lead (a wake turn). `compose.ts` runs it at boot and every `reconcileEveryMs`
(60 s), then passes the result to `applyReconcile` (`tasks.md`).

## Errors

- Unknown worker key in `openChild`: the reconcile entry fails; `compose` logs a warning.
- No model for the `cortex` role: the worker turn fails with the readable notice; the board shows
  `failed` with that reason.
- A worker over budget stops; the board shows `failed` with the summary and error `COST_CAP_SUMMARY`
  (`budget.md`), and the lead relays it.

## Invariants

- No tool a worker has can delete files, run a local shell or leave the workspace; a command on a
  machine runs only after the owner approved it (`motor.md`).
- A worker belongs to the person who sent it (it inherits the principal of the delegating turn; its id is `front:<id>:agent:<task>`): it reads that
  person's memory read-only, spends that person's budget, and its report, dead letter and approvals
  go to that person's front session (a member's `shell.exec` approval goes to the owner,
  `amygdala.md`).
- A worker never reaches the owner directly; its final text is the report that the lead relays.
- `web_search` is never offered without an OpenRouter connection.

## Tests

`cortex.test.ts`: two workers and none for an unknown key; research has only `web_fetch` while no
connection can search and gains `web_search` with one; general adds file tools, todos, `motor_remote`
and `nodes_status` but no `delete_file`; workers run on the `cortex` role with the budget. `delegation.e2e.test.ts`: `maxConcurrent`
refusal of a fourth delegation, the lead has `agent`/`agent_output`/`agent_stop` and no
`send_message`. `spike-park.test.ts`: park + background + wake over SQLite, crash and reconcile. M4 gates: `memory.e2e.test.ts`
(a worker cannot write memory, the secret guard on front writes, `/memories` hidden from file tools), `budget.e2e.test.ts` (worker out of budget),
`compaction.e2e.test.ts` (output cap, step extension).
