# Wernicke-Broca (front agent)

Code: `apps/core/src/modules/wernicke-broca/agent.ts`.

## Purpose

The front agent: understands the owner's message, answers fast and delegates long work to Cortex
workers. Without delegation (M1 shape) its only tool is `datetime` from `eharness/clock`.

## Public API

- `frontSessionId(personId, generation)` returns `front:<personId>` for generation 0 and `front:<personId>:g<n>` after
  a reset (ADR-0030 §1). The generation is required and must be a non-negative integer. It lives in `platform/sessions.ts`
  with `generationOfSession` (the generation of a session id: 0 for `front:<id>`, the number after `:g` on the root id,
  undefined for any other id) and `personOfSession` (the person of a session id, which strips `:g<n>`), kept for routes
  and records that carry only an id, and is re-exported here. Every caller passes the current generation from the
  `FrontGenerations` port (`modules/wernicke-broca/generations.ts`: `load()` at boot before recovery, sync `current(personId)`,
  `bump(personId, now)` writes the row first and then the map; see `chat-context.md`). No call site takes a literal
  generation other than a test fixture. Every person has their own front session; the owner's id is `owner`, so a first
  install's session is `front:owner`.
- `FRONT_INSTRUCTIONS`: the core rules (P33.3.2, verbatim): who Keith is and who the turn is with, never claim an action that
  was not done, say plainly when a task cannot be done yet, presence through the tool only, protocols. They hold for every
  person and never change through a persona or a style.
- `createFrontAgent({ ..., persona?, style? })` (P33.3.2): `persona` is the `prefrontal` persona service, `style` the style of
  the turn's person. Absent: the `professional` template and no style lines (old tests keep their shape).
- Instruction table (`createFrontAgent`, placement per eharness 0.12.0 spec 02 §2 and §5):

  | Part | Source | Refresh | Placed in |
  | --- | --- | --- | --- |
  | core rules (`FRONT_INSTRUCTIONS`), `DELEGATION_INSTRUCTIONS`, `AGENDA_INSTRUCTIONS` | static string | boot | system prompt, block 1 |
  | persona block (`renderPersonaBlock`, `prefrontal/prompt.ts`: the owner's character, the voice rules that were in the old core text (answer language, brevity, Markdown), the memory voice rule) | function of the persona, read each turn | turn | turn reminder (same text for every person; a template switch or edit reaches the next turn) |
  | who the person is (`whoText`) | function of `ctx.principal` | turn | turn reminder |
  | style lines of the person (`renderStyleLines`) | function of `ctx.principal` and the person's style | turn | turn reminder, that person's only |

  The system prompt is identical for every person and holds the core rules only (test: `modules/wernicke-broca/agent.test.ts`). The
  persona block and the style lines are in the turn reminder; the style lines are that person's only. Harness check: prefrontal.md
  "Harness check" (the placement changed in P33.3.2 fix: see there).
- `DELEGATION_INSTRUCTIONS`: appended to the instructions (one newline) only when `delegation` is set.
- `createFrontAgent({ providers, storage, whois?, timezone?, logger?, inboxPollMs?, delegation?, plugins? })` returns a `HarnessAgent` (`defineHarnessAgent`):
  - `id: 'front'`;
  - `model: unconfiguredModel('front')`, a local placeholder (a model id string would go to the AI
    Gateway);
  - `models: providers.catalog()` for prices and context windows;
  - plugins `roleModel('front', providers)` (model per turn, see `providers.md`), `aclGuard()`, the compiled Keith plugins of `plugins` (`k-<id>`, one tool source each; `plugins.md`; empty
    when no plugin loaded, so the agent is unchanged) and `clock({ timezone })` (default: the system time zone);
  - `storage`: `messages`, `state`, optional `inbox` (the SQLite adapters, see `db.md`);
  - `inbox: { pollMs: inboxPollMs ?? 500 }`: how soon a stored worker report wakes the agent
    (tests use ~20 ms).
  - `reminders: { turnPlacement: 'end' }` (eharness 0.13.0, ADR-0073, spec 02 §5 and §6 rule 2a). The turn reminder (persona,
    who-line, style, client context, apps online, mode, memory roots) trails the newest message instead of sitting before the
    turn's first message. So turn N+1 starts with the exact bytes of turn N's stable prefix, and the previous turn stays cached
    (audit F8: about 750 tokens re-billed per turn before). The first step of a `respond()` continuation keeps the turn-start
    placement (eharness rule). Test: `agent.test.ts` ("the turn reminder trails the wire"), which asserts the byte prefix of
    turn 2 against turn 1's stable prefix; it fails with `'turn-start'`.
    Cache (eharness 0.14.0, spec 02 §6.1): the front agent sets `cache: FRONT_CACHE` (`prompt-cache.ts`), explicit
    `'breakpoints'` with `include: isRoutedAnthropic`. Eharness marks Anthropic's own provider by itself; `include` adds Claude
    through OpenRouter (`openrouter.*` provider, `anthropic/…` model id), whose provider forwards the per-message markers as
    `cache_control` (checked against `@openrouter/ai-sdk-provider` 3.1.0; it drops the tool marker, which costs one of the four
    breakpoints and nothing else, because the system breakpoint covers the tools before it). Breakpoint (c) is the last stable
    message, before the trailing reminder, so turn N+1 reads turn N from the cache. `'auto'` would put the breakpoint on the
    reminder, and OpenRouter ignores the call-level option. Other models (DeepSeek, OpenAI) get no markers and cache on their own.
    Test: `prompt-cache.test.ts`.

### Delegation option

`delegation: { cortex, tasks, store, self, nodes }` turns on M2. `self` returns this agent (the two refer
to each other, so compose passes a holder). It adds, in this order after `roleModel` and `clock`:
`activity({ store, messages: false })`, `brainEvents({ store, role: 'front' })`, `proactive({ store })`
(`ras.md`), `taskReminder({ tasks })` (`tasks.md`), `nodesStatus({ nodes })` (`motor.md`) and `cortex.leadPlugin(self)` (the `agent`,
`agent_output`, `agent_stop` tools, `cortex.md`). Without it none of these exist.

**Languages (Nov 14, 2026).** Keith talks to each person in their language (the voice rule of the persona block, or the person's
`language` style). Work handed to a worker is written in English, whatever the chat language, because models follow English task
text most reliably; the prompt ends with the language the result must be in: the language the person asked for, else the language
their style sets, else the language they write in (`DELEGATION_INSTRUCTIONS`). The worker writes its report and any file for the
person in that language (`cortex.md`, "Languages"), and the front agent relays the outcome in the person's language.

`presence` (`presenceTool`, `parietal.md` "The presence tool") is not part of the delegation option: the front agent always has
it, placed after the plugins passed in (`options.presence`, composed by `compose-regions.ts`). A worker never gets it. The
`FRONT_INSTRUCTIONS` end with one sentence that sends a "is X free" question to the `presence` tool.

`clientCall` (`clientCallTool`, `parietal.md` "Client capability registry and route", P31.5.3) is the same kind of option: the front
agent only, placed after `presence`. Its `client_call` tool asks the turn's own person's clients to do a capability; it has no person
parameter. A worker, a room agent and a guest agent never get it.

`protocolTools` (the plugin of `modules/hypothalamus/tools.ts`, P28.4.1) is the same kind of option: the front agent only, placed after
`presence`. `FRONT_INSTRUCTIONS` gain one paragraph on protocols: propose one only when the person asks for a standing rule or a clear
recurring need is seen, say that nothing runs until they confirm, and use `protocol_list`, `protocol_pause` and `protocol_answer`.
When the protocol tools are wired, `AGENDA_INSTRUCTIONS` is appended to the instructions (P28.5.2): a time the person says for something
they will do is stored with `agenda_add` (confirmed when clear, else after one question), never an invented time; see hypothalamus.md "Agenda".

`roomPost` (the `room_post` plugin of `modules/corpus-callosum/post.ts`, P30.4.3) is the same kind of option: the front agent only,
placed after `protocolTools`. Its `step.prepare` drops `room_post` from the active tools of a step while the person is active in no room
(and for a turn with no principal); while they are, a volatile reminder names the room's id. The tool never posts: it asks the person to
confirm the exact text (corpus-callosum.md "Private requests and results"). `FRONT_INSTRUCTIONS` do not change for it.

`dataDir` (optional, P33.4.3 and P33.4.4) adds, after `roomPost`, the `document_save` plugin of `modules/prefrontal/document-tool.ts` and
the report plugin of `modules/prefrontal/report.ts` (a step hook that adds the report block to a worker report's step, prefrontal.md "Report
mode"). The front agent is the personal session only; the room agent has no such tool (`corpus-callosum/tools.test.ts`). The tool writes the
person's own documents folder (prefrontal.md "Document hand-off"). Compose passes `config.dataDir` (`compose-regions.ts`).

### Hardening option (M4)

**Who is talking.** One agent serves every person's front session. With `whois` (`personId` ->
`{ name, username, role }`) the instructions gain a `refresh: 'turn'` function (`whoText`): "You are
talking to <name> (username <u>), a <role> of this Keith. Their memory and tasks are theirs alone.",
placed in the turn reminder, from `ctx.principal`. It never throws (a failed lookup adds
nothing). The static text never says "your owner"; the same `whois` names the memory root
(`hippocampus.md`).

`hardening: { dataDir, budget, instanceId }` (only with `delegation`) adds, after the plugins above:
`hippocampus({ flushOnCompaction: true })` (`hippocampus.md`), `budget.notice()` and
`stepBudget({ chunk: 8, cap: 16, onCap })`, and agent config:

- `budget`: ledger scopes global + the session's person, plus `maxTurnUsd: 0.5` (`budget.md`);
- `recovery.instanceId`, `streams`, and `storage.streams` when given (`resume.md`);
- `compaction: { summarizeAt, keepLast: 6, prune: { keepTurns: 2, minChars: 2000 }, model }`.
  `summarizeAt` is a function form (audit F14, `summarize-at.ts`): read once per turn on the front role's model, it is
  `min(0.65, 200000 / contextWindow)`, so the summary starts before the context reaches 200k tokens even on a 1M window. An unknown
  window keeps 0.65 (`summarizeRatioFor`, test `summarize-at.test.ts`). The absolute cap bounds one cold miss at that size.
  `model` is `() => resolveRoleModel('front', providers)` (`providers.md`): eharness would use
  the agent's static model for the summarizer and the memory flush, which here is the unconfigured
  placeholder, so the option resolves the front role's model once per turn;
- `toolOutput: { maxChars: 20_000 }`;
- `loop.maxSteps: 8` with `stepBudget`: a turn may extend in chunks of 8 up to 16 steps; at the
  cap, while still making progress, it gets 4 more steps and a reminder to delegate long work to
  Cortex.

`DELEGATION_INSTRUCTIONS` also say that a report "stopped: cost-cap" means the monthly limit was
reached and `/budget` raises it.

`DELEGATION_INSTRUCTIONS` end with a "Machines" paragraph: `nodes_status` lists the paired machines
and `core`; anything to do on a machine (check a disk, run a command) is delegated to
`cortex.general` with the node name and the exact task, and the owner approves every shell command.
The front agent has no `motor_remote`. They tell the model: answer chat and simple questions itself; delegate work
that is long, needs web research or has several steps with a clear, self-contained prompt (the
worker sees nothing of the chat); say in one short sentence that it is on it; never pretend to
have results before a worker reports; when the report arrives, tell the outcome in its own words
with the sources, and say plainly if it failed or was interrupted; for "how is it going" use the
list of active tasks it is given, or `agent_output`.

## Behaviour

- The real model is the `front` role, resolved on every turn by `turn.prepare`. Until a model is
  picked, the turn ends with a readable notice (`providers.md`, `unconfiguredModel`).
- A failed turn (no model, provider error) is stored as a separate message holding a
  `data-eh.notice` part (`data.message`); the stream also carries it. UIs must render it, or a
  failed turn looks like silence.
- After a delegation the turn's `send().result.stop` is `tool-pending` (the `agent` call is parked
  in the background); the lead continues in a `respond` turn and answers the owner at once.
- A worker's report is stored in the inbox; the front agent wakes by itself in a turn of
  `kind: 'wake'` (no user message) and tells the owner. The answer carries the proactive mark.
- History lives in `eh_messages` under `front:<personId>` and survives a core restart.

## Invariants

- The agent never makes a network call when no model is configured.
- A session id is derived from the person id only; thalamus enforces access (`thalamus.md`).

## Tests

`apps/core/src/delegation.e2e.test.ts`: delegation answered before the worker finishes, a second owner
message answered meanwhile, wake answer marked proactive, `agent_output`/`agent_stop` present and no
`send_message`. M4 gates: `compaction.e2e.test.ts` (compaction with memory flush before the marker; a delegation
started before it reported after it), `budget.e2e.test.ts`, `resume.e2e.test.ts`.
`apps/core/src/e2e.test.ts`: no-model notice containing `/connect` and no network call, streamed
answer through a scripted provider, next-turn model switch, history after restart.
