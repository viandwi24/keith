# Dreaming (memory consolidation)

Status: **built (P35).** Decision: ADR-0031. Research: `docs/research/memory-dreaming.md`. Plan: `docs/plans/done/P35-memory-dreaming.md`.
Code: `apps/core/src/modules/hippocampus/dream/` (collect, judge, prompt, apply, apply-state, apply-units, rules, entries, guard, files, undo, staged, diary, service
(wiring, apply, undo, mode, status), service-run (one run), service-skip (cadence gate, skipped starts), service-record (audit rows, events,
notices), service-types, types, service-helpers, service-text, flush-hook, purge, removal, procedures, notify), `apps/core/src/modules/hippocampus/secret-guard.ts` (the secret gate), `apps/core/src/compose-dreaming.ts` (wiring),
`apps/core/src/modules/hypothalamus/dream-protocol.ts` and `dream-steps.ts`,
`packages/contracts/src/dreaming.ts`, `packages/db/src/schema/dreaming.ts`, `packages/db/src/repos/dreaming.ts`, `packages/client/src/dreaming.ts`,
`apps/tui/src/features/memory/`. Region: `hippocampus` (memory) with a coded step in `hypothalamus` (scheduling); no new region (ADR-0004).

Every rule below is the contract the code meets. A change to the code changes this file in the same commit (AGENTS.md, hard rule 1).

## Purpose

Once a day, when a person has been idle, Keith reviews what that person said in their own front conversations and consolidates their memory: it keeps
new facts short-term, promotes the ones that repeat or that the person asked to keep, merges duplicates, and marks contradicted facts as superseded
instead of deleting them. Every run leaves a diary the person can read. The person chooses the mode: `off`, `propose` (the default for the owner: changes
wait for `/dream apply`), or `auto` (changes apply, with an undo for 7 days). Nothing outside the person's own memory folder changes, and no run ever
reads another person's data.

## Terms

- **Run**: one pass for one person, identified by a UUIDv7 `runId`. A run has a trigger (`schedule` or `manual`) and ends with one status.
- **Tier**: a file of the memory folder with a role (`profile.md`, topic file, `recent.md`, `archive.md`, diary). See "Files".
- **Entry**: one Markdown bullet of a file, with its `Source:` line (dreaming entries) and its optional `(seen <date>)` marker.
- **Candidate**: one new fact collected from the person's messages, with its source pointer.
- **Plan**: the judge's answer for a run, one decision per candidate (`DreamPlanSchema`).
- **Staged plan**: a plan written but not applied (`propose`), kept outside the memory mount until `/dream apply`.
- **Preimage**: the bytes of a memory file before the first write of a run, kept for undo.
- **Cursor**: the last collected message id per session; it moves only after the apply or the staged write succeeded.
- **Mode**: `off`, `propose` or `auto`, per person (ADR-0031 §5).

## Rule 1: one person, one principal (ADR-0031 §1)

A run acts as one person: `ctx.principal.id` is that person for every model call and every write of the run. It reads only that person's memory folder
and that person's own front-session messages (all generations, `front:<id>` and `front:<id>:g<n>`). Worker sessions (`…:agent:<task>`), rooms, other
people's folders, other people's audit rows and the workspace are never read. No run or model call mixes persons. The owner reads a member's diary only
through the audited owner path (`acl.owner-access`, ADR-0020 §4), as for any personal memory.

The leak test (`apps/core/src/dreaming-leak.e2e.test.ts`) proves the isolation of every phase with two persons and planted strings.

## Rule 2: tiers and file formats (ADR-0031 §2)

Inside the memory folder `<dataDir>/memory/<personId>/` (mounted at `/memories/<personId>`, see `hippocampus.md`):

| File | Tier | Written by | Read by the front agent |
| --- | --- | --- | --- |
| `profile.md` | pinned, core long-term (2000 characters, `maxPinnedChars`) | front agent (turns) and applier (on approval or in `auto`) | every turn |
| `<topic>.md` | long-term topic files | front agent and applier | on demand (`memory_view`) |
| `recent.md` | short-term staging: new facts with a date and a `Source:` pointer | flush (rule 9) and applier | on demand; not pinned |
| `archive.md` | superseded or expired entries, kept 30 days, then purged | applier only | on demand only |
| `dreams/<YYYY-MM-DD>.md` | the diary of one run (a second run on the same day appends `## run <runId>`) | applier only | on demand |

Entry format: `- <text>` followed by an indented `  Source: session <sessionId> message <messageId>` line and, for a short-term entry, an indented
`  (seen <YYYY-MM-DD>)` line (two separate lines, in that order). A superseded entry reads `- [superseded <YYYY-MM-DD>: <reason>] <text>` and keeps its
`Source:` line. Front-agent entries have no `Source:` line and are never dropped by the entry-loss guard (rule 4). The `entries.ts` writer refuses a text
with a line break or an empty text, a text that starts with `[superseded `, a session or message id with a space, a reason with `]`, and a date that is not
`YYYY-MM-DD`.

Code: `dream/entries.ts`: `parseMemoryFile` and `renderMemoryFile` are inverses for any text. A bullet is a dreaming entry only when its
lines render back to the same bytes; every other line is a front line kept verbatim (a malformed marker, a bullet with no `Source:` line, a bad `seen` date).
`dreamEntriesOf` lists the dreaming entries of a parsed file.

Topic names of `dream/files.ts` (`topicTier`) match `^[a-z0-9][a-z0-9-]{0,39}\.md$` and refuse `profile.md`, `recent.md` and `archive.md`, the fixed
tiers. The contract accepts those three names as a target, so the applier refuses such a candidate on its own.

Outside the mount, so no `memory_*` tool can reach them (a `memory_*` root covers everything under `/memories/<personId>`):

- `<dataDir>/dreams/<personId>/staged/<runId>.json`: the plan of a `propose` run.
- `<dataDir>/dreams/<personId>/undo/<runId>/<path>`: preimages; `<path>` is the memory-relative path, and a file the run created has a `.created` marker.

## Rule 3: phases of a run (ADR-0031 §3)

1. **Collect** (code, no model). See "Collect".
2. **Judge** (one model call, the `cortex` role). See "Judge".
3. **Apply** (code, not the model). The applier re-reads each file at apply time. It applies the rules of rule 4, or stages the plan when the mode is `propose`
   (rule 5). A file changed since collect makes its candidates `staged-changed` (see "Applier").

The cursor advances only after the apply (or the staged write). A crash between judge and apply re-collects the same messages on the next run.

`dream/service.ts` runs the phases (`run`). The crash rule is tested in `service.test.ts`, and the scheduled step repeats it (`dream-steps.test.ts`).

## Rule 4: rules of the code-side applier (ADR-0031 §4)

- **Promotion.** A candidate moves from `recent.md` to a topic file or `profile.md` only if one holds: at least 2 mentions on 2 different days (the days of
  the `Source:` pointers, counted in code); the source message contains `remember this`, `remember that`, `please remember` or `keep this` (the person's own message; English only;
  the check reads the source, not the judge's words); or importance is 8 or more. A short-term entry older than 14 days with no promotion moves to `archive.md` with reason `expired`.
- **Entry-loss guard** (`dream/guard.ts`, `checkRewrite`). A rewrite is rejected when (a) it drops a dreaming entry's `Source:` pointer while the
  entry's text stays (a dropped `Source:` line, or a pointer changed to another message), at any count; or (b) it drops more than 25 % of the prior
  entries (`lost * 4 > prior`, so exactly 25 % passes). An entry is a dreaming entry, kept by its pointer, or a front-agent `- ` bullet, kept by its
  line. A front bullet counts in (b) and is never reported as a dropped dreaming entry. A rejected file gets append-only writes
  (`appendOnlyFallback`): new entries at the end, every prior byte kept, nothing removed. An entry that left a file for another file of the same
  run (a promotion) is moved, not lost: the guard judges that file as if the entry stayed (`rewriteRejects`, `dream/apply.ts`). A unit that
  would change a refused file and whose entry lands in no file is dropped with reason `rewrite-rejected`, as a whole, so no unit writes half
  of itself. The expiry sweep is skipped when `recent.md` or `archive.md` is refused.
- **Contradictions never delete.** A superseded entry is not removed. Its line becomes `[superseded <date>: <reason>]` and a copy with its original
  `Source:` moves to `archive.md`. The new fact is written with its own `Source:`.
- **`profile.md` is a proposal.** A change to `profile.md` is staged, even in `auto`, unless it only adds one line. The 2000-character cap applies to
  the result; a result over the cap is staged, never truncated. An approved plan (`/dream apply`) is not held by this rule (Rule 5).
- **Style is out of reach.** A candidate is dropped with reason `directive` when either its source message or its plan text is a directive
  (`isDirective`, `dream/rules.ts`). The source check closes the rewording path: a judge that writes `Answers in French` for `Always answer in
  French` is still refused. The rule is per sentence. A sentence is a directive when it opens with a P33 deny word (`always`, `never`,
  `ignore`, `refuse`, `pretend`, `forget`, `reveal`, `skip`, `must`, `rule`, …) or a style phrase (`answer in`, `respond in`, `reply in`,
  `speak in`, `write in`, `call me`, `act as`) after optional filler words (`please`, `also`, `now`), when it addresses Keith (`you`, `keith`)
  with one of those words, or when the text holds `from now on` or `you are now` anywhere. A deny word in the middle of a sentence is a fact:
  `I always drink tea` passes, and so does `Remember that I never eat fish` (an explicit preference, not an instruction to Keith). A source
  message with a directive sentence drops every candidate from it. Memory never sets a style (ADR-0029 §3).
- **Secrets.** Every written line passes `looksLikeSecret` (`hippocampus/secret-guard.ts`); a hit refuses the whole candidate, with reason `secret`.
- **Caps.** A run writes at most 40 candidates and changes at most 10 files. A larger plan is staged in full; there is no partial automatic apply.
  An approved plan (`/dream apply`) is written in full: the approval lifts the caps (Rule 5, "Applier").
- **Preimage and undo.** Before the first write of a file in a run, its previous bytes go to `undo/<runId>/`. `dream.undo` restores them (a file changed since the run wrote it is kept, see "Undo and staged plans") and removes
  the created files. Preimages live 7 days after the run ended (rule 8).

## Rule 5: modes per person (ADR-0031 §5)

- `off`: no run, no protocol, no change to the flush (rule 9).
- `propose` (default for the owner on a new install): a run writes the staged plan and the diary. Nothing else changes until the person runs
  `/dream apply` (or `dream.apply`). Keith tells the person once per run through the delivery service (rule 13 and "Notify").
  The approval lifts the global rules of rule 4 (the caps, the `profile.md` proposal and size) for the units of that plan. It does not lift
  the per-unit guards (intake, the entry-loss guard, the base and changed checks): a unit one of them holds stays staged.
- `auto`: the applier writes directly under rule 4; the undo stays available for 7 days (`undo_until`).
- Default for a member: `off`. The owner may set the member default (`dreaming.memberDefault`, `off` or `propose`). A member sets their own mode with
  `/dream mode`, without a step-up (it is not a privacy change for anyone else). Changing the member default is an owner change and needs a step-up.

## Rule 6: scheduling through hypothalamus (ADR-0031 §6)

- One protocol per person whose mode is not `off`: built-in `dream`, owner = the person, trigger `time` cron `0 3 * * *` in the host zone (rule 10),
  conditions `not(signal.since <person>, 30 min)` and `budget.remaining >= dreaming.maxUsdPerRun`. `off` disables the protocol; it is never deleted,
  so its run history stays readable. See "Scheduling" below.
- The `system` step `dreaming.run` is allowed only for the built-in `dream` (`authoring.ts`). It runs `too-soon`, `few-messages`, then the run service.
- `too-soon`: a run whose latest non-skipped start is within 20 hours is refused. It applies to the schedule and to `/dream now` alike.
- `few-messages`: fewer than 5 new user messages since the cursor skip the run with no model call.
- Manual `/dream now` is `runNow(personId)`: a run with trigger `manual` that skips the idle condition (the person asked) and still obeys
  `too-soon`, which is audited and refused with `DreamRefused('too-soon')` and no run row. It calls the run service directly, not through a protocol
  run: the protocol engine has no trigger ref for a person's request, and `dream_runs` stores the trigger, not a ref. The five-message minimum is a
  schedule gate only.
- Budget: `dreaming.maxUsdPerRun` (default 0.15 USD, range 0.01 to 0.50), the cap of one judge turn. The turn is billed to the person's own scope
  only ("Judge"): the owner's monthly ledger is not charged for a dreaming run. A run that hits the cap stops with `refused:budget` and tells the
  person once with `dreamBudgetTextOf(maxUsdPerRun)`: "The dream run stopped at its cost cap of $0.15; raise it with /dream settings." ("Service").
  The default is 0.15, not 0.05: a judge turn re-sends its input at every step, and in the first real run the turn had spent 93% of 0.05 before
  it failed (ADR-0031 §6). The judge's
  candidate input is bounded: `JUDGE_INPUT_CHARS` (10 000 characters of RENDERED candidate lines, about 4 000 tokens; the budget counts each
  line as the judge reads it, with its id, day, source id and JSON-escaped text, `judgeLine` in `prompt.ts`) and `CANDIDATE_TEXT_CHARS` (2 000 per
  candidate); the newest candidates that fit are judged, the rest are dropped as `cap` and their cursor moves on ("Collect"). The memory files the
  judge reads through `view` are bounded per view: `JUDGE_VIEW_CHARS` (8 000 characters, `memory({ maxFileChars })` in `judge.ts`). One view
  returns at most that many characters: eharness cuts at a line boundary and marks the cut (`(Output truncated at 8000 characters; view the
  rest with view_range [<next>, -1].)`), so the judge sees a prefix of a large file. A file over the cap is not summarised; the judge reads its
  prefix, and a run cannot exceed the cap by one view.
- Failure causes: a run that ends `refused` or `failed` also records a closed cause (`JUDGE_CAUSES` in `judge.ts`): `no-model`, `budget-cap`,
  `max-steps`, `stopped`, `empty-reply`, `bad-plan`, `timeout`, `model-error`. The cause goes to the diary note (`run failed: judge (bad-plan)`) and
  to the service warning; the run row keeps the status and the coarse reason only (no column for the cause, so no migration). A run that starts with too little left is skipped before the judge (`budget-low`, "Judge").

## Rule 7: the judge has no write tool and no other reach (ADR-0031 §7)

The judge model call has no web, workspace, shell, node, plugin or other-person access. Its only tool is the person's own memory read tool. It returns a
plan; code writes. Its reply is parsed by `DreamPlanSchema` (extra fields refused). A reply that fails the schema is `failed` with reason
`judge` (the service's reason for `judge-output`): nothing is written, the cursor stays, and the diary records no model text.

## Rule 8: audit, events and retention (ADR-0031 §8)

- Audit kinds (subject: the person; counts and codes only, never text, candidates or entries):
  - `dream.run { mode, trigger, status, reason?, candidates, promoted, merged, superseded, dropped, applied | staged }`; a refused run writes the
    same kind with `status` and `reason` only.
  - `dream.apply { runId, applied }`; `dream.undo { runId, restored }`; `dream.mode { from, to }`.
- Event `brain.hippocampus.dream` (region `hippocampus`, for the brain panel; no text). Two records per run that has a row, paired by `runId`:
  `phase: 'start'` after the collect (`candidates` is the count the run reviews, the other counts zero, `applied` false) and `phase: 'end'` when the run ends, whatever
  its status (the counts, `applied`, and the run row's `status` and `reason` as closed codes, never text). Both carry `trigger` (`schedule` or `manual`).
  A run whose collect throws has an `end` with no `start`. A run refused before its row (mode `off`, `too-soon`) writes
  no event. Both go to the person's current front session only.
- Diary `dreams/<date>.md`: the person's own file. It may hold the reason text of each decision. It never holds a secret (candidates passed the
  secret gate) and never another person's text.
- Retention: `dream_runs` rows 90 days after `ended_at` (a row of `db.md`). Archive entries purged 30 days after archiving; preimages and staged plans
  7 days after their run ended. Files are not `RETENTION_PERIODS` rows; `db.md` lists the file rule (the purge is in "Retention and removal").

## Rule 9: flush redirection (ADR-0031 §9)

When a person's mode is not `off`, a second `compaction.before` hook returns one extra flush line: new lasting facts go to `recent.md`, not to topic
files or `profile.md`, and carry a `Source:` line. The memory plugin's own flush prompt is kept (eharness joins the prompts of all hooks, spec 06
§5.2a rule 2). The `/new` flush (ADR-0030 §3) uses the same compaction path. With mode `off` nothing changes. An explicit "remember this" from the
person still goes to the file the front agent chooses, as today; the applier later treats it as a promotion (rule 4).

Code: `dream/flush-hook.ts` (`dreamFlushPlugin`, registered in `wernicke-broca/agent.ts` through `FrontHardening.dreamFlush`,
wired in `compose.ts`). The hook reads the session principal's mode only, and the `/new` flush uses the same hook chain (trigger `manual`).
The same plugin also carries the manual failure policy (ADR-0030 note Nov 13, 2026): a `manual` compaction (`/new`, `/compact`) returns
`flush.onFailure: 'abort'` with its own one-line prompt, whatever the mode. Automatic compactions get no policy (`'continue'`). Both parts
merge into one patch (`mergeFlushPatches`).

## Rule 10: time zone (ADR-0031 §10)

The schedule and `time` conditions use the core host's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`, read in
`compose-protocols.ts`). There is no owner time-zone setting. A person in another zone sees the run at the host's 03:00.

## Rule 11: persona and style are never touched (ADR-0031 §11, ADR-0029)

A run reads and writes memory files only. It never edits the persona (ADR-0029 §2), never writes a `person_style` row and never changes a fixed line.

## Rule 12: out of scope (ADR-0031 §12)

Shared household memory across persons; vector search; a graph store; auto-editing the persona; cross-person insights; a pass for rooms (a room has
no personal memory, ADR-0026); a worker or a node starting a pass.

## Files

Memory folder: see rule 2. Outside the mount: `<dataDir>/dreams/<personId>/{staged,undo}/`. The folder `dreams/<personId>/` moves with the kept
folder on removal ("Retention and removal"). Nothing is left in `dataDir` after the purge.

Code: `dream/files.ts`. A path is always built from a tier (`MemoryTier`: `profile`, `recent`, `archive`, `topic`, `diary`), never from a
free string: `tierPath` gives the relative path, `tierOfPath` reads one back (undefined for anything else, such as `..` or a folder). `memoryFileOf` is the
person's file; `outsideDirOf`, `stagedFileOf` and `undoDirOf` are the outside folders, and `assertOutsideMemory` throws when one is under `memory/`. Person and
run ids pass `checkedPersonId` and `checkedRunId` (the `SAFE_ID` rule of `platform/workspace-resolve.ts`). `readMemoryBytes`, `readMemoryFile`,
`writeMemoryFile` and `removeMemoryFile` are the only calls dreaming uses on the memory folder. Written as UTF-8 text or as raw bytes, so a preimage
restores exact bytes.

## Undo and staged plans

Code: `dream/undo.ts` and `dream/staged.ts`. Both write only under `<dataDir>/dreams/<personId>/`. The memory folder is changed only
through the `files.ts` helpers (`openRunWriter` calls them after it takes the preimage).

- **Preimage.** `openRunWriter(dataDir, personId, runId)`: `write(tier, content)` and `remove(tier)` take the preimage of the file first, unless the store
  already holds one for that file in that run (a preimage or a `.created` marker, read from disk, so a restart does not take a second one). A file with
  bytes gets a copy at `undo/<runId>/<tier path>`; a file that did not exist gets an empty `<tier path>.created` marker. Opening the writer writes nothing.
- **Restore.** `restoreRun(dataDir, personId, runId)` reads and checks every entry of the store first (a path no tier names throws, nothing is written),
  then writes each saved file back with its exact bytes and deletes each created file, but only a file that still holds what the run left there
  (its recorded hash, or its saved bytes, which a crash midway leaves). Any other file is kept and named in the result's `skipped` (memory-relative
  paths). It then removes the undo folder, so a second restore changes nothing. A crash midway leaves the folder, and a repeat restore gives the same result.
- **Written record.** Each write of `openRunWriter` records, before the write lands, the SHA-256 the file should hold after it, in
  `undo/<runId>/written.json` (`null` for a removal). `preimagesOf` skips this file. A run written before the record has no `written.json`: its
  restore is unguarded and restores every file, as it did before (no hash, so no check). A file changed by a chat write or by a newer run after
  the run wrote it is therefore kept, and the undo of an older run never reverts a newer run's file.
- **Window.** `undoUntilFrom(writtenAt)` is `writtenAt` + 7 days; the service stores it as `undo_until` at the write of an `auto` run or of an applied
  plan. `decideUndo({ now, undoUntil, hasPreimages })` is a pure check: `nothing-to-undo` when the folder is empty, when `undo_until` is null, or when `now`
  is past it (`now` equal to `undo_until` still counts).
- **Staged plan.** `writeStagedPlan` / `readStagedPlan` / `removeStagedPlan` keep `<dataDir>/dreams/<personId>/staged/<runId>.json`: `runId`, `personId`,
  `stagedAt` (ms), the `DreamPlan` (`DreamPlanSchema`, strict), `candidates` (the collected candidates the plan names: id, text, role, session, message,
  day, so `apply` needs no re-collect) and `base`, the SHA-256 of each memory file the plan was judged against, keyed by its tier path (null when absent). Writes go through `writeFileAtomic` (`files.ts`): a unique temporary file in the same folder, fsynced, then renamed over the target. A failure
between the temporary write and the rename leaves the old file intact and removes the temporary file. Memory files, undo preimages and
staged plans all use it (P35.6.1); the old text was `<file>.tmp`, fsynced and renamed over the file, so a crash leaves the old or the new plan. A read of a
  missing file gives undefined; a file that is not a valid plan throws and stays in place. The read checks that the run id and person id match the path.
- **Staged-changed.** `changedSince(dataDir, personId, plan)` lists the paths whose content no longer hashes to `base`; `apply` refuses a plan with any
  (`staged-changed`, rule 4 and "Service").

Tests: `undo.test.ts`, `staged.test.ts` (next to the code). A new process reads a staged plan back (the restart case).

## Tables

One additive migration `0022` (generated by `bun run --filter @keith/db db:generate`, never edited; run after a backup, ADR-0027 §3).

| Table | Columns | Notes |
| --- | --- | --- |
| `dream_settings` | `person_id` (text primary key), `mode` (`off`, `propose`, `auto`), `updated_at`, `updated_by` | absent row = the default (`propose` for the owner, the member default for others); no foreign key (the removal part deletes it at purge) |
| `dream_runs` | `id` (UUIDv7), `person_id`, `trigger` (`schedule`, `manual`), `mode`, `status` (`running`, `applied`, `staged`, `skipped`, `refused`, `failed`, `rejected`), `reason` (short code or null), `started_at`, `ended_at`, `counts` (JSON), `cursor` (JSON: last collected message id per session), `undo_until` (ms, null) | cadence anchor: latest `started_at` of a non-`skipped` row; cursor: latest `applied` or `staged` row's; 90 days after `ended_at` |

Schema `packages/db/src/schema/dreaming.ts`; repo `packages/db/src/repos/dreaming.ts` (`dreamingRepo`: `getMode`, `setMode`, `startRun`, `endRun`,
`latestStarted`, `cursorOf`, `listRuns`, `deleteForPerson`). `getMode` is undefined without a row: the caller applies the default.
`migration-0022.test.ts`: older rows unchanged; both tables empty after migrate; a second `setMode` for the same person is one row.

## Contracts

`packages/contracts/src/dreaming.ts`:

- `DreamModeSchema`: `off`, `propose`, `auto`.
- `DreamPlanSchema` (strict): `candidates[]` with `id`, `action` (one of `keep-short-term`, `promote`, `merge`, `supersede`, `drop`), `target` (`profile`, `recent`, or a
  topic file name), `text` (up to 300 characters; non-empty for `keep-short-term`, `promote`, `merge` and `supersede`, and empty allowed for `drop`:
  a `superRefine` in `DreamCandidateSchema`), `reason` (up to 200), `importance` (integer 1 to 10), `sourceMessageId`, `supersedes` (optional entry
  text key, up to 300). A target with a path separator is refused; `importance` 0 and 11 are refused; an action outside the five is refused.
  A plan may hold any number of candidates up to 200, including none: the judge names only the candidates that change memory (Judge).
- `DREAM_RUN_STATUSES` is the `dream_runs.status` set (`running`, `applied`, `staged`, `skipped`, `refused`, `failed`, `rejected`); `DreamRunViewSchema` and the audit detail take it.
- `DreamRunViewSchema`; RPC inputs: `dream.mode` `{ mode }`, `dream.apply` `{ runId }`, `dream.undo` `{ runId? }` (output `{ runId, restored, skipped }`), `dream.diary` `{ date?, personId? }`
  (`personId` only for the owner reading a member's diary, `permissions.md` "Dreaming"), `dream.settings.set` `DreamingSettingsSet` (a partial change).
- Settings bounds: `dreaming.maxUsdPerRun` (0.01 to 0.50, default 0.15); `dreaming.memberDefault` (`off` or `propose`, default `off`).
- Refusal reasons: `too-soon`, `few-messages`, `no-model`, `budget`, `turn-running`, `staged-changed`, `nothing-to-undo`, `off`.
- Skip reasons (`DREAM_SKIP_REASONS`, a `skipped` run, not a refusal): `budget-low`. `DreamRunReasonSchema` is the union of refusal, failure and
  skip reasons that a run row or view carries.
- `ProtocolBuiltInSchema` gains `dream`; `SYSTEM_ACTIONS` gains `dreaming.run` (`packages/contracts/src/protocols.ts`).
- Audit kinds and the activity kind of rule 8.

`scripts/exports.snapshot.json` is regenerated (`bun scripts/check-exports.ts --write`), never edited.

## Collect

`dream/collect.ts` (types in `dream/types.ts`). `collectCandidates(sqlite, { personId, generations, cursor })` reads the person's front
sessions: `front:<id>` and `front:<id>:g<n>` for every generation from 0 to `generations.current(personId)` (P34). A worker session (`:agent:`) is
never in that list. Output: `{ candidates, dropped: { secret, cap }, nextCursor }`. The function stores nothing: the caller stores `nextCursor` when
the run has done its work, so a run that fails before then reads the same messages again.

Gates, all structural:

1. **Session gate.** Only the front sessions listed above are read. Worker sessions (id contains `:agent:`) are not.
2. **Kind gate.** A message with `metadata.eharness.kind` (any kind: `eh.event` worker reports, `eh.flush`, `eh.notice`, `eh.compaction`, plugin
   events) is excluded. Metadata that does not parse is treated as a kind message.
3. **Role gate.** Only `user` and `assistant` rows. A `tool` row is excluded.
4. **Part gate.** Only parts of type `text` are collected: a file, reasoning, step, tool or data part is never part of a candidate. A user message
   keeps its text parts minus the last `metadata.eharness.augmented` ones, which the front agent appended as context (not the person's words).
5. **Turn gate (assistant only).** An assistant message is collected only when its turn (`metadata.eharness.turnId`) has a non-kind user message
   and no tool part (`tool-<name>` or `dynamic-tool`), and no part of the turn is unreadable. The whole turn is read, including messages before the
   cursor, so a turn that straddles the cursor is judged whole. An assistant message without a turn id is excluded. A wake turn or a
   worker-report reply has no user message of its own, so it is excluded by this gate (the turn kind is not stored, see "Harness check").
6. **User text** is always collected (rule 4 limits what one paste can do).
7. **Secret gate.** Every candidate text passes `looksLikeSecret`. A hit drops the candidate and counts `dropped.secret`; its text is not returned.
8. **Cap.** Candidates are sorted by creation time (then session and message id). Above `COLLECT_CAP` (200) the oldest are dropped and counted in
   `dropped.cap`; the newest are kept. The judge budget (`JUDGE_INPUT_CHARS`, rendered characters) is applied the same way: the newest lines that fit
   are kept, the rest count as `dropped.cap` (the rendered line is the unit, so many short messages reach the budget too).

Each candidate: `id` (`c1`, `c2`, ... in time order, unique within one run), `text`, `role`, `sessionId`, `messageId`, `day` (`YYYY-MM-DD` of
`created_at` in the core host's zone, Rule 10). `nextCursor` maps each session read to its last message id read (dropped and excluded messages
included); a session with no new message keeps its old cursor entry. Message ids are UUIDv7 and sort by creation time (spec 03 §3), so the cursor
is an id and no sequence column is needed.

## Judge

`dream/judge.ts` and `dream/prompt.ts`.

- `judge(personId, candidates, deps)` runs one eharness agent turn, model role `cortex` (`roleModel('cortex', providers, 'dream-judge')`, so a
  DeepSeek model runs it with thinking off per call; see "Thinking" below). The principal is
  `{ id: <personId>, billTo: <personId> }`: `billTo` is a Keith field of the principal (the eharness principal allows extra JSON keys), read by
  `billedPerson` (`budget/budget.ts`). The session is `dream-judge:<uuid>`, a new one per run, with no lock.
- **No transcript (P35, fixed after the judge's first version).** The agent is built with eharness' default in-memory adapters: no core
  `storage`, no inbox, no lock (`judge(personId, candidates, deps)` takes no `storage` and no `lock`). The candidate texts and the memory views
  therefore live only in that agent, and `judge` calls `agent.close()` in a `finally`, so the turn's messages are gone when the run ends, also
  when the turn fails. No `eh_messages` or `eh_state` row of a `dream-judge:` session is written, so removal, export and purge of a person never
  meet one, and an owner's activity feed sees none. The activity logs still record the judge's model calls by principal (`activity-logs.md`,
  `dream` kind; `capture.ts`): the figures, and, when `captureBodies` is on, the request and response bodies. Those bodies carry the judge
  prompt, so the candidate texts persist there under the activity logs' own retention (`bodyRetentionDays`, `activity-logs.md`); this note does
  not change that contract.
  Installs that stored judge transcripts before this change lose them at the prune tick (`platform/retention.ts`, "Retention" in `db.md`): a
  range delete of the `dream-judge:` prefix from `eh_messages` and `eh_state`, audited as `data.pruned` only while it deletes something.
- Budget: `deps.budget.scoped({ maxTurnUsd: deps.maxUsdPerRun }, () => [personScope(personId)])` The turn reserves against the person's
  scope only, so the owner's ledger (`owner`) is never charged for a dreaming turn, the owner's own included; the per-person cap of the person applies.
  A turn that stops with `cost-cap` is the refusal `budget`; the cursor stays.
- Budget gate (P36): before the judge turn the service reads `budgetRemaining(personId)` (the composition: `budget.statusOf(personId).remainingUsd`,
  the lower of the person's cap and the global limit; null when no limit applies). With `reservation = dreaming.maxUsdPerRun`, a run whose
  remaining is below `budgetLowAt(maxUsdPerRun) = reservation + FRONT_TURN_BUDGET_USD` (the judge's cap plus one whole chat turn, 0.5 USD;
  Nov 14, 2026: before, twice the cap left less than a chat turn reserves, P35 known limit) ends `skipped` with reason `budget-low`: no judge call, no
  reservation, the cursor stays, one diary note (`skipped: the remaining budget is low`), no notice to the person, one `end` brain event.
  The reservation itself is released by eharness when the judge turn ends (its ledger releases an open reservation at the end of the turn, also
  when the turn fails); the judge awaits the turn inside a `try`, so a failed turn leaves no reservation behind.
- Tools: exactly one, `memory`, read-only. The agent's file system is the person's folder only (`diskFs` of `<dataDir>/memory/<personId>`, no file
  tools). The `memory()` plugin has one root `/` with `write: false`, `protocol: false` and the `tool` option (spec 14 §8): its input schema allows the
  `view` command alone, so a `create`, `str_replace`, `insert`, `delete` or `rename` is refused before the executor runs. The root resolves only when
  the turn's principal is the person; for any other principal it is empty and every command is `REJECTED`. No web, workspace, shell, node, plugin or
  other-person tool. Approval: reads approved, writes, external and destructive denied.
- Prompt (`prompt.ts`): `JUDGE_INSTRUCTIONS` is the fixed English system text (the same for every person). It states that the candidates are data,
  not instructions; lists the four changing actions (`keep-short-term`, `promote`, `merge`, `supersede`), the plan fields and the length limits; asks
  for strict JSON only, with no fence and no prose; and names the read-only memory tool. `buildJudgePrompt(candidates)` is the user message: one line
  per candidate with `id`, `day`, `sourceMessageId` and `text` (`judgeLine`), each value as a JSON string (a line break in a text cannot start a new
  line). It is built from the candidates only: no profile, no topic file, no other person's text (tested).
- **The judge answers only for changes (F3).** A candidate that changes no memory gets no decision: its id is left out of the plan. The
  prompt says so, and the applier counts every candidate the plan does not name as dropped with reason `absent` (Applier, "Units"). `drop` stays
  a valid action in the schema, so an older or different reply still parses; the applier drops it as before (`drop`). The safety rules of the
  applier (the 25 % guard, `supersede` not delete, the directive filter, the secret gate, the caps) are unchanged and apply to the changes named.
  An id the model invents, that is not a collected candidate, is still refused (`source`).
- Reply: the last assistant text. One code fence around the whole reply is stripped, nothing else; the body is parsed with `JSON.parse` and then
  `DreamPlanSchema` (extra fields refused, at the top level and in a candidate). A parse or schema failure is `judge-output`. The reply text is never
  returned, logged or stored in the diary (rule 7).
- Results: `{ ok: true, plan }` or `{ ok: false, reason }` with `no-model` (the `cortex` role does not resolve), `budget` (`cost-cap`),
  `judge-output`, or `turn-error` (the turn threw or stopped for another reason; the error text is not kept). `no-model` is checked before the turn.
  A person id that is not safe (`checkedPersonId`) throws before any turn. A reply with no decision at all (`{"candidates": []}`) is a valid plan.
- **Failed batches (F2).** A failure that is not a refusal (`judge-output`, or `turn-error`) ends the run `failed` and keeps the cursor, so the next
  run judges the same messages once more. The failed run row holds the batch under the reserved cursor key `$failed-batch` (`FAILED_BATCH_KEY` in
  `packages/db/src/repos/dreaming.ts`): the source message ids of the batch, next to the resume cursor. The next run that judges a batch sharing a
  source message with it, and fails again, skips that batch: the cursor advances past it (the row holds `[]` under the key), nothing is written, the
  diary gets `dropped.failed: N candidates were skipped after two failed judgements; nothing was changed` and the normal `run failed` notice is sent.
  A run that applies or stages clears the memory (the row no longer holds a batch). A refusal (`no-model`, `budget`) and a crash in the applier are
  not counted. Cost: at most one judge spend per failing batch, not one per night.
- **Thinking (F7).** The judge turn runs with DeepSeek thinking disabled per call (`providerOptions.deepseek.thinking = { type: 'disabled' }`) when its
  model is a DeepSeek model; any other provider is untouched (`providers/thinking.ts`, `NO_THINKING_CALLS`, `INFERENCE_THINKING`). The quality of the
  judge with thinking off is NOT measured yet. The owner compares it with `bun run eval:dreaming` (real model, costs money, not in `check`) with the
  setting `INFERENCE_THINKING` set to `auto`, on the same candidates.

The prompt lines carry `sourceMessageId` as well as `id`, `day` and `text`, because the plan must echo the message id
of each candidate and the model cannot know it otherwise; `turn-error` is a failure reason, not a refusal (the run
records it as `failed`, reason `turn-error`).

## Applier

Code: `dream/apply.ts` (the plan, the passes, the writes), `dream/apply-state.ts` (the files as read, the draft of one candidate),
`dream/apply-units.ts` (keep, promote, merge, supersede, expiry), `dream/rules.ts` (the pure rules), `dream/entries.ts` (the line format).
`dream/guard.ts` (`checkRewrite`, `appendOnlyFallback`, `addedEntries`, rule 4) is called from `rewriteRejects` before each write.

`applyPlan({ dataDir, personId, runId, today, plan, candidates, base, dryRun? })` returns `{ written, staged, dropped, counts }`. The model never
writes. `base` is the content hash of each memory file as the judge read it (a missing key is an absent file).

- **Units.** Each plan candidate is one unit that changes its files all or nothing. Intake drops a candidate whose source pointer (`id` and
  `sourceMessageId`) is not a collected message (`source`), whose action is `drop` (`drop`), whose text is secret-shaped (`secret`), that reads as
  a directive (`directive`: the source message or the text holds a directive sentence, see Rule 4), or whose target is a reserved file name (`target`).
  A text the entry format cannot hold is `format`; a repeat of an entry already there is `duplicate`. A collected candidate the plan does not
  name is dropped as `absent` (the judge answers only for changes, Judge). `counts.candidates` is the number of candidates judged, so every
  candidate is written, staged or dropped.
- **Re-read.** Each pass reads the files from disk. A unit that would write a file whose content differs from `base` is `staged-changed` and writes
  nothing. The files are read again right before the first write; a mismatch throws before any write.
- **Preimage.** Writes go through `openRunWriter` (`undo.ts`), so the first write of each file keeps its preimage for `dream.undo`.
- **Partial write.** The files are written one by one. A write that fails before any file changed is thrown as it is. A write that fails after
  `n >= 1` files changed throws `ApplyPartialError` (`apply.ts`, with `written: n`): the files already changed stay, and the run keeps its undo
  window (`apply-partial`, see "Service"). `applyPlan` takes an optional `writer` (default `openRunWriter`) so a test can fail a write.
- **Global rules.** Caps: more than 40 written candidates or more than 10 changed files stages every written unit (`cap`). `profile.md`: one
  change that only adds one entry (a bullet and its `Source:` line) and leaves the file at 2000 characters or less is written; any other change
  to it is staged (`profile-proposal`), and a result over 2000 characters is staged (`profile-size`), never truncated. A global rule re-runs the
  pass without the staged units. `approved: true` (the service's `apply`) skips this rule: the person's approval is the answer the rule asks
  for. The per-unit guards stay on; a unit one of them still holds comes back in `staged` (`staged-changed`).
- **Fall-backs.** A promotion whose rule does not hold stays short-term. A merge or supersede with no matching live entry becomes a short-term
  fact. A promotion whose target is `recent` is a short-term fact.
- **Mentions.** A promotion counts the distinct days of the plan candidates with the same normalised text and the `seen` days of the recent
  entries with that text (`normalizeText`: case, spacing and trailing punctuation). The `remember` phrases are read in the person's own message only
  (`remember this`, `remember that`, `please remember`, `keep this`).
- **Entries.** Only dreaming entries (with a `Source:` line) are matched by merge and supersede. A front-agent line has no `Source:`, so it is
  never superseded or merged here.
- **Merge.** The entry takes the new wording and keeps its own `Source:` (the format holds one `Source:` per entry). In `recent.md` it takes today's
  `seen` date.
- **Supersede.** The old line is marked in place (`[superseded <date>: <reason>]`, the reason with no `]` and at most 200 characters), a copy with
  its original `Source:` goes to `archive.md`, and the new fact goes to its target with its own `Source:`. Nothing is deleted.
- **Expiry.** After the units, each live `recent.md` entry whose `seen` is more than 14 days before the run moves to `archive.md` as
  `[superseded <date>: expired]`. The sweep is skipped when `recent.md` or `archive.md` changed since the judge read them.
- **Secrets.** Each entry line the applier writes passes `looksLikeSecret`; a hit drops the candidate (`secret`).
- **Result.** `written` lists each unit's effect (`kept`, `seen`, `promoted`, `merged`, `superseded`) with its memory paths, and the expiry sweep
  with id `null`. `rewriteRejected` lists the paths whose rewrite the guard refused (those files got the append-only fallback). `staged` lists `{ id, reason }` with reason `staged-changed`, `profile-proposal`, `profile-size` or `cap`. `counts` holds the
  candidate, promoted, merged, superseded, kept, expired, dropped and staged totals; no text.

`apply` in the service applies a staged plan only on the person's own call (rule 5, "Service").

## Diary

Code: `dream/diary.ts`. `dreams/<YYYY-MM-DD>.md` inside the person's memory folder (`memory/<personId>/dreams/`), the person's own file.
A day starts with `# Dreams <date>`; each run of the day appends a `## run <runId>` section, and earlier bytes are kept. One line per candidate:
`- <action> [-> <target>]: <text> (<reason>)`, where `<action>` is what the applier did (`promoted`, `merged`, `superseded`, `kept`, `seen`,
`expired`, `dropped`, `staged`) or what `propose` would do (`proposed`). The text and the reason are the plan's own fields; the model's raw reply is
never written. Every line is collapsed onto one line and passes `looksLikeSecret`; a hit is replaced by `- <action>: line withheld (looks like a
secret)`. A run with nothing to record writes `- nothing to record`. The diary is not undone by `dream.undo`.

## Service

`dream/service.ts` (`createDreamService`). The mode is the stored one; without a stored row it is `propose` for the owner and
`dreaming.memberDefault` (`off`) for a member.

- `run(personId, trigger)`. `off` writes a `dream.run` audit row (`refused`, `off`) and no run row. Otherwise a `running` row starts, then collect
  (from the cursor of the latest `applied` or `staged` row), then judge. The base hashes of `profile.md`, `recent.md`, `archive.md` and every topic
  file are read before the judge turn. No candidates: the run is `skipped` and no model is called. A judge refusal: `no-model` and `budget` end
  `refused`; `judge-output` ends `failed` with reason `judge`; `turn-error` ends `failed` with reason `turn-error`. A judge failure writes one diary
  note with the reason only. An unexpected error ends the run `failed` with no reason and writes no note. A write that stops after files
  changed (`ApplyPartialError`) ends the run `failed` with reason `apply-partial` and `undo_until` now + 7 days, so `dream.undo` can put those
  files back; no note is written and the cursor stays (the next run collects the same messages, see Known limits).
  - `propose`: a dry run of the applier gives the counts and the diary (`proposed <effect>` lines); the plan is staged with its base and candidates.
    No memory file changes.
  - `auto`: the applier writes with preimages. The units a global rule held back (`cap`, `profile-proposal`, `profile-size`) become a staged plan of
    their own. Its base is read after the writes: a file the run wrote is hashed as it is now, and every other file keeps the pre-judge base
    (`heldBaseOf`, `service-helpers.ts`), so a change made during the judge turn still makes `apply` refuse the plan. `undo_until` is now + 7
    days when a preimage exists.
  - The diary section is written, then the row ends (`staged` or `applied`) with its counts and the cursor. The cursor moves only at that end, so a
    crash before it leaves the cursor and the files as they were, and the next run collects the same messages.
- `apply(personId, runId)`: the person's own call (RPC or TUI). No staged file: a no-op (nothing written, no audit row). When a file of the base
  changed since the judge read it, the whole plan is refused with `staged-changed` and nothing is written. The outdated plan is dropped: its staged file is removed and the run row becomes `rejected` with reason `staged-changed`. A `rejected` row does not move the cursor, so the next run collects the same messages and plans them again. The cadence is unchanged (`too-soon` still applies for 20 hours). Otherwise the applier writes with
  preimages with `approved: true` (the global rules of rule 4 do not stage the approved units; the per-unit guards still apply), `undo_until`
  is set, the diary gets a `## apply <runId>` section, and the row ends. The row ends `applied` (or `staged` when nothing was written and a
  unit is held). The staged file is removed after the row is ended, so a failure of the diary write leaves the plan in place. A unit a per-unit
  guard still holds (`staged` in the result) is not reported as applied: it stays in a staged file of exactly those units, with its base read
  after the writes (`heldBaseOf`, as in `auto`). `dream.apply` is audited with the applied count, and the call returns `{ applied, staged }`.
  A second apply is a no-op. A write that stops after files changed (`apply-partial`) ends the run `failed` with its `undo_until` set, the
  staged file is removed after the row is ended (the plan is spent), no `dream.apply` row is written, and the call returns `applied: 0`
  (the RPC answers with the run view, which reads `failed`, `apply-partial`).
- `undo(personId, runId?)`: the given run, else the latest `applied` run (or failed `apply-partial` run) whose window is open. It restores the preimages (a file the run created is
  removed) and sets the run's `undo_until` to null. Refused with `nothing-to-undo` when there is no run, the window has passed, or no preimage exists. The result is `{ runId, restored, skipped }`: `skipped` names the files kept because they changed after the run wrote them (the TUI says so, "kept <file>: it changed after this dream").
  `dream.undo` is audited.
- `setMode(caller, personId, mode)`: a person sets only their own mode (another caller: `DreamForbidden`). `dream.mode` is audited with `from` and
  `to`. After the row is stored, `onModeChanged` re-syncs the person's `dream` built-in (`syncDream`, rule 6); a failure is warned, not thrown.
  The member default is not set here: `dream.settings.set` sets it (RPC).
- `runView(personId, runId)`: one run of the person as the person reads it (the counts, state and whether a staged plan waits); undefined for an
  unknown run. `dream.now` and `dream.apply` answer with it.
- `status(personId)`: the mode, the latest run as a view, `nextRunAt` (the latest non-skipped start + 20 hours, or null when a run may start), and
  `canApply` and `canUndo`. `canApply` is true when the newest of the last 50 runs that has a staged file exists; `stagedRunId` names that run
  and `stagedRunStartedAt` its start (the day of the diary that lists the staged entries); both are present only with `canApply`. A later skipped, refused or applied run does not hide the plan. `lastRun` stays the newest run (its
  `staged` flag is true only when it holds the plan). `/dream apply` applies `stagedRunId`. With `canApply`, `stagedExpiresAt` is the end of the
  waiting plan: that run's `ended_at` + 7 days, the purge horizon (`stagedExpiresAtOf`, `purge.ts`). `DreamStatusViewSchema.stagedExpiresAt`
  and `stagedRunId` are optional and absent without a plan.
- `diary(personId, date?)`: the diary of a day, or of the latest day that has one.
- `isTooSoon`, `skip` and `pendingUserMessages` are the gates the `dreaming.run` step reads (see "Scheduling"); `runNow` is
  the manual run above.
- A `budget` refusal sends one notice through the delivery service (`deliver`): request id `dream:<runId>:budget`, source `dreaming`,
  name `dreaming.notice`, the text `dreamBudgetTextOf(maxUsdPerRun)` (the cap in USD and `/dream settings`), mode `note`. No other refusal sends one. Absent `deliver`, nothing is sent.
- A `propose` run that stages its plan sends one staged notice after its row is final (`notify.ts`, "Notify"). No other status sends one.

Refusals leave the service as `DreamRefused` (the reason of `DREAM_REFUSAL_REASONS`); a call by someone else leaves as `DreamForbidden`.

- **Boot repair (P35.6.1, changed in P36).** `endInterrupted()` ends every `running` row, whatever its age, as `failed` with reason
  `interrupted` (`DREAM_FAILURE_REASONS`), through `DreamingRepo.failRunning()`. The composition calls it once at boot: nothing runs before the
  boot, so every `running` row belongs to a process that is gone (no 10-minute cutoff: a row started just before the restart would otherwise
  keep showing `dreaming…`). Each ended run gets its `end` brain event (`brain.hippocampus.dream`, `phase: 'end'`, zero counts, `applied:
  false`), so a client that showed `dreaming…` clears it. Each ended run also gets one `dream.run` audit row (actor `system`, `status`
  `failed`, `reason` `interrupted`, no counts), the same row a run that ends on its own writes. Its staged files stay for undo as before. No migration: `failed` and `interrupted`
  are existing values.

## Scheduling

`apps/core/src/modules/hypothalamus/dream-protocol.ts` and `dream-steps.ts`. Hypothalamus holds the engine; the
model is a step, not the scheduler (ADR-0024).

- `syncDream({ protocols, personId, mode, maxUsdPerRun, now })`: idempotent like `syncOwnerAbsence`. Creates the protocol (name and built-in `dream`,
  owner = the person) when mode is not `off`, enables it, disables it when `off` (never deletes; `off` with no row writes nothing). A changed
  `maxUsdPerRun` saves a new version. A second sync with the same inputs writes nothing. The cap is passed in because the condition carries it:
  `budget.remaining` `usdAtLeast` is the cap, so a cap change is a definition change.
- `Protocols.syncDream(personId, mode?)` (`compose-protocols.ts`) runs the sync for every person at boot, with the effective mode (stored, else the
  owner default `propose` or the member default), and is the hook a mode change calls. The effective mode of a person with no stored row is
  `effectiveDreamMode` (`dream-protocol.ts`).
- Conditions: `not(signal.since <person>, 30 min)`. The idle test reads the sign of life that parietal exposes; `signal.since` is the same 30-minute
  window that parietal's `awayAfterMs` uses. The step records which value the code reads (open verification in the plan). Both conditions name the
  person the protocol belongs to.
- `dreaming.run` (system step, `hypothalamus/dream-steps.ts`): `too-soon` (the service's `isTooSoon`: the latest non-skipped start is less
  than 20 hours ago; the step outcome `refused:too-soon`, one `dream.run` audit row, no run row), then `few-messages` (`pendingUserMessages` under 5:
  `skipped` row with reason `few-messages`, the outcome `refused:few-messages`, no model call), then `service.run(personId, 'schedule')`. The
  outcome maps `applied`, `staged` and `skipped` to `ok`, a refusal to `refused:<reason>`, a failure to `failed:<reason>`. The system port of
  `compose-protocols.ts` routes this action to the step when a dreaming service is given; without one it answers `failed:not-wired`. A crash between
  judge and apply leaves the cursor and the files unchanged.

## Flush

`dream/flush-hook.ts` (`dreamFlushPlugin`). A `compaction.before` hook returning `{ flush: { prompt: <one line> } }` when the mode is not `off`,
and `{ flush: { prompt, onFailure: 'abort' } }` for a `manual` compaction (eharness 0.13.0, spec 06 §5.2a rule 9a; the prompt is required).
It is registered next to the memory plugin in `wernicke-broca/agent.ts`. It returns a valid patch and never throws (eharness skips a hook that throws,
`W_HOOK_FAILED`; spec 06 §5.2a rule 2). It reads only the mode of the person of the session.

## Retention and removal

- Prune tick (`compose-timers.ts`): `dream/purge.ts` deletes archive entries 30 days after archiving, and preimages and staged plans 7 days after
  their run ended. Each purge is audited as `data.pruned { table, count }` with table names `dreaming.archive`, `dreaming.undo`, `dreaming.staged`.
- `dream_runs` rows follow `RETENTION_PERIODS` (90 days, `platform/retention.ts`) and the `db.md` row.
- Purge (`dream/purge.ts`): archive entries are dropped when their marker date (`superseded.date`, which is also the expiry date of an
  expired entry) is more than 30 days old; undo folders and staged plans of a run are removed once the run's `ended_at` is more than 7 days old. A run
  still `running`, or with no row, keeps its folder. Front lines of `archive.md` are never removed.
- Removal part `dream/removal.ts` (registered in `compose.ts` next to the prefrontal part, ADR-0027 §26): on removal the `dreams/<personId>/` folder
  moves into the kept folder as `dreams/` and comes back on undo. The `dream_settings` and `dream_runs` rows stay in the database where they are: they
  have no foreign key to `people`, so the person's delete does not reach them. This is a deviation from the first design text, which moved the rows into the
  kept folder: nothing reads them from a folder, so they are not copied. `export` writes nothing (the diary is a memory file). On purge (the removal's keep
  time) the part deletes both tables' rows of that person and the folder. A removal that fails in this part is undone with the other parts (`people.md`).

## RPC

`dream/procedures.ts` (`dreamProcedures`), wired by `compose-dreaming.ts` into the `dream` area of `compose-regions.ts`. The typed client is
`packages/client/src/dreaming.ts`. Capabilities (see `permissions.md`, "Dreaming"):

| Procedure | Capability | Notes |
| --- | --- | --- |
| `dream.status` | `chat` | the caller's mode, last run (time, status, counts, reason), whether a staged plan waits, whether an undo is available |
| `dream.mode` | `chat` | the caller's own mode only; a change re-syncs the person's `dream` built-in (`onModeChanged`); returns the status |
| `dream.now` | `chat` | the manual run; obeys `too-soon`; a run in mode `off` is `CONFLICT` with `data.reason` `off` |
| `dream.apply`, `dream.undo` | `chat` | the caller's own memory only; no step-up (the person's own file, as a memory write); `staged-changed`, `nothing-to-undo` as `CONFLICT` |
| `dream.diary` | `chat`; input `{ date?, personId? }` | no `personId`: the caller's own diary. With `personId` of another person: the owner only (checked in the handler), audited as `acl.owner-access` with kind `dream-diary`; a member asking for anyone else's diary gets `NOT_FOUND` (the owner's diary too) |
| `dream.settings.get` | `settings.read` | `{ maxUsdPerRun, memberDefault }` |
| `dream.settings.set` | `settings.manage`, step-up over TCP; the handler also requires the owner | partial change; writes one `settings.dreaming.set` row with `from` and `to`; then every person's `dream` built-in is re-synced |

A refusal of the service leaves as `CONFLICT` with `data.reason` (`DreamRefusalDataSchema`), and `DreamForbidden` as `FORBIDDEN`.

## Notify

`dream/notify.ts`. One message per staged run through the delivery service (`delivery.md`): `sendStagedNotice`, called by the service's
`propose` branch after the run row is `staged`. Source `dreaming`, name `dreaming.notice`, mode `note` (a stored message, no turn, no cost).
The text is fixed English with the run's counts (`candidates`, the changes to promote, merge and supersede, `dropped`) and the command
`Run /dream apply to write them.` It carries no candidate text, no entry text and no reason.

The request id is `dream-staged:<personId>:<day>:<fingerprint>`. The fingerprint is a SHA-256 prefix of the plan's shape: the sorted
`action|target` pairs, never a text. Delivery stores the id and sends nothing for a stored id (`delivery.md`), so a second staged run on the
same day with the same shape sends nothing more; the same shape on the next day, or another shape, sends its own. A failed delivery is
warned and the staged plan stays for `/dream apply`.

The other notices are one per run, with the run's id in the request id (`dream:<runId>:<kind>`, so a repeat sends nothing):
- `auto` (P35.6.1): a run that wrote or held units tells the person once, with counts: `Memory dreaming wrote N changes to your memory.`,
  and when units are held back `... and held M for review. Run /dream apply to write the held ones.`. A run that wrote nothing sends nothing.
- `budget`: a judge turn over the cap (`dreamBudgetTextOf(maxUsdPerRun)`).
- `failed`: a judge reply that is not a plan, a turn that failed, or an unexpected error (`DREAM_FAILED_TEXT`). No reason text, no model text.
All of them are `dreaming.notice` in mode `note` (a stored event, no turn). The TUI must render `dreaming.notice` for the person to see it.

**Visibility in the TUI (P35.6.3).** `dreaming.notice` events show in the chat as an info notice with their text (`message-text.ts`:
`dreamNoticeOf`). The text carries counts and `/dream` commands, never memory text. A run's `brain.hippocampus.dream` start and end
(`phase`, P35.6.3) show in the Brain panel: `dreaming…` from start to end, then `dream: n promoted, m merged`. The panel reads no count from the start. A run whose end never arrives (the core stopped mid-run) keeps the panel's `dreaming…` until the next
run ends or the TUI restarts; the row is also left open by the core's `running` run (Known limits).

**The chat.** The same start and end drive a line in the chat transcript, where `thinking…` shows: `dreaming · 12 s`, the seconds
counting up (`dreaming · reviewing N notes · 12 s`: N is the start's `candidates`, shown when it is above zero). The
input stays usable. The end replaces the line with one permanent divider, the words from the run's status: `dream finished · N reviewed ·
K changes waiting (/dream apply)` (staged; with ` · expires <date>` when the run's end time is known: its end + 7 days), `dream finished · N reviewed · K changes saved (/dream undo within 7 days)` (applied), `dream
finished · N reviewed · nothing to change` when K is 0, `dream failed · <reason>`, the skip sentence, `dream refused · <reason>` (also for a
`too-soon` or `off` refusal of `/dream now`, which writes no run row and no event), and `dream rejected · …`. K is promoted, merged and
superseded. A run that ends on the chat screen shows no toast: the divider says it. Home's caption reads `dreaming…` while a run runs.

**Causes in words (P35 debt 2).** The reason of a failed, refused or skipped run is said in plain English (`dream-state.ts`):
`judge` is "the model's plan was not valid", `turn-error` "the model turn failed", `interrupted` "the core stopped during the run",
`apply-partial` "the dream stopped while writing; /dream undo puts back what it changed",
`no-model` "no model for the cortex role", `budget` "over the budget", `budget-low` the skip sentence, `few-messages` "not enough new messages", `staged-changed` "Your memory changed after this plan was made, so the plan was dropped. The next dream plans again.".
A failed run whose row holds no reason (the unexpected-error path) reads "an unexpected error stopped the run"; a skipped run with no
reason reads "no new messages to review". The divider and the `/dream now` toast take the reason from the run row (`dream.status`); an
`end` that the status no longer shows takes its `status` and `reason` from the end event itself, so a failed run never reads as "nothing
to change". The `Skipped:` prefix of a skip toast stays.

## TUI

`apps/tui/src/features/memory/`. Commands in `tui.md` ("Commands and keys", ADR-0031 §5, §8): `/dream`, `/dream now`,
`/dream apply`, `/dream undo`, `/dream mode off|propose|auto`. The Me > Memory screen shows the mode, the last run and the latest diary day. A
staged plan shows its counts and the entries it would change, never the owner's other data. The owner's view of a member's diary is not in the TUI,
it is the audited RPC path.

Code: `features/memory/` (`dream-commands.ts`, `dream-state.ts`, `memory-screen.tsx`); the Memory row of Me is `tui.md` "Memory". The screen shows the latest diary day (the contract has no diary list), and a staged plan's entries are the lines of the diary of the day its run started.

## Audit

Rows hold counts, ids and codes only (rule 8). Written by `service.ts` through the audit service (`apps/core/src/modules/audit`):

- `dream.run` (actor `system`): `subject`, `mode`, `trigger`, `status`, `reason` (a refusal or failure reason, or null), and for a run that reached
  the applier the counts (`candidates`, `promoted`, `merged`, `superseded`, `dropped`) with `applied` and `staged`. `off` and `skipped` rows carry no
  counts.
- `dream.apply` (actor: the person): `subject`, `runId`, `applied` (units written).
- `dream.undo` (actor: the person): `subject`, `runId`, `restored` (files put back or removed).
- `dream.mode` (actor: the person): `subject`, `from`, `to`.

Event `brain.hippocampus.dream` (`activity.record`, to the person's current front session): a `start` and an `end` per run with a row (see Rule 8).
The counts and `applied`, no text. A refused run before its row sends no event. `service.test.ts` plants a string in the candidates and checks that no audit
row and no event holds it, and that no audit row holds the plan's reason.

## Invariants

- A run and a model call hold one principal (rule 1).
- The model never writes a file and never applies a plan (rules 5, 7).
- Nothing deletes a memory line: a contradiction is archived, a rewrite that drops more than 25 % is refused (rule 4).
- A staged plan and a preimage live outside `memory/<personId>/`.
- The cursor moves only after the apply or the staged write.

## Known limits

- **A waiting plan can be applied a little after its expiry.** The expiry the person sees (`stagedExpiresAt`, the divider's date, the status
  "expires in N days") is the purge horizon. The prune tick removes the staged file, so an apply between the expiry and the next tick still
  writes the plan; `apply` does not check the expiry.
- **A run that stopped while writing is not re-judged from its own messages.** A run that ends `apply-partial` leaves the cursor where the
  previous applied or staged run left it, so the next run collects the same messages again. Its entries that landed may come back as
  new ones. `/dream undo` first puts the partial write back; the next run then judges the same messages on the restored memory.

- **The judge with thinking off is not measured.** Thinking is off for the judge on DeepSeek (Judge, "Thinking"). Its quality against the thinking
  judge, and against a cheaper model (flash), is not measured. `bun run eval:dreaming` (real model, owner-paid) is the measurement.
- **The judge's budget reservation can refuse a chat turn near the cap.** The judge turn reserves `maxUsdPerRun` on the person's own budget
  scope while it runs (`budget.ts` counts reserved spend as used). Since P36 a run that would leave less than `budgetLowAt(maxUsdPerRun)` is
  skipped (`budget-low`) before it reserves anything, so a run no longer starts near the cap. A run that starts with room and whose judge turn
  then spends the rest can still hold a reservation during a chat turn; the size of that effect is not measured.
- **A send during `/new` or `/compact` is refused, not queued.** While a context change runs, the front session is busy: eharness refuses a
  send with `EH_SESSION_BUSY`, which the HTTP surface answers `409`. The message is not stored, so the client must keep the draft (the TUI does,
  per its own spec). `chat.context.pending` tells the person's feeds when the change starts and ends (`chat-context.md`, Activity).

## Deviations from the first design text

The code differs from the first design in these points. Each is also described where it applies.

1. **Removal keeps the rows in place.** `dream_settings` and `dream_runs` have no foreign key to `people`, so they stay in the database; the first text moved them into the kept folder, but nothing reads them from a folder. At purge the part deletes both tables' rows and the folder ("Retention and removal"). The export writes nothing: the diary is a memory file and is exported with the memory.
2. **Apply refuses the whole plan when a base file changed.** `DreamService.apply` checks the base of the staged plan before any write and refuses the whole plan with `staged-changed` ("Service"). The applier's own check is per unit: a unit whose file changed writes nothing and is staged ("Applier").
3. **`/dream now` calls the service directly.** `runNow(personId)` ("Rule 6") starts a run with trigger `manual`. It has no protocol run and no trigger ref: the protocol engine has no ref for a person's request, and `dream_runs` stores the trigger, not a ref.
4. **`manual:clock` does not move dream runs.** `bun run manual:clock <days>` moves the succession timestamps, not `dream_runs`. Scenario 30 of `docs/manual-testing.md` moves the runs back with a sqlite one-liner.
5. **The TUI shows the latest diary day.** The contract has no diary list: `dream.diary` takes one date or none, so Me > Memory shows the latest day ("TUI", "RPC").
6. **`dream.settings.get` and `dream.settings.set` exist.** The member default (`dreaming.memberDefault`) and the run cap are owner settings. `dream.mode` only changes the caller's own mode, so the settings are a separate pair of procedures ("RPC").
7. **The directive gate reads the source message and each sentence.** A judge that rewords an instruction (`Answers in French` for `Always answer in French`) is still refused, through its source message; the rule is per sentence ("Rule 4").
8. **The judge has more failure reasons.** A reply that is not a plan is `judge-output`, which ends the run `failed` with reason `judge`. A turn that throws or stops for another reason is `turn-error`, also `failed`. Neither is a refusal, and the reply text is never kept ("Judge"). The prompt lines also carry `sourceMessageId`.
9. **The `remember` phrases are English only.** Rule 4 names the owner's language set; the code reads the English phrases only, so a phrase in another language does not promote a fact.

## Tests

| File | Proves |
| --- | --- |
| `packages/contracts/src/dreaming.test.ts` | extra plan field refused; action outside the five refused; target with a separator refused; importance 0 and 11 refused; `maxUsdPerRun` 0.6 refused |
| `packages/contracts/src/protocols.test.ts` (extended) | `dream` built-in and `dreaming.run` parse |
| `packages/db/src/migration-0022.test.ts` | older rows unchanged, both tables empty after migrate, one row per person |
| `dream/files.test.ts`, `dream/entries.test.ts` | round trip; `..` or a separator in a topic name refused; the outside folder is not under `memory/` |
| `dream/undo.test.ts`, `dream/staged.test.ts` | exact bytes restored; created file deleted; a chat write after the run is kept and named, the other files restored; one preimage per file per run; `nothing-to-undo` after `undo_until`; staged plan survives a restart |
| `dream/collect.test.ts` | worker text, tool results, kind messages, wake turns, assistant turns with tool parts never collected; secret dropped and counted; cursor moves only when told |
| `dream/judge.test.ts`, `dream/prompt.test.ts` | the turn has one read-only tool; `judge-output` on an extra field; other-person and fetched-page text absent from the prompt; a drop with empty text and an empty plan are valid; thinking off per call on a DeepSeek model only |
| `providers/thinking.test.ts` | thinking disabled per call on DeepSeek for the no-thinking calls; a caller's own option kept; `auto`, a front call and other providers untouched |
| `dream/collect.test.ts` | the judge budget counts the rendered line: many short candidates stop at the budget too |
| `dream/apply.test.ts` | an unnamed candidate is dropped as `absent`; an empty plan drops all; an invented id still refused |
| `dream/service.test.ts` | a failed batch is retried once; the second failure skips it, advances the cursor and writes the `dropped.failed` diary line; a success resets the memory |
| `packages/db/src/repos/dreaming.test.ts` | a failed run moves the cursor only with a resume point; the batch is kept for one retry; a plain failure and a refusal leave the cursor alone |
| `dream/rules.test.ts`, `dream/apply.test.ts` | a table test: each rule of rule 4 has a passing and a refused case; a contradiction never deletes; `staged-changed` on a changed file |
| `dream/guard.test.ts` | 26 % of 20 entries refused; 25 % accepted; a dropped `Source:` refused at 0 %; fallback keeps every line |
| `dream/service.test.ts` (phase events) | the start carries the candidate count, read after the collect, before the judge |
| `dream/service.test.ts`, `dream/diary.test.ts` | `propose` writes the plan and no memory file; `auto` writes and keeps undo; audit rows hold no text; second `apply` no-op |
| `hypothalamus/dream-protocol.test.ts`, `authoring.test.ts` (row) | second sync writes nothing; `off` disables and keeps the row; `system` step in another protocol refused (`author-rule`) |
| `hypothalamus/dream-steps.test.ts` | 20-hour `too-soon`; 4 messages `few-messages` with no model call; crash between judge and apply leaves cursor and files unchanged; over-cap run refused with `budget` |
| `dream/flush-hook.test.ts` | mode `off`: no added line; `propose`: added line; a manual and a turn compaction get the same dreaming line; `manual` alone gets `onFailure: 'abort'`, automatic ones none; the merge; no other person's mode read |
| `dream/purge.test.ts`, `dream/removal.test.ts` | old file purged and audited `data.pruned`; kept folder moves; purge deletes both tables' rows for the person |
| `dream/procedures.test.ts`, `packages/client/src/dreaming.test.ts` | a member cannot read the owner's diary; the owner's read of a member's diary writes `acl.owner-access`; a member's `dream.mode` changes only their row |
| `dream/notify.test.ts` | one run, one message; no entry text in it |
| `apps/core/src/dreaming-leak.e2e.test.ts` | two persons with planted memory, messages, a web-page paste, a tool result, a worker report and a worker session text; `dream.now` in `auto` for each through the real judge turn (scripted model, every call captured per run); no string of one person in the other's calls or files; ana's worker text, report, tool result and fetched page in no call and no memory; bob's folder, rows and diary byte-equal after ana's run; run audit rows hold counts only (the detail's keys are the counted schema's); the judge's session is recorded under the person |
| `apps/core/evals/dreaming/` | eval scenario, offline (scripted); the real-model run is owner-paid |
| `apps/tui/src/memory.pty.test.ts` | a member's `/dream` shows `off`; `/dream mode propose` answers the toast and `/dream` then shows `propose`; the Me > Memory screen shows `Mode: propose` (real core, real TUI, no model call) |
| `scripts/smoke/dreaming.ts` (smoke block, `bun run smoke`) | a new member's five messages; `propose` run staged and no memory file changes; a second run refused `too-soon`; `apply` writes the key line with a `Source:` line and no secret in memory or diary; `undo` restores the folder bytes; `auto` writes without apply after the run times move back a day; audit holds `dream.run` rows and no text; ana's folder unchanged |

## Harness check

Recorded against eharness 0.12.0 (`.ref/eharness/docs/specs/`, and the installed `dist` declarations, `node_modules/.bun/eharness@0.12.0+*`).
Section numbers are of `.ref/eharness/docs/specs/`. Gap found: none. ADR-0011 is not triggered; nothing in eharness must change for this design.

1. **`compaction.before` hook merge (spec 06 §5.2a rule 2).** Hooks run in plugin order; their `flush` requests merge: prompts joined with a blank
   line, tool lists unioned (first appearance), `maxSteps` = the maximum (default 3), `model` = the last defined. The dreaming hook returns
   `{ flush: { prompt } }` only, so it adds one line to the memory plugin's prompt and no tool. A hook that throws or returns an invalid patch is
   skipped with `W_HOOK_FAILED` (rule 2), so the hook returns a valid patch and never throws. Answer: works as the design says.
2. **Flush without a visible message (spec 06 §5.2a rules 6, 7).** Flush messages are never saved, never added to the wire and never projected
   (rule 6). The one stored record is the `eh.flush` kind message (rule 7; spec 03 §5.3: role `assistant`, projection `omit`, carries `trigger`,
   `prompt`, `toolCalls`, `usage`, `costUsd?`, `error?`; no tool inputs or outputs). The collector excludes every kind message (Collect, role gate),
   so the record never becomes a candidate. A failing flush is reported (`W_HOOK_FAILED`, `phase: 'flush'`) and compaction continues (rule 9).
3. **Agent turn `billTo` and the budget config (spec 12 §4; `Principal` in the installed `dist` declarations).** eharness has no `billTo`. The
   `Principal` type is `{ id: string; name?: string; [key: string]: JSONValue | undefined }`, so Keith's `billTo` is an extra key that the
   turn carries unchanged; `billedPerson` (`budget/budget.ts`) reads it, and the judge turn passes `{ id: personId, billTo: personId }`. The budget
   is `budget: { maxTurnUsd }` (spec 12 §4; the `budget.config` of the front agent, `wernicke-broca/agent.ts`). It is checked after every step;
   a used-up turn stops with `cost-cap`; a step in flight is never cut, so the final cost may exceed the cap by one step (spec 12 §4). The
   design takes this one-step overrun as the bound of a run; `dreaming.maxUsdPerRun` is a cap, not an exact limit.
4. **Memory read tools for a judge turn (spec 14 §2, §3, §8, §9; `MEMORY_FLUSH_TOOLS` in `dist/memory/index.d.ts`).** The plugin always
   registers six tools unless the app passes `tool`. Mutations need a writable root; on a read-only root they answer `REJECTED: <path> is read-only.`
   (spec 14 §3). `MEMORY_FLUSH_TOOLS` (`memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`) is the flush request's list
   (§9), not the judge's, and it includes writes. Answer for the judge: an agent turn CAN get a read-only memory tool set. The judge's agent uses
   `memory({ roots: [{ path: '/', write: false }], tool: (execute) => tool({...}) })` (spec 14 §8; the root is the whole folder of the
   person, see "Judge"): one tool named `memory`,
   whose executor applies the same roots, so no write is possible. Its input is the `MemoryCommand` shape (spec 14 §2), validated by a zod schema
   of `ai`'s `tool()`; eharness imports no provider package. The agent also mounts `filesystem({ fs: diskFs(<the person's folder>), tools: [] })`,
   because `memory()` requires the `fs` service (spec 14 §1; spec 08, `tools` option, default all): `tools: []` exposes no file tool.
   Fallback not needed. The plan's fallback (plain prompt, memory text inline, no tools) is kept on record for the case that the `tool` option
   is refused at boot; it would lose the judge's own reads of the topic files and must then be recorded in `dreaming.md` Judge. The plan's Judge
   test ("exactly one tool, read-only") holds.
   Consequence for the composition: `hippocampus()` returns a writable root for the front agent, so `dream/judge.ts` composes its own
   `filesystem` and `memory` plugins and does not call `hippocampus()`.
5. **Message storage of worker reports and wake turns (spec 03 §3, §5; spec 05 §12; spec 20; `apps/core/src/modules/plugins/adapter.ts`).**
   - **Worker report.** The worker runs in a child session whose id contains `:agent:` (spec 20, child session; `front:<id>[:g<n>]:agent:<task>`).
     Its report reaches the lead as `ctx.session.inject('eh.event', { name: 'subagent', text, data })` (spec 20, the report event). That is a kind
     message: `role` user (spec 03 §5.3), one part `data-eh.event`, and `metadata.eharness.kind = 'eh.event'` (spec 03 §5.2). The worker's own
     messages are in the child session and never in the front session.
   - **Wake turn.** A wake item leaves no message of its own (spec 05 §12, the rule on `inboxDelivered`). Its turn kind (`TurnInfo.kind` = `'wake'`,
     spec 01 "TurnInfo") is live state, not stored: `HarnessMessageMeta` holds `turnId`, `kind` (kind messages only) and no turn kind (spec 03 §3).
     Keith's adapter reads `ctx.turn?.kind === 'wake'` only while the turn runs (`adapter.ts`, `sessionFactsOf`).
   - **Consequence for the role gate (answer to the plan's open verification).** The turn kind is not in the storage. The gate therefore uses
     structure: (a) every message with `metadata.eharness.kind` is excluded, which covers worker reports and all other kinds; (b) an assistant
     message whose `turnId` has no stored non-kind user message in the session is a wake turn or a continuation, and is excluded; this also
     excludes a `respond` continuation (AGENTS: the lead continues in a `respond` turn after delegating), which is the conservative side; (c) the
     worker session id (`:agent:`) is excluded. The rule (b) needs the turn's user message only, not the turn kind. Message ids are UUIDv7 and
     sort by creation time (spec 03 §3), so the cursor is an id.
   - No sequence column is needed for the cursor (`eh_messages` has none; ADR-0031 Context).

Gate of the collector: the collect test plants a worker report (kind), a wake reply (turn with no user message) and a tool-part assistant turn, and
asserts none is a candidate.
