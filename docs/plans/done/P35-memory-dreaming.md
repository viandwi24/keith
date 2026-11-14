# P35 — Memory dreaming (hippocampus, with a coded step in hypothalamus)

Nov 11, 2026 · status: **done (Nov 11, 2026)** · depends on: P34 (front generations, read by the collector), P33 (style deny list, the persona boundary), P28 and P29 (protocol engine, the `system` step pattern of `owner-absence`), P25 (delivery service), P26 (migrations with backup, removal registry, prune tick) · ADR: 0031, 0020 §2 and §4, 0024, 0027 §3 and §26, 0029 §3 · closes: ADR-0031 §1 to §13 · region: `hippocampus` (memory) with the scheduling step in `hypothalamus`; no new region (ADR-0004)

## Goal

Once a day, when a person has been idle, Keith reviews what that person said in their own conversations and consolidates their memory: it keeps new facts
short-term, promotes the ones that repeat or that the person asked to keep, merges duplicates, and marks contradicted facts as superseded instead of deleting
them. Every run leaves a diary the person can read. The person chooses the mode: `off`, `propose` (the default for the owner: changes wait for `/dream apply`),
or `auto` (changes apply, with an undo for 7 days). Nothing outside the person's own memory folder changes, and no run ever reads another person's data.

## Why

- ADR-0031 §3: facts repeat, drift and contradict each other, and the front agent judges one conversation at a time while it must also answer. A separate,
  offline pass with a fixed schema and code-side rules is the cheapest way to fix that without a shared store.
- ADR-0031 §4 and §7: the model proposes, code writes. The guards (25 % entry loss, `Source:` lines, supersede not delete, preimage, secret gate) exist
  because a consolidated file is pinned into every answer, so a wrong merge would shape every turn (research, "What Keith should not take").
- ADR-0031 §6: scheduling reuses the hypothalamus engine (time trigger, conditions, budget, audit, exactly-once runs) instead of a new timer.
- ADR-0020 §2: the pass is a model turn, so it runs as one principal and sees only that principal's folder and messages. The leak tests of every phase prove it.

Evidence from the code (read before writing this plan; each row names the file the step uses):

- Memory: `apps/core/src/modules/hippocampus/hippocampus.ts` (one root per person, `memoryDir`, `profilePathOf`, `maxPinnedChars` default 2000, the
  `diskFs` under `<dataDir>/memory`, `flushOnCompaction`), `secret-guard.ts` (`looksLikeSecret`, exported from `index.ts`), `index.ts`.
- Sessions: `apps/core/src/platform/sessions.ts` (`frontSessionOptions`, `personOfSession`, `countsFor`, `peopleFor`); the generations of P34 in
  `apps/core/src/modules/wernicke-broca/generations.ts`.
- Messages: `packages/db/src/schema/eh.ts` (`eh_messages` has `session_id`, `id` UUIDv7, `role`, `parts`, `metadata`, `created_at`; no sequence column).
  Kind messages and wake turns: `.ref/eharness/docs/specs/05-session-and-storage.md` (`inject`, kinds) and `apps/core/src/modules/plugins/adapter.ts`
  (`ctx.turn?.kind === 'wake'`). P35.2.1 confirms the stored shape of a worker report before the filter is written.
- Protocols: `apps/core/src/modules/hypothalamus/builtins.ts` (`BUILT_IN_DEFINITIONS`, `seedBuiltIns`, unique `(owner, built_in)`),
  `builtins-succession.ts` (`syncOwnerAbsence`, the idempotent sync to copy), `steps.ts` (the `system` case and `deps.system`), `authoring.ts` (`system` steps
  for `owner-absence` only), `conditions.ts` (`signal.since`, `not`, `budget.remaining`), `packages/contracts/src/protocols.ts` (`ProtocolBuiltInSchema`
  at line 633, `SYSTEM_ACTIONS` at line 279, `ConditionSchema`).
- Composition: `apps/core/src/compose-protocols.ts` (the `system` steps wiring, `clock.timeZone` from the host), `apps/core/src/compose-timers.ts` (the prune
  tick, `pruneEveryMs`), `apps/core/src/platform/retention.ts` (`RETENTION_PERIODS`), `apps/core/src/compose-prefrontal.ts` (the removal registration
  pattern), `apps/core/src/modules/people/removal-registry.ts`, `removed.ts` (the memory folder moves with the person).
- Budget: `apps/core/src/modules/budget/budget.ts` (`config`, `statusOf`, `billedPerson`, the principal's `billTo`).
- Flush: `apps/core/src/modules/wernicke-broca/agent.ts` (`flushOnCompaction: true` near line 278, the compaction config near line 296).
- Schema: `packages/db/drizzle/` ends at `0021_low_tyger_tiger.sql`; the next migration is `0022`.
- Owner time zone: none. `compose-protocols.ts` reads the host zone for every time condition. ADR-0031 §10 follows the code.

Evidence from eharness 0.12.0 (`.ref/eharness/docs/specs/`): `14-memory-plugin.md` §9 (`flushOnCompaction: true | { prompt }`, the default flush
prompt is static, `MEMORY_FLUSH_TOOLS`) and `06-compaction.md` §5.2a (flush requests of all `compaction.before` hooks merge, prompts joined with a blank line;
the flush writes no visible message; a failing flush is reported). P35.1.4 repeats these reads and records the section numbers in the spec.

## Scope

In:

- Spec `docs/specs/dreaming.md`, contracts `packages/contracts/src/dreaming.ts`, amendments to `hippocampus.md`, `hypothalamus.md`, `db.md`, `people.md`,
  `permissions.md`, `audit` kinds.
- Two additive tables `dream_settings` and `dream_runs` (migration `0022`), repos, removal part, 90-day retention row.
- Files: tiers `profile.md`, topic files, `recent.md`, `archive.md`, `dreams/<date>.md` inside the memory folder; preimages and staged plans in
  `<dataDir>/dreams/<personId>/` outside the mount.
- Collector (code, three gates, secret gate, cursor), judge (one `cortex` model call, zod plan, read-only own memory tool), applier (rules of ADR-0031 §4),
  undo, staging, `/dream apply`.
- Built-in protocol `dream` per person, its `system` step `dreaming.run`, conditions, `too-soon` and `few-messages` skips, budget cap, manual `/dream now`.
- Flush redirection (second `compaction.before` hook), prune-tick purge of archive, undo and staged files.
- RPC `dream.status`, `dream.mode`, `dream.now`, `dream.apply`, `dream.undo`, `dream.diary`; client; TUI `/dream` commands and a Me > Memory screen.
- Notification of a staged proposal through the delivery service (one per run).
- Audit kinds `dream.run`, `dream.apply`, `dream.undo`, `dream.mode`; event `brain.hippocampus.dream`.
- Eval scenario `dreaming` (scripted offline; real-model run owner-paid), leak tests, smoke block, PTY test, manual scenario, docs.

Out:

- Shared household memory across persons, vector search, a graph store, auto-editing the persona, cross-person insights, a pass for rooms (ADR-0031 §12).
- An owner time-zone setting (ADR-0031 §10): the schedule uses the host zone.
- Changing eharness (no gap found; ADR-0011 is not triggered).
- Letting a front turn approve a staged plan on the person's behalf. Only the person's own `/dream apply` (RPC or TUI) applies it.
- Web and mobile clients (the RPC contract is what they would use).

## Design

### Files and folders (ADR-0031 §2, §4, §8)

- Inside the memory folder `<dataDir>/memory/<personId>/` (mounted at `/memories/<personId>`): `profile.md`, `<topic>.md`, `recent.md`, `archive.md`,
  `dreams/<YYYY-MM-DD>.md` (one diary per run; a second run on the same day appends a `## run <runId>` section).
- Outside the mount, so no `memory_*` tool can reach them: `<dataDir>/dreams/<personId>/staged/<runId>.json` (the plan of a `propose` run) and
  `<dataDir>/dreams/<personId>/undo/<runId>/<path>` (preimages; `<path>` is the memory-relative path, and a file the run created has a `.created` marker).
- An entry is one Markdown bullet: `- <text>` followed by an indented `Source: session <sessionId> message <messageId>` line and, for a short-term entry,
  `(seen <YYYY-MM-DD>)`. Superseded: `- [superseded <YYYY-MM-DD>: <reason>] <text>`. Front-agent entries have no `Source:` line and are never dropped by
  the entry-loss guard (§4 applies to dreaming writes).

### Tables (ADR-0031 §5, §6, §8; one additive migration)

| Table | Columns | Notes |
| --- | --- | --- |
| `dream_settings` | `person_id` (text primary key), `mode` (`off`, `propose`, `auto`), `updated_at`, `updated_by` | absent row = the default (`propose` for the owner, the member default for others); no foreign key (the removal part deletes it at purge) |
| `dream_runs` | `id` (UUIDv7), `person_id`, `trigger` (`schedule`, `manual`), `mode`, `status` (`running`, `applied`, `staged`, `skipped`, `refused`, `failed`, `rejected`), `reason` (short code or null), `started_at`, `ended_at`, `counts` (JSON: candidates, promoted, merged, superseded, dropped), `cursor` (JSON: last collected message id per session), `undo_until` (ms, null) | the cadence anchor is the latest `started_at` of a non-`skipped` row; the cursor is the latest `applied` or `staged` row's; 90 days after `ended_at` |

Migration `0022` is generated by `bun run --filter @keith/db db:generate` and never edited. `migration-0022.test.ts` migrates a database built before it: the
rows of older tables are unchanged, both tables start empty, and a second run with the same `(person_id)` is one row.

### Contracts (ADR-0031 §3, §5, §7, §8, §13)

`packages/contracts/src/dreaming.ts` holds: `DreamModeSchema` (`off`, `propose`, `auto`); `DreamPlanSchema` (the judge's output: `candidates` with
`id`, `action` from the five actions, `target` (`profile`, `recent`, or a topic file name matched `^[a-z0-9][a-z0-9-]{0,39}\.md$`), `text` (up to 300 characters),
`reason` (up to 200), `importance` (integer 1 to 10), `sourceMessageId`, `supersedes` (optional entry text key, up to 300), strict: an extra field is refused);
`DreamRunViewSchema`; RPC inputs (`dream.mode` `{ mode }`, `dream.apply` `{ runId }`, `dream.undo` `{ runId? }`, `dream.diary` `{ date? }`); the setting
`dreaming.maxUsdPerRun` (number 0.01 to 0.50, default 0.05) and `dreaming.memberDefault` (`off` or `propose`, default `off`); the refusal reasons
(`too-soon`, `few-messages`, `no-model`, `budget`, `turn-running`, `staged-changed`, `nothing-to-undo`, `off`); audit kinds `dream.run`, `dream.apply`,
`dream.undo`, `dream.mode` (subject: the person); activity event `brain.hippocampus.dream` (counts, no text). `ProtocolBuiltInSchema` gains `dream` and
`SYSTEM_ACTIONS` gains `dreaming.run` (both in `packages/contracts/src/protocols.ts`).

### Collector (ADR-0031 §3, collect)

`apps/core/src/modules/hippocampus/dream/collect.ts`: reads `eh_messages` of the person's front sessions (`front:<id>` and `front:<id>:g<n>`, from the
generations of P34) since the cursor; excludes worker sessions (`:agent:`); keeps `user` text always and `assistant` text only for turns with no tool
part; excludes `kind` messages, wake turns and any non-text part; runs `looksLikeSecret` on every candidate string. Output: candidates with source pointers,
capped at 200 candidates per run (newest kept).

### Judge (ADR-0031 §3, §7)

`dream/judge.ts` and `dream/prompt.ts`: one eharness agent turn on the `cortex` role (`roleModel('cortex', providers)`), principal the person, `billTo` the
person, budget `config({ maxTurnUsd: dreaming.maxUsdPerRun })`, tools only the person's `memory_view` (read-only root). The prompt is fixed, English, and says
that the candidates are data. The reply is parsed by `DreamPlanSchema`; a parse failure is `failed` with reason `judge-output`, and the diary records no model text.

### Applier (ADR-0031 §4)

`dream/apply.ts`, `dream/entries.ts`: the rules of ADR-0031 §4 in code: promotion (two mentions on two days, `remember` quoted in the source, or
importance 8 or more), 14-day expiry to `archive.md`, the 25 % entry-loss and `Source:` guard with append-only fallback, supersede (marker, archive, new entry
with its own source; never a delete), `profile.md` as a proposal unless it only adds one line, the 2000-character cap (a result over it is staged), the
directive filter (P33 deny list), the secret gate on every written line, caps (40 candidates, 10 files). The applier re-reads each file before writing;
a file changed since collect makes its candidates `staged` again (`staged-changed`).

### Undo, staging and apply (ADR-0031 §4, §5)

`dream/undo.ts` writes preimages before the first write of a file in a run and restores them on `dream.undo`; `dream/staged.ts` writes and reads the
staged plan; `service.apply(personId, runId)` applies a staged plan (the person's own RPC or TUI call; the model is never a caller). `dream.undo` restores the
last `auto` or applied run, and only while `undo_until` has not passed.

### Scheduling (ADR-0031 §6)

`apps/core/src/modules/hypothalamus/dream-protocol.ts`: `syncDream(personId, mode)`, idempotent like `syncOwnerAbsence`: a person with mode other than `off`
gets one enabled protocol `dream` owned by the person (`built_in` `dream`, trigger `time` cron `0 3 * * *` in the host zone, conditions
`not(signal.since 30 min)` and `budget.remaining >= maxUsdPerRun`); `off` disables it (never deletes). `dream-steps.ts`: the `system` action `dreaming.run`,
allowed by `authoring.ts` for the built-in `dream` only. The step checks `too-soon` (latest non-skipped `started_at` within 20 hours), `few-messages`
(fewer than 5 new user messages since the cursor, no model call), then collect, judge, apply, the diary, the `dream_runs` row, the audit row and the event.
A manual run (`/dream now`) starts the same protocol with trigger ref `manual:<runId>` and skips the idle condition.

### Flush redirection (ADR-0031 §9)

`apps/core/src/modules/hippocampus/dream/flush-hook.ts`: a `compaction.before` hook that returns one extra flush prompt line when the person's mode is not
`off`. Registered next to the memory plugin in `wernicke-broca/agent.ts`. The `/new` flush (P34) uses the same path.

### Retention, removal and the prune tick (ADR-0031 §8)

- `dream_runs` rows: 90 days after `ended_at`, a row in `db.md` and in `RETENTION_PERIODS` (the inventory test fails without it).
- Files: archive entries 30 days after archiving; preimages and staged plans 7 days after the run ended. A `purge()` in `dream/purge.ts` is called by the prune
  tick (`compose-timers.ts`), audited as `data.pruned { table, count }` with table names `dreaming.archive`, `dreaming.undo` and `dreaming.staged`.
- Removal part `dream/removal.ts`: keeps `dream_settings` and `dream_runs` rows and the `dreams/<personId>/` folder in the kept folder, deletes them at
  purge; registered in `compose-*` like `prefrontal/removal.ts`.

### Client and TUI (ADR-0031 §5, §8)

- `packages/client/src/dreaming.ts`: `status`, `setMode`, `runNow`, `apply`, `undo`, `diary`. The status shows the mode, the last run (time, status, counts,
  reason), whether a staged plan waits, and whether an undo is available.
- `apps/tui/src/features/memory/`: `/dream` (status), `/dream now`, `/dream apply`, `/dream undo`, `/dream mode` with `off`, `propose` or `auto`; a Me > Memory screen with the
  mode, the last run and the list of diary dates. A staged plan shows its counts and the entries it would change, never the owner's other data.
  The owner's view of a member's diary is not in the TUI in P35; it is the audited owner path of ADR-0020 §4, through the RPC `dream.diary` with the owner
  as caller (which writes `acl.owner-access`).

## Phases

### Phase 1 — Spec, contracts, amendments, harness check

Goal: the rules are written and typed before code uses them, and the eharness calls the design needs are confirmed.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P35.1.1 | Write the module spec: tiers, phases, applier rules, modes, scheduling, flush, retention, removal, audit, RPC, TUI | `docs/specs/dreaming.md` (new), `docs/specs/README.md` (index row) | ADR-0031 §1 to §12 | none (doc) | every rule of ADR-0031 has a section; the spec names the code paths of this plan |
| P35.1.2 | Contracts: `DreamPlanSchema` (strict), modes, RPC inputs, refusal reasons, settings bounds, audit kinds, activity kind; `dream` in `ProtocolBuiltInSchema`; `dreaming.run` in `SYSTEM_ACTIONS` | `packages/contracts/src/dreaming.ts` (new), `dreaming.test.ts` (new), `packages/contracts/src/protocols.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/contract.ts` (`dream` area), `packages/contracts/src/audit.ts`, `scripts/exports.snapshot.json` (regenerated: `bun scripts/check-exports.ts --write`) | `dreaming.md` "Contracts"; `permissions.md` rows | `dreaming.test.ts`: an extra plan field refused; `action` outside the five refused; `target` with a path separator refused; `importance` 0 and 11 refused; `maxUsdPerRun` 0.6 refused; `protocols.test.ts`: `dream` built-in and `dreaming.run` parse | contract tests pass; snapshot regenerated, not edited |
| P35.1.3 | Amend the specs this design changes: the writer rule (applier as a second writer, same root and guard), the built-in table (per-person `dream`), `db.md` (two tables, the file purge rule), `people.md` (removal part), `permissions.md` (`dream.*` rows), `tui.md` (commands) | `docs/specs/hippocampus.md` ("Who writes"), `docs/specs/hypothalamus.md` ("Built-ins", "Authoring"), `docs/specs/db.md` ("Retention"), `docs/specs/people.md` ("Removal"), `docs/specs/permissions.md`, `docs/specs/tui.md` | ADR-0031 §4, §6, §8, §13 | none (doc) | each amended section names the ADR-0031 section it follows; `grep -rn "only the front agent" docs/specs` shows only the amended sentence |
| P35.1.4 | Harness check against `.ref/eharness` (tag 0.12.0): `compaction.before` hook merge (spec 06 §5.2a rule 2), the flush without a visible message (rule 6), agent turn `billTo` and the budget config, the memory read tools for a judge turn (spec 14, MEMORY_FLUSH_TOOLS and the `tools` option of the flush request); record section numbers | `docs/specs/dreaming.md` ("Harness check") | ADR-0031 §3, §7, §9; ADR-0011 | none (doc) | recorded; no gap (else the ADR-0011 path: stop and report before phase 2) |

`bun run check` passes.

### Phase 2 — Store, files, undo and staging primitives

Goal: the tables, the file layout and the preimage store exist and are tested alone, before any model or protocol uses them.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P35.2.1 | Schema `dream_settings` and `dream_runs` (new schema file, re-exported), generated migration `0022` (never edited), repo with `getMode`, `setMode`, `startRun`, `endRun`, `latestStarted`, `cursorOf`, `listRuns`; confirm the stored shape of a worker report and a wake turn in `eh_messages` (eharness 05 and the plugin adapter) and write the filter note into `dreaming.md` | `packages/db/src/schema/dreaming.ts` (new), `packages/db/src/schema.ts`, `packages/db/drizzle/0022_*.sql` (generated), `packages/db/src/repos/dreaming.ts` (new), `dreaming.test.ts` (next to it) | `db.md` (two rows); ADR-0031 §5, §8 | `migration-0022.test.ts`: older rows unchanged, both tables empty after migrate; `setMode` twice is one row; `latestStarted` ignores `skipped`; the retention-inventory test passes with its row | migration generated and not edited; backup taken before the run; tests pass |
| P35.2.2 | File layout and entry model: tier paths, the `Source:` and `(seen …)` lines, the superseded marker, a parser and writer that round-trip; the outside-mount folders under `<dataDir>/dreams/<personId>/` | `apps/core/src/modules/hippocampus/dream/files.ts` (new), `dream/entries.ts` (new), `files.test.ts`, `entries.test.ts` | `dreaming.md` "Files" | round trip of a file with dreaming and front entries; a `..` or a path separator in a topic name refused; the outside folder is not under `<dataDir>/memory` (asserted) | tests pass |
| P35.2.3 | Preimage store and staged plan store: save a preimage before the first write of a file in a run; restore on undo, removing files the run created (`.created` marker); staged plan read and write; `undo_until` set at apply | `apps/core/src/modules/hippocampus/dream/undo.ts` (new), `dream/staged.ts` (new), `undo.test.ts`, `staged.test.ts` | ADR-0031 §4 (preimage and undo), §5 | an undo restores the exact bytes of a changed file and deletes a created one; a second preimage in the same run is not taken; `nothing-to-undo` after `undo_until`; staged plan survives a restart; nothing written under `memory/` by these calls | tests pass |

`bun run check` passes.

### Phase 3 — Collector and judge (the untrusted-input gate and the model call)

Goal: the model sees only one person's own text, and its reply is a checked plan. Nothing is written yet.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P35.3.1 | Collector: front sessions of all generations (no `:agent:`), cursor, role gate (user text always; assistant text only from turns with no tool part), exclusion of kind messages, wake turns and non-text parts, secret gate, cap of 200 candidates | `apps/core/src/modules/hippocampus/dream/collect.ts` (new), `collect.test.ts` (new) | `dreaming.md` "Collect"; ADR-0031 §3 | a worker session's text never collected; a tool result, a kind message and a wake turn never collected; an assistant turn with a tool part never collected; a secret-shaped user string dropped and counted; the cursor moves only when told; the test seeds two persons with planted strings and asserts neither leaks into the other's candidates | tests pass |
| P35.3.2 | Judge: the prompt (fixed English text, candidates as data), one agent turn on the `cortex` role, principal and `billTo` the person, budget cap, the read-only own-memory tool only; zod parse of the reply; `failed` with `judge-output` and no model text in the diary | `apps/core/src/modules/hippocampus/dream/judge.ts` (new), `dream/prompt.ts` (new), `judge.test.ts` (new), `prompt.test.ts` (new); scripted model from `apps/core/src/testing/scripted-providers.ts` | `dreaming.md` "Judge"; ADR-0031 §7 | the turn has exactly one tool and it is read-only; a reply with an extra field is `judge-output`; a planted string of another person and a fetched-page text are absent from the prompt; the principal of the turn is the person | tests pass |

`bun run check` passes.

### Phase 4 — Applier, staging and apply (the guards)

Goal: the rules of ADR-0031 §4 are code, each with a test that fails when the rule is removed.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P35.4.1 | Applier rules: promotion (two mentions on two days, `remember` quoted in the source, importance 8 or more), 14-day expiry to `archive.md`, supersede (marker, archive, new entry with its own source), `profile.md` proposal unless one added line, 2000-character cap (over it staged), directive filter (P33 deny list), secret gate per written line, caps (40 candidates, 10 files), re-read before write | `apps/core/src/modules/hippocampus/dream/apply.ts` (new), `dream/rules.ts` (new), `apply.test.ts` (new), `rules.test.ts` (new) | `dreaming.md` "Applier" | a table test: each rule has a case that passes and one that is refused; a contradiction never deletes a line (the archive holds it); a changed file makes the candidate `staged-changed` | tests pass |
| P35.4.2 | Entry-loss guard and append-only fallback: a rewrite that drops more than 25 % of prior entries, or any dreaming entry's `Source:` line, is rejected and the file gets appends only | `apps/core/src/modules/hippocampus/dream/guard.ts` (new), `guard.test.ts` (new) | ADR-0031 §4 | a rewrite of 26 % of 20 entries is rejected; 25 % is accepted; a dropped `Source:` line is rejected even at 0 %; the fallback keeps every prior line | tests pass |
| P35.4.3 | Run service: `run(personId, trigger)` = collect, judge, apply or stage by mode, diary (`dreams/<date>.md`), the cursor, `dream_runs` row, `dream.run` audit row (counts only), `brain.hippocampus.dream` event; `apply(personId, runId)` for a staged plan (the person's own call) with `dream.apply` | `apps/core/src/modules/hippocampus/dream/service.ts` (new), `dream/diary.ts` (new), `service.test.ts` (new), `diary.test.ts` (new) | `dreaming.md` "Service", "Audit"; ADR-0031 §5, §8 | `propose` writes the staged plan and no memory file; `auto` writes and keeps an undo; `apply` on a changed file refuses with `staged-changed`; audit rows hold no text; a second `apply` is a no-op | tests pass |

`bun run check` passes.

### Phase 5 — Scheduling, budget, flush redirection, retention, removal

Goal: the runs happen by themselves, within the caps, and the flush and the purge follow the modes.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P35.5.1 | Built-in `dream` per person: `syncDream(personId, mode)` (idempotent: create, enable, disable, never delete), trigger `time` `0 3 * * *` in the host zone, conditions `not(signal.since 30 min)` and `budget.remaining`; authoring allows the `dreaming.run` system step for `dream` only | `apps/core/src/modules/hypothalamus/dream-protocol.ts` (new), `dream-protocol.test.ts` (new), `apps/core/src/modules/hypothalamus/authoring.ts`, `authoring.test.ts` (one row added), `apps/core/src/modules/hypothalamus/index.ts` | `hypothalamus.md` "Built-ins" (amended in P35.1.3); ADR-0031 §6 | a second sync writes nothing; `off` disables and keeps the row; a `system` step in another protocol is refused (`author-rule`); the condition reads only the person's own sign | tests pass |
| P35.5.2 | Step `dreaming.run`: `too-soon` (latest non-skipped start within 20 hours), `few-messages` (fewer than 5 new user messages since the cursor, no model call), then run service; wired as the `system` port in `compose-protocols.ts` | `apps/core/src/modules/hypothalamus/dream-steps.ts` (new), `dream-steps.test.ts` (new), `apps/core/src/compose-protocols.ts` | ADR-0031 §6; `hypothalamus.md` "Engine" | with a fake clock: a run at 03:00 after 20 hours starts; one at 19 hours is `too-soon`; 4 messages is `few-messages` and calls no model (counted); a crash between judge and apply leaves the cursor and the files unchanged | tests pass |
| P35.5.3 | Manual `/dream now`: same protocol, trigger ref `manual:<runId>`, skips the idle condition, still obeys `too-soon` | `apps/core/src/modules/hypothalamus/dream-protocol.ts`, `dream/service.ts` (`runNow`), `service.test.ts` (extended) | ADR-0031 §6 | a manual run with a schedule run 3 hours earlier is `too-soon`; a manual run at 25 hours starts | tests pass |
| P35.5.4 | Budget cap: `budget.config({ maxTurnUsd: dreaming.maxUsdPerRun })` billed to the person; a refusal ends `refused:budget` and tells the person once through the delivery service | `dream/judge.ts`, `dream-steps.ts`, `dream-steps.test.ts` | ADR-0031 §6; `hypothalamus.md` "Budget" | a judge turn over the cap is refused and the cursor stays; the owner's ledger is not charged for a member's run (asserted on the ledger row) | tests pass |
| P35.5.5 | Flush redirection: the second `compaction.before` hook adds the `recent.md` line only when the mode is not `off`; registered in `wernicke-broca/agent.ts` next to the memory plugin | `apps/core/src/modules/hippocampus/dream/flush-hook.ts` (new), `flush-hook.test.ts` (new), `apps/core/src/modules/wernicke-broca/agent.ts` | `dreaming.md` "Flush"; eharness 06 §5.2a rule 2 | mode `off`: the merged flush request has no added line; `propose`: it has it; the `/new` flush (P34 test helper) gets the same line; no other person's mode is read | tests pass |
| P35.5.6 | Retention and removal: `dream_runs` in `RETENTION_PERIODS` (90 days) and `db.md`; the file purge (archive 30 days, undo and staged 7 days) called by the prune tick; removal part keeps and purges the rows and `dreams/<personId>/` | `apps/core/src/platform/retention.ts`, `apps/core/src/compose-timers.ts`, `apps/core/src/modules/hippocampus/dream/purge.ts` (new), `dream/removal.ts` (new), `purge.test.ts`, `removal.test.ts`, `apps/core/src/compose-*.ts` (registration), `docs/specs/db.md` | `db.md` "Retention"; `people.md` "Removal"; ADR-0031 §8 | a purge of an old file deletes it and audits `data.pruned`; a kept person's `dreams/` moves with the folder; purge deletes both tables' rows for that person | tests pass |

`bun run check` passes.

### Phase 6 — Client, TUI, notification, leak tests, eval, smoke, docs

Goal: a person runs, reviews, applies and undoes from the terminal, and every isolation claim has a test that would catch a regression.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P35.6.1 | RPC procedures `dream.status`, `dream.mode`, `dream.now`, `dream.apply`, `dream.undo`, `dream.diary`; the owner reads a member's diary through the audited path only | `apps/core/src/modules/hippocampus/dream/procedures.ts` (new), `procedures.test.ts` (new), `packages/client/src/dreaming.ts` (new), `dreaming.test.ts` (new), `packages/client/src/client.ts` | `dreaming.md` "RPC"; `permissions.md` | a member cannot read the owner's diary; the owner reading a member's diary writes `acl.owner-access`; `dream.mode` by a member changes only the member's row; `dream.mode` of the default is owner-only with step-up | tests pass |
| P35.6.2 | Notification: one message per staged run through the delivery service, no text of the candidates (counts and the command to run) | `apps/core/src/modules/hippocampus/dream/notify.ts` (new), `notify.test.ts` (new) | ADR-0031 §5; `delivery.md` | one run, one message; a second run on the same day with the same plan sends none more; the message names `/dream apply` and carries no entry text | tests pass |
| P35.6.3 | TUI: `/dream`, `/dream now`, `/dream apply`, `/dream undo`, `/dream mode` with `off`, `propose` or `auto`; the Me > Memory screen (mode, last run, diary list); toasts with refusal reasons | `apps/tui/src/features/memory/` (new: `dream-commands.ts`, `memory-screen.tsx`, tests next to them), `apps/tui/src/features/chat/slash.ts` (the `/dream` entries) | `tui.md` "Commands and keys" (amended in P35.1.3) | `matchCommands('/dr')` lists the `/dream` commands; `/dream mode propose` parses; each refusal reason has a toast text; the screen shows no entry of another person | tests pass; the owner's uncommitted `apps/tui/src/cli.tsx` untouched |
| P35.6.4 | Leak test per phase, in one file: two persons A and B with planted strings in memory and in messages; A's worker, A's web-page paste, and a fetched page in a tool result; A's and B's runs; every model call and every write captured | `apps/core/src/dreaming-leak.e2e.test.ts` (new, style of `chat-context-leak.e2e.test.ts`) | ADR-0031 §1, §3, §7; ADR-0020 §2 | B's planted string appears in no call of A's run and the reverse; a fetched-page string never reaches memory or the judge prompt; B's folder and rows are byte-equal after A's run; the owner's audit holds counts only | test passes; listed in `dreaming.md` "Tests" |
| P35.6.5 | Eval scenario `dreaming` (scripted offline; the real-model run is owner-paid): does not invent facts, keeps a contradiction as superseded, respects the 25 % rule, never stores a secret, promotes on the two-day rule | `apps/core/evals/dreaming/` (new), `docs/specs/evals.md` (scenario row) | `evals.md`; ADR-0031 §4 | the offline run passes all checks; the script is added in this step as `eval:dreaming` with a `-- --scripted` flag, like `eval:news` (AGENTS.md); the real-model run is not part of `bun run check` | offline eval passes |
| P35.6.6 | Smoke block (fake provider: the schedule run with a fake clock, `propose`, `/dream apply`, `/dream undo` through RPC), PTY test of `/dream mode propose` and the Me > Memory screen, manual scenario | `scripts/smoke/dreaming.ts` (new), `scripts/smoke.ts` (one line), `apps/tui/src/memory.pty.test.ts` (new, style of `cli.pty.test.ts`), `docs/manual-testing.md` | AGENTS gotchas (PTY, smoke: plain fetch, no workspace import) | the PTY screen shows the mode after the command; the smoke block passes with fake backends | `bun run smoke` and the PTY test pass |
| P35.6.7 | Docs: `docs/specs/dreaming.md` final, `docs/ARCHITECTURE.md` (hippocampus row names dreaming), `docs/decisions/README.md` (ADR-0031 row, done with this plan's docs), `docs/plans/active/README.md` (P35 row) | the listed docs | as named | none (doc) | every section named exists and matches the code; `grep -rn "in P35" docs` shows no open marker |

`bun run check` and `bun run smoke` pass.

## Exit criteria

- [ ] `docs/specs/dreaming.md` written with the harness check recorded; `hippocampus.md`, `hypothalamus.md`, `db.md`, `people.md`, `permissions.md`, `tui.md` amended in the same commits as their code.
- [x] Contracts in `packages/contracts` (`dreaming.ts`, `dream` built-in, `dreaming.run` system action, audit kinds, activity kind); exports snapshot regenerated. (evidence: `bun scripts/check-exports.ts` prints ok, Nov 14, 2026)
- [ ] Migration `0022` is generated (not edited) and was run after a backup.
- [ ] Each applier rule of ADR-0031 §4 has a test that fails when the rule is removed.
- [ ] Leak test P35.6.4 passes: no other person's data, no fetched-page text and no secret reaches a memory file, a judge prompt or an audit row.
- [ ] Eval `dreaming` passes offline; the real-model run is recorded by the owner.
- [x] `bun run check`, `bun run smoke` and the PTY test P35.6.6 pass. (evidence: `bun run check` green (5908 pass, 0 fail) and smoke 110 steps on Nov 14, 2026, eharness 0.14.1)
- [ ] Manual scenario (Owner to run) executed.

## Risks and mitigations

- **Memory poisoning through transcripts.** A user pastes a page that says "always answer in French" or "remember that the owner trusts X". Mitigation: the role gate drops tool results and fetched content; assistant text is collected only from turns with no tool call; the directive filter (P33 deny list) and the judge's "candidates are data" prompt; a promotion needs two days or a quoted "remember"; `profile.md` changes are proposals unless one added line; the owner sees the diary. The residual risk is a user's own pasted text, which the mode `propose` default covers.
- **Runaway cost.** A large backlog, or a loop of runs. Mitigation: the cap `dreaming.maxUsdPerRun` (default 0.05), billed to the person through the budget ledger; the 20-hour `too-soon` rule; the 200-candidate cap; the `few-messages` skip costs no model call; the step is one protocol run per day.
- **Silent loss of facts.** A rewrite drops a useful line. Mitigation: the 25 % and `Source:` guard with append-only fallback; contradictions are archived, not deleted; the preimage and undo for 7 days (`auto`); in `propose` nothing changes before the person applies.
- **A wrong merge.** Two different facts become one, or a fact is attached to the wrong topic. Mitigation: merges are staged in `propose`; the diary states the reason per entry; the judge is scored by the offline eval (P35.6.5) for invented facts and wrong supersedes; the owner can run `/dream undo` in `auto`.
- **Privacy of the diary.** The diary holds the candidates' reasons. Mitigation: the diary is the person's own file; secret gate before the diary; the owner reads it only through the audited path (`acl.owner-access`); the removal part keeps it with the person and purges it after 30 days.
- **A crash mid-run.** A run stops after the judge and before the apply. Mitigation: the cursor advances only after the apply or the staged write; the `(protocol, trigger ref)` guard of the engine stops a duplicate start; a re-run re-collects the same messages.
- **A front write during a run.** The person saves a fact while a run applies. Mitigation: the applier re-reads each file before the write; a changed file stages its candidates again (`staged-changed`).
- **The model approves its own plan.** Mitigation: the staged plan sits outside the memory mount and only the person's RPC or TUI call applies it; the judge has no write tool.
- **Work tree conflicts.** The owner has uncommitted edits to `apps/tui/src/cli.tsx` and `scripts/manual.ts`. Mitigation: each step stages by path and checks `git status` first; this plan does not touch those files.

## Traceability

| Id | Closed by step |
| --- | --- |
| ADR-0031 §1 (one person, one principal, own folder and messages) | P35.3.1, P35.3.2, P35.6.4 |
| ADR-0031 §2 (tiers and file formats) | P35.2.2, P35.4.1 |
| ADR-0031 §3 (collect, judge, apply; the three gates) | P35.3.1, P35.3.2, P35.4.3 |
| ADR-0031 §4 (applier rules, preimage and undo) | P35.2.3, P35.4.1, P35.4.2, P35.4.3 |
| ADR-0031 §5 (modes; default `propose` for the owner, `off` for a member) | P35.2.1, P35.4.3, P35.6.1 |
| ADR-0031 §6 (schedule, conditions, budget, 20-hour rule, manual run) | P35.5.1, P35.5.2, P35.5.3, P35.5.4 |
| ADR-0031 §7 (judge has no write or web tool; schema refusal) | P35.3.2, P35.6.4 |
| ADR-0031 §8 (audit counts only, diary, retention, removal) | P35.2.1, P35.4.3, P35.5.6, P35.6.2 |
| ADR-0031 §9 (flush redirection; mode off changes nothing) | P35.5.5 |
| ADR-0031 §10 (host zone; no owner zone setting) | P35.5.1, P35.1.1 (spec states it) |
| ADR-0031 §11 (persona and style never touched) | P35.4.1 (directive filter), P35.6.4 |
| ADR-0031 §13 (spec and contract changes) | P35.1.2, P35.1.3 |
| ADR-0020 §2 and §4 (one principal; audited owner read) | P35.3.2, P35.6.1, P35.6.4 |
| ADR-0024 (protocols: the model is a step; exactly once) | P35.5.1, P35.5.2 |
| ADR-0027 §3 (migration with backup) | P35.2.1 |
| ADR-0027 §26 (removal keeps the data) | P35.5.6 |
| ADR-0029 §3 (memory never sets a style) | P35.4.1 |
| ADR-0011 (eharness gap check) | P35.1.4 |

## Gate evidence (Nov 11, 2026)

- `bun run check`: Biome, tsc, check-imports, check-size and check-exports pass; 5552 tests pass, 0 fail (an earlier full run failed only on tests of the parallel Activity Logs work, since fixed there).
- `bun run smoke`: SMOKE PASS, 106 steps; block `scripts/smoke/dreaming.ts` (8 steps: member login, propose stages and changes no memory file, apply writes the key line with a `Source:` line and no secret, undo restores the bytes, auto writes without apply, audit rows hold counts only, another person's folder unchanged). PTY test `apps/tui/src/memory.pty.test.ts` passes twice.
- Leak test `apps/core/src/dreaming-leak.e2e.test.ts` (13 tests); offline eval `bun run eval:dreaming -- --scripted` (14 tests). Migration 0022 (`dream_settings`, `dream_runs`).
- The smoke found a real bug on the way (async `DreamRefused` bypassed the CONFLICT mapping, so a second `dream.now` was a 500) and the eval found one (the directive gate checked only the rewritten text): both fixed with tests.

## Visibility follow-up (audit of the states during /new, /compact and a dream run)

Server: activity record `chat.context.pending` (start and end), `brain.hippocampus.dream` with `phase`, dream notices for propose, auto and failed runs, stale `running` rows ended as `failed: interrupted` at boot, atomic memory writes, the `auto` staged base read before the judge. TUI: a pending row and a held send that never loses the draft, the draft survives the generation switch, a "conversation compacted" divider, `dreaming…` in the Brain panel, dream notices in the chat.

## Not verified

- Manual scenario 30 in a real terminal; the real-model eval `dreaming` (owner-paid; thresholds set by the first real run, P32.3.5); real spoken or long-run behaviour of the 03:00 schedule over several days.
- Known limits (docs/specs/dreaming.md): the judge's budget reservation can refuse a chat turn near the cap; a dream whose end event never arrives (core killed) keeps `dreaming…` in the Brain panel until the next end or a TUI restart; `manual:clock` does not move `dream_runs`; the removal export is a no-op.
  Status (Nov 14, 2026): a dream run now leaves a whole chat turn of budget (c5f774b); a feed resync clears the Brain panel's `dreaming…` (ffd630a); `manual:clock` moves `dream_runs` (cad19d4); the removal export writes nothing on purpose, the diary is a memory file exported with the memory folder (docs/specs/people.md).

## Deviations from the design brief (resolved in ADR-0031)

- One table became two: `dream_settings` (mode, configuration) and `dream_runs` (log, cadence, cursor). ADR-0031 Consequences.
- Source pointers name the session and the message id, not a message sequence: `eh_messages` has no sequence (ADR-0031 Context).
- Undo preimages and staged plans live under `<dataDir>/dreams/<personId>/`, not inside `memory/<personId>/`: a `memory_*` tool reaches everything under the root.
- The schedule uses the host zone: there is no owner time-zone setting (ADR-0031 §10).
- The per-person `dream` protocol is a sync function (as `syncOwnerAbsence`), not a seed of `BUILT_IN_DEFINITIONS`, because built-ins are `keith`-owned.
- The flush prompt is changed through a second `compaction.before` hook: the memory plugin's prompt is fixed at construction (eharness 14 §9).
- Assistant text is collected only from turns with no tool call (ADR-0031 §3): the brief excluded web content, but assistant prose can carry a fetched page's text.

## Owner to run

Use `bun run manual:setup`, `bun run manual:core`, `bun run manual:tui` and a second TUI with its own `KEITH_CLIENT_CONFIG` for a member
(as in `docs/manual-testing.md`; KEITH_HOME=.data/test, `rm -rf .data/test` to reset). Run the offline eval first; the real-model eval costs money and is run by the owner.

1. Owner TUI: have three short exchanges that repeat one preference on two days (or use `manual:clock 2` to move the timestamps back, with the core stopped). Run `/dream now`. Expect a staged plan notice, `/dream` shows `propose` and the counts, and `profile.md` is unchanged.
2. Owner TUI: `/dream apply`. Expect the entry in the topic file or `profile.md` (one line), a `Source:` line, and the diary under Me > Memory.
3. Owner TUI: `/dream undo`. Expect the file back to its earlier bytes. Run `/dream mode auto`, repeat, and expect the write without apply.
4. Say "remember this: my flat key is in the blue box" and then a password-looking string. Run `/dream now`. Expect the key line promoted, and no line with the password in any file or the diary.
5. Member TUI: `/dream` shows `off`. `/dream mode propose`. Expect the owner's mode unchanged (`/dream` in the owner TUI).
6. `keith-core audit list` shows `dream.run` rows with counts and no text.
7. Paste a web page's text into the chat and ask Keith to summarise it. Run `/dream now`. Expect nothing from the page in `recent.md`, `profile.md` or the diary.
8. Run `/dream now` twice within 20 hours. Expect the second to be `too-soon`.

## Open verifications

- The stored shape of a worker report and of a wake turn in `eh_messages` (P35.2.1): the role gate depends on it. If the marker is not in the metadata, the filter uses the worker session id and the turn kind of the eharness `TurnInfo`.
- Whether eharness 0.12.0 exposes a read-only memory tool set for an agent turn (not only for the flush request) (P35.1.4). If not, the judge's turn gets a plain prompt with the memory text in it, and the tool list stays empty.
- The `signal.since` condition as the "idle 30 minutes" test (P35.5.1): parietal's `awayAfterMs` is 30 minutes too; the step records which one the code reads.
