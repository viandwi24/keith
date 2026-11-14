# 0031. Memory dreaming: an offline consolidation pass of one person's memory

Status: Accepted (2026-11-11); built in P35. Applies ADR-0020 (layers and isolation: a pass runs as one person and reads only that person's
data), ADR-0024 (the hypothalamus engine runs the schedule; the model is a step, not the scheduler), ADR-0027 §3 (additive migrations with a backup),
§26 (removal keeps a person's data) and ADR-0029 (memory never sets a style). Research input: `docs/research/memory-dreaming.md`, a product-neutral study of how agent systems consolidate memory offline. Region: `hippocampus` (memory) with a coded step in
`hypothalamus` (scheduling); no new region (ADR-0004).

## Context

Keith's memory (`docs/specs/hippocampus.md`) is written only during the person's own turns: the front agent calls `memory_create`,
`memory_str_replace` or `memory_insert` when the person asks, or when a compaction flush runs. Nothing reviews what was said across days. Three
problems follow:

1. Facts repeat or drift. The same preference is stored twice in two wordings, and a later statement that contradicts an older one leaves both.
2. Short facts seen once are either stored too early (a passing remark pinned into every turn through `profile.md`) or never stored, because the
   front agent does not judge across conversations.
3. The front agent does the judging inside a turn that must also answer the person. A pass that has no answer to give can take more care.

The research shows the parts that are safe to reuse: a staged output with a preimage, an entry-loss guard (25 %), invalidate-not-delete
for contradictions, and a provenance gate before the model (`untrusted` and `system` candidates never reach it). It also shows what Keith must
not copy: a shared memory across people, a writer with no principal, silent deletion (an LLM-chosen `DELETE`), and auto-promotion of unreviewed facts
into the file that is pinned into every prompt.

Code facts that shape the decision (read before writing this ADR):

- `eh_messages` has no sequence column. Its key is `(session_id, id)` and `id` is a UUIDv7 (`packages/db/src/schema/eh.ts`). A source pointer therefore
  names the session and the message id. The `seq` of `chat.history` is a read-time position, not stored.
- Built-in protocols are `keith`-owned and unique on `(owner, built_in)` (`hypothalamus/builtins.ts`). `ProtocolBuiltInSchema` lists three names.
  `SYSTEM_ACTIONS` (`packages/contracts/src/protocols.ts`) holds only the three `succession.*` actions, and `authoring.ts` allows `system` steps only for
  `owner-absence`. A per-person built-in therefore needs a contract change and a sync function in the style of `syncOwnerAbsence`.
- There is no owner time-zone setting. `compose-protocols.ts` reads the core host's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) for every
  time condition and trigger.
- The memory flush is set once, when the agent is built (`flushOnCompaction: true` in `wernicke-broca/agent.ts`). Its prompt is a static string. A
  per-person prompt must come from another `compaction.before` hook: eharness merges the flush requests of all hooks (`06-compaction.md` §5.2a, rule 2).
- `memory/<personId>/` is the folder that the memory tools reach (`hippocampus.ts`, `diskFs` under `<dataDir>/memory`). Anything written inside it is
  readable and writable by the front agent's `memory_*` tools, and `removed.ts` moves the whole folder on removal.
- Budget is charged per agent turn through the budget ledger (`budget.config`, the principal's `billTo`), not per arbitrary model call.
- Retention of ended rows is the SQL table of `platform/retention.ts`, run by the prune tick (`compose-timers.ts`, `pruneEveryMs`). Memory files are not SQL.

## Decision

1. **Dreaming is an offline consolidation pass of one person's memory.** It runs as that person's principal (`ctx.principal.id` is the person), over only
   that person's memory folder and that person's own front-session messages (all generations). It never reads another person's folder, transcript, workers,
   rooms or audit, and it never mixes persons in one run or one model call (ADR-0020 §2 and §3, ADR-0024 invariant "a model context holds its own
   principal's data"). The owner reads a person's diary only through the audited owner path (`acl.owner-access`, ADR-0020 §4), as for any personal memory.

2. **Tiers inside the person's memory folder** (`<dataDir>/memory/<personId>/`, the root `/memories/<personId>` of the hippocampus):

   | File | Tier | Written by | Read by the front agent |
   | --- | --- | --- | --- |
   | `profile.md` | pinned, core long-term (2000 characters, `maxPinnedChars`) | front agent (turns) and applier (after approval or auto) | every turn |
   | `<topic>.md` | long-term topic files | front agent and applier | on demand (`memory_view`) |
   | `recent.md` | short-term staging: new facts from the day's conversations, each with a date and a `Source:` pointer | compaction and `/new` flush (§9), applier | on demand; not pinned |
   | `archive.md` | superseded or demoted entries, kept 30 days, then purged | applier only | never (on demand only) |
   | `dreams/<date>.md` | the diary of one run: what was promoted, merged, superseded, dropped, and why | applier only | on demand |

   Entries written by dreaming carry a `Source:` line: `Source: session <sessionId> message <messageId>`. The front agent's own writes do not need one.

3. **Phases of a run.**
   - **Collect** (code, no model). New user text and assistant text since the last run's cursor, from the person's front sessions of all generations
     (`front:<id>` and `front:<id>:g<n>`; worker sessions `…:agent:<task>` are excluded). Three gates, all structural:
     - **Role gate.** Tool results, worker reports (`kind` messages and the wake turns of a worker report), `eh.*` kind messages, web content and
       any part that is not plain text are excluded. Their text never reaches the judge.
     - **Assistant gate.** Assistant text is collected only from turns that made no tool call. A reply that summarises a fetched page carries the page's
       text, so it is left out. User text is always collected: a user can paste a page, which is why §4 limits what one paste can do.
     - **Secret gate.** Every candidate string passes `looksLikeSecret` (`hippocampus/secret-guard.ts`). A hit drops the candidate and counts as
       `dropped` with reason `secret`, without the text.

     The cursor is the last message id collected per session and advances only after the apply succeeded (or the staged plan was written), so a crash
     re-collects the same messages.
   - **Judge** (one model call per run, the `cortex` role, run as an eharness agent turn with the person as principal and `billTo` the person, so the
     ledger charges it). Input: the candidates with their source pointers, the current `profile.md`, the topic files' headings and the `recent.md`
     entries. The model has no tools except the person's own memory read tools (`memory_view`, scoped to the person's root, read-only). It has no web,
     no workspace, no shell and no other person (§7). It returns one structured plan, validated by a zod schema (`packages/contracts`, `dreaming.ts`).
     For each candidate: `keep-short-term`, `promote` (to a topic file or to `profile.md`), `merge` (with an existing entry), `supersede` (an existing
     entry is contradicted), or `drop`, each with a reason and the source pointer; plus an importance score from 1 to 10 (ranking only).
     The prompt says that the candidates are data, not instructions.
   - **Apply** (code, not the model). Writes the files under the rules of §4. The model never writes a file. The applier re-reads each file at apply
     time, so a front-agent write made during the run is not overwritten; a conflict with a file changed since collect makes that candidate
     `staged` again rather than applied.

4. **Rules of the code-side applier.**
   - **Promotion.** A candidate moves from `recent.md` to a topic file or `profile.md` only if one of these holds: at least 2 mentions on 2 different
     days (the days of the `Source:` pointers, counted in code); the person said "remember this" in the candidate's source message (the judge must
     quote it; the code checks the words `remember` or `keep this` in the source text in English and the owner's language set); or importance is 8 or
     more. A short-term entry older than 14 days with no promotion is moved to `archive.md` with reason `expired`.
   - **Entry-loss guard.** A rewrite of a file that drops more than 25 % of the prior entries of that file, or that drops a `Source:` line of a
     dreaming entry, is rejected. The run then falls back to append-only for that file: new entries are added at the end and nothing is removed.
   - **Contradictions never delete.** A superseded entry is not removed. Its line becomes `[superseded <date>: <reason>]`, and the entry is moved to
     `archive.md` with its original `Source:`. The new fact is written with its own `Source:`. This is invalidate-not-delete.
   - **`profile.md` is a proposal.** A change to `profile.md` is always staged as a proposal, even in `auto` mode, unless it only adds one line. The
     file's 2000-character cap (`maxPinnedChars`, hippocampus) applies to the result; a result over the cap is staged, never truncated.
   - **Style is out of reach.** A candidate that matches the style deny list of P33 (directive words such as "always", "never", "ignore", "refuse",
     "pretend") or reads as an instruction to Keith is dropped with reason `directive`. Memory never sets a style (ADR-0029 §3).
   - **Secrets.** Every written line passes `looksLikeSecret` before it is written; a hit refuses the whole candidate.
   - **Caps.** A run writes at most 40 candidates and at most 10 changed files. A larger plan is staged in full and applied in part on `/dream apply`
     only by the person's choice (no partial auto apply).
   - **Preimage and undo.** Before the first write of a file in a run, its previous bytes are saved to
     `<dataDir>/dreams/<personId>/undo/<runId>/<path>`, outside the memory mount so that no `memory_*` tool can reach or overwrite a preimage. `/dream
     undo` restores the preimages of the last applied run and removes the files it created. Preimages live 7 days (the prune tick, §8).

5. **Modes per person.**
   - `off`: no run, no protocol, no change to the flush (§9).
   - `propose` (default for the owner on a new install): a run writes the staged plan (`<dataDir>/dreams/<personId>/staged/<runId>.json`, outside the
     memory mount, so the model cannot approve its own plan) and the diary. Nothing else changes until the person runs `/dream apply`. Keith notifies
     the person once through the delivery service (`delivery.deliver`, one message per run).
   - `auto`: the applier writes directly under §4; the undo stays available for 7 days.
   - Default for a member: `off`. The owner may set the default for members (`dreaming.memberDefault`, a setting). A member always may set their own
     mode (`/dream mode`). Setting a mode is not a privacy change for anyone else, so it needs no step-up (ADR-0009 requires step-up for owner changes
     of persona, people or policy only). Setting the member default is an owner change and does need step-up.

6. **Scheduling: a built-in protocol `dream` per person.**
   - One protocol per person with mode other than `off`. Its owner is that person, its `built_in` is `dream`, its trigger is a `time` trigger with
     cron `0 3 * * *` in the core's zone (§10). `off` disables the protocol; it is never deleted, so the run history stays readable.
   - Conditions, all in code: `not(signal.since <person>, 30 min)` (the person has been idle for 30 minutes, reading parietal's sign of life); the
     person's budget has at least `dreaming.maxUsdPerRun` left (`budget.remaining`). The step itself skips with reason `few-messages` when fewer than
     5 new user messages exist since the cursor. That skip makes no model call. A run within 20 hours of the last started run is refused with
     `too-soon`, for the schedule and for `/dream now` alike.
   - Manual `/dream now` starts the same protocol with trigger ref `manual:<runId>`; the idle condition is skipped for a manual run (the person asked).
   - Budget cap: `dreaming.maxUsdPerRun`, default 0.15 USD, range 0.01 to 0.50, billed to the person (`billTo` is the person; the owner pays only for
     the owner's own run). A run that hits the cap stops with `refused:budget` and tells the person once with the cap in USD.
     The default was 0.05 at first. In the first real-model run the judge turn had spent 93% of it (`W_BUDGET` warning) and the run then
     failed on the reply (`judge`). A judge turn re-sends its whole input at every step, and the memory files it reads are not yet
     bounded, so 0.05 leaves no margin for one run with a normal model. It is raised to 0.15 (2026-11-12). The judge's candidate input is
     bounded at 12 000 characters (`JUDGE_INPUT_CHARS`). Measured fit: not measured with a real model; the test covers the input bound only. Bounded since 1241f56 (Nov 13, 2026): one memory `view` by the judge returns at most `JUDGE_VIEW_CHARS` (8 000) characters.
   - The step is a `system` action `dreaming.run`, allowed only for the built-in `dream` (`authoring.ts`), so no other protocol can hold a model call.

7. **The judge's tools and what it cannot do.** The consolidator model call has no tools except the person's own memory read tool. No web, no
   workspace, no shell, no other person, no node, no plugin. It returns a plan; code writes. Its output is parsed by a zod schema and any extra field
   is refused. A reply that fails the schema is a `failed:judge` outcome: nothing is written, the cursor stays, and the diary records the failure
   without the model's text.

8. **Audit, events and retention.**
   - Audit kinds (subject: the person; no text, no candidate, no entry): `dream.run { mode, trigger, candidates, promoted, merged, superseded, dropped,
     applied | staged }` (counts only); `dream.apply { runId, applied }`; `dream.undo { runId, restored }`; `dream.mode { from, to }`. A run that is
     refused writes `dream.run` with `status` and a reason code, no counts.
   - Events: `brain.hippocampus.dream` with the same counts (region `hippocampus`), for the brain panel.
   - The diary `dreams/<date>.md` is the person's own file, and it may hold the reason text of each decision. It never holds a secret, because the
     candidates passed the secret gate, and it never holds another person's text.
   - Retention: the `dream_runs` table keeps its rows 90 days (a row of the database retention table, `db.md`). Archive entries are purged 30 days after
     they were archived, and undo preimages and staged plans 7 days after their run ended, by one purge step that the prune tick calls with the same
     cadence (`pruneEveryMs`). These are files, so they are not rows of `RETENTION_PERIODS`; the purge is listed in `db.md` as a file rule.
   - Removal (ADR-0027 §26): the dreaming part keeps `dream_settings` and `dream_runs` rows in the kept folder and deletes them at purge. The memory
     folder moves with the person as today; `dreams/`, `undo/` and `staged/` move with the kept folder as well, so nothing is left in the core's
     `dataDir` after the purge.

9. **Interplay with flushes.** When a person's mode is not `off`, a second `compaction.before` hook of the dreaming module adds one line to the flush
   prompt: new lasting facts go to `recent.md`, not to topic files or `profile.md`, and carry a `Source:` line. eharness joins the prompts of all hooks
   (rule 2 of spec 06 §5.2a), so the memory plugin's default prompt is kept. The `/new` flush (ADR-0030 §3) uses the same compaction path, so it behaves
   the same. With mode `off` nothing changes: the flush writes where it writes today. Explicit "remember this" from the person keeps going straight to
   the file that the front agent chooses, as today; the applier later treats it as a promotion (§4).

10. **Time zone.** The schedule and `time.between` use the core host's zone, as the rest of the hypothalamus does today. No owner time-zone setting is
    added in P35 (a later decision, with its own setting, if a person's zone differs from the host's).

11. **Persona and style are never touched.** A pass reads and writes memory files only. It never edits the persona (ADR-0029 §2), never writes a
    `person_style` row, and never changes a fixed line. Memory informs a style only through the person's own explicit style settings (ADR-0029 §3).

12. **Out of scope.** Shared household memory across persons; vector search; a graph store; auto-editing the persona; cross-person insights; a
    dreaming pass for rooms (a room has no personal memory, ADR-0026); letting a worker or a node trigger a pass.

13. **Contract and spec changes this ADR requires** (they are the first steps of P35, not done here):
    - `hippocampus.md`: "Only the front agent writes memory" gains one exception: the applier of the `dream` protocol is code acting for the same person,
      under the same root and the same secret guard. The model never writes.
    - `hypothalamus.md`: `ProtocolBuiltInSchema` gains `dream`; `SYSTEM_ACTIONS` gains `dreaming.run`, allowed only for `dream` in `authoring.ts`;
      the built-in table gains a per-person row.

## Alternatives considered

- **Let the front agent consolidate in its normal turns.** Rejected: the front agent has to answer the person in the same turn, and it sees one
  conversation at a time. Cross-day judgement is a separate task with its own cost and cut-off. Its writes stay as they are (the front agent keeps
  `memory_*` for explicit requests).
- **Shared memory blocks across agents.** Rejected: one pass changes what another agent reads. It breaks the per-person root (ADR-0020 §2), and Keith
  has no shared-memory store to protect it.
- **Delete contradicted facts.** Rejected: an LLM-chosen `DELETE` with no preimage makes an error permanent and hides it from the owner's audit.
  Invalidate-not-delete (§4) keeps the old text and its source.
- **The model writes the files directly.** Rejected: a model that writes the files can bypass the entry-loss guard, the secret guard and the
  preimage. Code writes; the model returns a plan (§3, §7).
- **Always auto.** Rejected as the default: a wrong promotion into `profile.md` shapes every answer. `propose` is the default for the owner;
  `auto` is a choice the person makes, with undo for 7 days.
- **Trigger on a turn count or on compaction only.** Rejected as the only trigger: it runs when the person is busy. A fixed time with an idle
  condition runs when the person is not talking. Compaction stays a flush point (§9), not a schedule.
- **Store the mode and the runs in the settings repo.** Rejected: settings are owner-level and keyed by name. A per-person mode and a run history
  need rows with a person key, the removal part and the 90-day retention, which `dream_settings` and `dream_runs` give.

## Consequences

- Two additive tables (`dream_settings`, `dream_runs`), migration `0022` (generated, never edited, after a backup, ADR-0027 §3). The design brief
  named one table; the mode is configuration and the run history is a log, so they are kept apart.
- Undo preimages and staged plans live under `<dataDir>/dreams/<personId>/`, not inside `memory/<personId>/` as the brief said. A `memory_*` tool can
  reach any path under the memory root, so a preimage inside it could be overwritten by the front agent.
- Source pointers name the session and the message id, not a message sequence: the table has none.
- The schedule uses the core's zone. A person in another zone sees the run at the host's 03:00.
- The judge is a `cortex`-role model call. Its cost is billed to the person, and an owner with no `cortex` model picked sees the step refused with the
  readable "no model for the cortex role" text (`providers.md`).
- A pass that runs for a person whose messages are only tool results produces nothing, and that is the intended result.
- Revisit when eharness offers a per-person flush prompt (then §9 needs no hook), when a person asks for a time zone of their own, or when a second
  front agent per person exists.

## Note (2026-11-12): judge answers for changes, failed batches, thinking off

The cost audit (`docs/research/inference-cost-audit.md`, sections 4.5 and 5.2) changed three parts of the judge contract. The rules of §4
(the applier) and §7 (the judge has no write path) are unchanged.

- The judge names only the candidates that change memory (`keep-short-term`, `promote`, `merge`, `supersede`). A candidate it does not name is
  dropped by the applier as `absent`. A `drop` decision needs no text (`DreamPlanSchema`).
- A failed judgement (`judge-output`, `turn-error`) is retried once; the second failure of the same batch skips it and advances the cursor. The
  failed row keeps the batch under a reserved cursor key (`dream_runs`, no migration).
- The judge runs with DeepSeek thinking off per call. The quality is measured with `bun run eval:dreaming` before any change of default.
