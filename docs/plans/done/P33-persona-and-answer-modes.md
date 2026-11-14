# P33 — Persona and answer modes (prefrontal)

Nov 11, 2026 · status: **done (Nov 11, 2026)** · depends on: P27 (client capability registry, presence ports), P26 (migrations with backup, removal registry), P30 (room agent; phase 3 changes its system text) · ADR: 0029, 0020 §2, 0009, 0023 §5, 0026 · closes: ADR-0029 §1 to §9 · region: `prefrontal` (new, ADR-0004)

## Goal

Keith has a character the owner chooses and can edit: a built-in template (formal butler, casual friend, professional) becomes the persona, and every change is
versioned and audited. Each person may set a few style things about themselves (how to be addressed, language, brevity, formality, topics to treat gently).
Keith chooses how to deliver an answer from the channel it is talking through and the kind of request, never from the model's guess: on a speech channel an answer
is spoken in full sentences with no markup, long results go to a document with an offer, and reports lead with a one to three sentence conclusion. Keith never
says "according to my notes" or "as an AI assistant".

## Why

- ADR-0029 §1 separates persona (character, chosen by the owner) from mode (delivery shape, chosen in code). Without the split, a voice setting would
  become a length rule again, as `FRONT_INSTRUCTIONS` is today.
- ADR-0029 §2 and §3: a versioned persona is testable and auditable; a per-person layer that is structured and can never change rules is the only way to let
  people shape Keith without turning the prompt into a place where anyone's text can change Keith's rights.
- ADR-0020 §2 and §3: the persona is never a privacy boundary. The plan proves, in tests of every phase that touches a prompt, that one person's style and
  memory do not enter another person's context, and that a room context holds only the global persona and the speaker's address.
- ADR-0026: rooms stay on the global persona. This plan changes the room system text, so it comes after P30.
- P22 roadmap: this plan follows P30 and precedes P31. P31 reuses the client capability ids added here.

Evidence from the code (read before phase 3): `FRONT_INSTRUCTIONS` in `apps/core/src/modules/wernicke-broca/agent.ts` (around line 39: one fixed voice, "use
Markdown only when it helps"); the room system text in `apps/core/src/modules/corpus-callosum/agent.ts` (static, the number of people is in the room reminder,
so the prefix stays cacheable); `ANSWER_FAILED_NOTICE` in `apps/core/src/modules/corpus-callosum/turns.ts` and `GUEST_ERROR_TEXT` in
`apps/core/src/modules/thalamus/guest-scrub.ts` (the two fixed lines); the capability ids and the disclosure rule of `apps/core/src/modules/parietal/`
(`capabilities.ts`, `disclose.ts`, `client-route.ts`) and `packages/contracts/src/presence.ts` (the client capability ids `chat`, `notify`, `open.view`,
`location.share`); the settings repo pattern in `packages/db/src/repos/settings.ts`; the TUI Markdown rendering in `packages/ui/src/markdown.tsx` and
`packages/ui/src/rich-text.tsx`, used by `apps/tui/src/features/chat/message-list.tsx`. Step rows below cite these paths; a step that finds a different name follows
the code and records it in the spec.

Evidence from eharness 0.12.0 (`.ref/eharness/docs/specs/`, the volatile `step.prepare` reminder pattern of spec 05 and the one used by `roomContext` in P30):
the persona block can sit in the system prompt (static for every person) and the per-person style, the address and the mode can sit in the volatile reminder
(never stored, per turn). **No eharness gap blocks this plan**, so nothing goes upstream (ADR-0011). The check is recorded here; P33.3.1 repeats it against the
pinned version before the first prompt change.

## Scope

In:

- Persona document with versions, built-in templates, owner edit, owner restore of a version, global, owner step-up for changes.
- Per-person style settings (closed enums, a name, a closed topic list, a deny list of directive words) in the database, RPC and TUI.
- Prompt assembly: persona block (system prompt, static) and per-person block, address and mode (volatile reminder), in the front agent and the room agent.
- Fixed lines (`answerFailed`, `guestUnavailable`) from the persona.
- Client rendering ids `render.markdown` and `render.speech-only` in the P27 registry; mode choice in code; the speakable guard.
- Document hand-off: a long result is saved to the person's workspace and offered.
- Report mode for worker and protocol results (conclusion first).
- TUI: owner persona editor under Manage, `/persona` commands, a "Me" style screen; the TUI declares `render.markdown`.
- Audit kinds `persona.*`, removal registry for `person_style`, eval scenario `persona`, smoke block, docs.

Out:

- Audio and video synthesis, voice input, turn-taking by voice (the contract reserves `speech` and `render.speech-only`; nothing else).
- Web and mobile clients (the ids are ready for them).
- A persona per room, per channel, or per plugin: one persona for the core.
- Changing Keith's name or the core rules through any template or edit.
- Memory writes from the style layer: a style setting never goes into hippocampus, and memory never sets a style (ADR-0029 §3).
- Persona-based access decisions: a style never changes ACL, capabilities or budgets (ADR-0020 §2).

## Design

### Region and layers

New brain region `prefrontal` (ADR-0004; ADR-0029): `apps/core/src/modules/prefrontal/`. Its data is the global persona (the shared layer, ADR-0020 §1,
visible to everyone through its effect, readable by the owner and listed through `persona.get` for everyone who can chat) and the per-person style
(the person's own layer, readable and writable by that person, readable by the owner only through an audited read). Region events: `brain.prefrontal.change`
(persona version changed, global) and `brain.prefrontal.style` (a person's style changed; no values in the event, only the person id and the fields that changed).

### Data model (one additive migration, generated, backed up before it runs, ADR-0027 §3)

| Table | Columns | Notes |
| --- | --- | --- |
| `persona` | `id` (`keith`, single row), `version` (int), `template_id` (`butler`, `friend`, `professional`, or `custom` after an edit), `body` (JSON, validated by the zod schema), `updated_at`, `updated_by` | the current persona; one row, written in a transaction with a `persona_versions` row |
| `persona_versions` | `id` (UUIDv7), `version` (int, unique), `template_id`, `body` (JSON), `reason` (`template`, `edit`, `restore`), `changed_by`, `changed_at`, `note` (up to 200) | history; kept (owner history, not pruned) |
| `person_style` | `person_id` (PK, FK to the people table), `address` (1 to 40, the name Keith uses; default empty means "the name in the profile"), `language` (`auto` or a BCP 47 tag from a fixed list), `brevity` (`short`, `normal`, `full`), `formality` (`casual`, `neutral`, `formal`), `gentle_topics` (JSON array of enum values, up to 5), `updated_at`, `updated_by` | one row per person who set something; absent row means defaults |

The persona body (zod in `packages/contracts/src/persona.ts`): `tone` (text up to 300), `attitude` (text up to 300), `humour` (`none`, `dry`, `warm`), `addressing`
(text up to 200: how Keith refers to the owner by default), `caresAbout` (text up to 300), `lines` (`answerFailed` up to 120, `guestUnavailable` up to 120). The
core rules, the name "Keith" and the rules of rights are not fields.

Retention rows (`docs/specs/db.md`, P26.1.5 inventory): `persona` and `persona_versions` kept; `person_style` follows the removal registry (below).

### Templates (`modules/prefrontal/templates.ts`, data in code, versioned with Keith)

| Template | Character | Humour | Addressing (default) | Lines (`answerFailed`, `guestUnavailable`) |
| --- | --- | --- | --- | --- |
| `butler` | formal, composed, courteous, never rushed, a little dry | `dry` | by the name in the profile, with "sir" or "madam" only when the person's `formality` is `formal` | "I am afraid I could not answer that just now." / "I am unable to assist at present. Please try again shortly." |
| `friend` | casual, warm, quick, plain words, a friend's care | `warm` | by first name | "Sorry, that did not work. Try me again in a moment." / "I can't help right now, try again in a bit." |
| `professional` | neutral, concise, direct, no small talk | `none` | by the name in the profile | "I could not answer that just now." / "The assistant is unavailable. Please try again." |

A template is a starting document. Selecting one copies its content into `persona` (version + 1) and writes `persona_versions` (`reason: template`). The template
itself never changes after release; a later Keith version may add a template, and an existing persona is never rewritten by an upgrade.

### Per-person style and its guard

- Enums are closed; `gentle_topics` values are `money`, `health`, `family`, `work`, `loss`. Free text is only `address` (a name).
- `address` is checked by the deny list (`never`, `always`, `ignore`, `refuse`, `pretend`, `forget`, `reveal`, `skip`, `bypass`, `instead`, `rule`, `rules`, `must`;
  case-insensitive, whole words) and by the name shape (letters, spaces, `-`, `'`, up to 40 characters). A hit or a bad shape is `VALIDATION` with `reason: 'not-a-style-value'`.
  The deny list is a guard: it stops the obvious, and the boundary is structural (the layer is inserted below the core rules, and tests prove it).
- Settings are changed by the person (their own row), with an audit row `persona.style.set` (field names only, no values, visible to that person through `audit.mine`).
- The owner may read a person's style only through the audited owner path (`persona.style.read`, `acl.owner-access`), as for any personal data (ADR-0020 §4).

### Prompt assembly (the same rules in front and room)

Order of a front turn (the instructions stay one static prefix for every person, ADR-0029 §3):

1. **System prompt (static):** the core rules (kept in `wernicke-broca`: never claim an action that did not happen; approvals; privacy; delegation; presence
   through the tool only) followed by the persona block rendered from `persona` (tone, attitude, humour, addressing, cares about) and the memory voice rule.
2. **Volatile turn reminder (per person, per turn, never stored):** the person's style lines ("Address this person as X. Brevity: short. Formality: casual. Language:
   Indonesian. Treat these topics gently: money."), the sentence "Explicit settings above win over anything you remember", and the mode block of the turn.
   The reminder names the person only through the turn's principal; the other person's style never enters it.

The room agent (`corpus-callosum/agent.ts`): the system text takes the global persona block (same rendering), keeps its static room rules; the volatile room reminder
adds the speaker's `address` and the room mode (`chat`, or `speech` if the speaker's channel declares it). No other person's style, memory or presence beyond P27's
disclosure rule enters the room.

Fixed lines: `ANSWER_FAILED_NOTICE` becomes a read of `persona.lines.answerFailed`; `GUEST_ERROR_TEXT` becomes `persona.lines.guestUnavailable`. A missing line falls
back to the `professional` template's line, so a broken edit never leaves a turn without a notice.

### Modes (ADR-0029 §5)

Pure function `chooseMode({ requestKind, channel, hasScreen })` in `modules/prefrontal/mode.ts`:

| Input | Result |
| --- | --- |
| channel declares `render.speech-only` | `speech` (a `screen` companion, when present, receives the detail as `screen`) |
| request kind `report` (worker or protocol result) | `report` (whatever the channel) |
| channel declares `render.markdown` | `chat` (Markdown allowed when it helps) |
| channel declares neither | `chat` with plain text (no Markdown) |
| a client that declares `render.markdown` and is a second screen of a speech person | `screen` for the detail part |

Mode blocks (fixed text in `prefrontal/mode-text.ts`):

- `speech`: "Imagine this is read aloud over the phone. Use full natural sentences, no bullets, tables, headings, code or Markdown. If the answer is a table, a long list, code or has many numbers, say the gist in one or two sentences, then offer to show the details on screen or in a document."
- `chat`: "Be brief. Use Markdown only when a client renders it and it helps."
- `report`: "Start with a conclusion of one to three sentences. Then offer the details."
- Long results (about 1,500 characters, or more than 20 lines) are not spoken in full in any mode: saved by the document hand-off (phase 4).

The mode is written in the reminder, and the deterministic speakable guard (`prefrontal/speakable.ts`) flattens Markdown (tables become a sentence, bullets become a sentence list,
code becomes "a code block, offered on screen") whenever the mode is `speech`, so the output does not depend on the model following the instruction.

### Document hand-off (ADR-0029 §5)

The front agent has one more tool in the personal session: `document_save({ title, body })`. The body is written to the person's own workspace
(`<dataDir>/workspace/<personId>/documents/<date>-<slug>.md`, through the path resolver of `modules/cortex/workspace.ts`; the room workspace is never used by this tool),
and the result is the relative path. The reply offers it in one sentence ("I saved the full list as a document. Want me to send you the file name?"). The TUI
lists it in the file view. A document is owned by its writer; the owner reads it through the existing audited owner path. Rooms have no document tool.

### RPC, CLI, TUI

RPC (`packages/contracts/src/contract.ts`, handlers `modules/prefrontal/procedures.ts`): `persona.get` (any person who can chat; the template, the version and the
text), `persona.history` (owner), `persona.setTemplate({ templateId })` (owner, step-up), `persona.edit({ patch })` (owner, step-up), `persona.restore({ version })`
(owner, step-up), `persona.style.get` (the caller's own), `persona.style.set({ patch })` (the caller's own), `persona.style.read({ personId })` (owner, audited).
Errors: `FORBIDDEN` (`reason`: `not-owner`, `step-up-required`), `VALIDATION` (`reason`: `not-a-style-value`, `line-too-long`), `NOT_FOUND`.

CLI: `keith-core persona show`, `keith-core persona template <id> --yes`, `keith-core persona history` (offline-safe reads; the write goes through the running core and needs the owner's
PIN step-up, as in ADR-0008 and ADR-0009).

TUI (`apps/tui/src/features/persona/`): Manage gets a "Persona" section (owner): the current template, the text, the history, a template picker, an edit form for
each field (step-up dialog before save). `/persona` shows the current character to anyone; `/persona style` opens the person's "Me" style screen (address, language,
brevity, formality, topics as checkboxes). The TUI declares `render.markdown` on connect through the P27 client route; the Markdown block of `packages/ui` stays the renderer.

### Audit, removal, feed

Audit kinds: `persona.change` (version, reason, template id; the body is not in the audit row, the history is the record), `persona.restore`, `persona.style.set`
(field names only), `persona.style.read` (owner, with `acl.owner-access`). `persona.style.set` rows are visible to that person through `audit.mine` (the summary
registered by P23.2.3); the other kinds about the owner's global change are visible to members as "the owner changed Keith's persona" (no text).

Removal registry (P26.3.2, `onPersonRemoved`): `person_style` is kept on `keep`, included on `export` (the person's own style lines), and deleted on `purge`. The persona is
global and never removed with a person.

Activity feed: a persona change produces one `identity`-style record `persona.changed` (no text) so that open TUIs refetch. The feed rule of P27 applies (global record, no per-person text).

## Phases

### Phase 1 — Spec, contracts, templates, client ids

Goal: the design is a contract before any code reads it; templates and client ids exist as data.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P33.1.1 | Write the module spec: persona, templates, per-person style and its guard, modes, document hand-off, fixed lines, memory voice | `docs/specs/prefrontal.md` (new), `docs/specs/README.md` | prefrontal.md all sections; ADR-0029 cited per section | none (doc) | every rule of ADR-0029 has a section; no "Changes in P33" marker left for later steps except those in this plan |
| P33.1.2 | Contracts: persona body and version, template ids, style fields (closed enums, topic list), mode ids (`speech`, `chat`, `screen`, `report`), RPC inputs and outputs, `persona.changed` record | `packages/contracts/src/persona.ts`, `index.ts`, `contract.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`) | prefrontal.md "Contracts"; permissions.md (rows `persona.edit`, `persona.style.read`) | `persona.test.ts`: a valid body parses; `humour: 'loud'` is refused; a `gentle_topics` value outside the list is refused; the enum sets equal the spec table | contract tests pass; exports snapshot regenerated |
| P33.1.3 | Client capability ids `render.markdown` and `render.speech-only` added to the P27 registry; a client that declares neither gets plain text | `packages/contracts/src/presence.ts` (and its test), `modules/parietal/capabilities.ts`, `docs/specs/parietal.md`, `docs/specs/client.md` | parietal.md (registry table); client.md | `presence.test.ts` accepts both ids and refuses `render.table`; a client without render ids resolves to `chat` plain text in the mode test (P33.4.1) | tests pass |
| P33.1.4 | Built-in templates as data: `butler`, `friend`, `professional` with all fields, lines and the addressing rule; a `templateToBody()` copy function | `apps/core/src/modules/prefrontal/templates.ts`, `templates.test.ts` | prefrontal.md "Templates" | each template parses against the body schema; each line is non-empty and within 120 characters; no template text contains a claim of success for a failed action; copies do not share references (mutating a copy leaves the template unchanged) | tests pass |
| P33.1.5 | Name the region in the docs: `prefrontal` in the brain-region table; brain events `brain.prefrontal.change` and `.style` in the event list | `docs/ARCHITECTURE.md` (region table, one row), `docs/specs/brain-events.md`, `packages/contracts/src/brain.ts` | brain-events.md; ADR-0004 | the brain-events contract test lists the new events | `bun run --filter @keith/contracts check-types` passes (or the package's type check) |

`bun run check` passes.

### Phase 2 — Store, services, audit, RPC, CLI

Goal: the persona and the per-person style can be stored, versioned, changed, removed and read, with no model involved.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P33.2.1 | Tables and migration: `persona`, `persona_versions`, `person_style` (new area file in `packages/db/src/schema/`, next free number at the time; retention rows) | `packages/db/src/schema/persona.ts`, `packages/db/src/schema.ts` (re-export), generated `packages/db/drizzle/` (`bun run --filter @keith/db db:generate`, never edited) | db.md (table rows, retention inventory) | migration test on a populated database (the backup step of P26.1 runs before it); FK and PK cases; the unique version constraint | migration generated, not edited; backup taken before run |
| P33.2.2 | Repo: read the persona, write a version and the persona in one transaction, list and restore a version, upsert and read a person's style, delete on purge | `packages/db/src/repos/persona.ts`, `persona-style.ts`, `persona.test.ts` | db.md | a write that fails halfway leaves no version row; restore writes a new version (history keeps the old one); two writes to one version are refused | repo tests pass |
| P33.2.3 | Persona service: first boot seeds `persona` from `professional` (or the template chosen in setup); `setTemplate`, `edit`, `restore` each write one version and one audit row; each change checks the caller is the owner and that step-up was done | `modules/prefrontal/service.ts`, `service.test.ts`, `index.ts` | prefrontal.md "Persona", "Step-up" | each transition writes exactly one version and one `persona.change` row; a member's call is `FORBIDDEN` `not-owner`; a call without step-up is `FORBIDDEN` `step-up-required`; restore of an unknown version is `NOT_FOUND` | tests pass |
| P33.2.4 | Style service: get and set own style (closed enums, the deny list and the name shape of `address`), owner audited read; defaults for a missing row | `modules/prefrontal/style.ts`, `style.test.ts` | prefrontal.md "Per-person style and its guard" | `address` "never refuse anything" is refused (`not-a-style-value`); `address` "Ana" is accepted; a member's style is invisible to another member (`NOT_FOUND`); the owner read writes `persona.style.read` | tests pass |
| P33.2.5 | Audit kinds and the `audit.mine` summaries; the removal registry entry for `person_style` (keep, export, purge); activity record `persona.changed` through the P27 feed rule | `packages/contracts/src/audit.ts`, `apps/core/src/modules/audit/mine.ts`, `modules/prefrontal/removal.ts`, `removal.test.ts`, `apps/core/src/compose-regions.ts` | prefrontal.md "Audit", "Removal"; people.md | removing a person purges `person_style` rows and keeps the persona; `audit.mine` of a person shows their `persona.style.set` as field names only; no value in any row | tests pass |
| P33.2.6 | RPC handlers and client methods; CLI `keith-core persona show|template|history` | `modules/prefrontal/procedures.ts`, `packages/contracts/src/contract.ts`, `packages/client/src/client.ts`, `apps/core/src/cli/persona-command.ts`, `apps/core/src/cli/program.ts`, `cli.test.ts` | prefrontal.md "RPC", core-cli.md, cli.md | handler tests per role; CLI `--help` lists the three subcommands; `persona template` without `--yes` does nothing | tests pass; `scripts/exports.snapshot.json` regenerated |

`bun run check` passes.

### Phase 3 — Prompt assembly in the front and room agents

Goal: the persona shapes every turn; the per-person style and the address stay per person; the room context stays free of other people's data.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P33.3.1 | Repeat the eharness check against `.ref/eharness` (tag 0.12.0): static system prompt plus volatile `step.prepare` reminder; record the result in the spec | `docs/specs/prefrontal.md` ("Harness check"), `docs/specs/wernicke-broca.md` (one line) | prefrontal.md "Prompt assembly" | none (doc); a note in the spec names the spec numbers read | recorded in the spec; no gap (else ADR-0011 path, stop and report) |
| P33.3.2 | Persona block renderer (system prompt, static) and the per-person style lines renderer (volatile reminder); `FRONT_INSTRUCTIONS` splits into core rules (kept) and persona block (from `prefrontal`) | `modules/prefrontal/prompt.ts`, `prompt.test.ts`, `modules/wernicke-broca/agent.ts`, `agent.test.ts` | prefrontal.md "Prompt assembly"; wernicke-broca.md (instruction table) | the system prompt is identical for two different persons (no style in it); the core rules text is present verbatim; the style lines appear only in the reminder of that person's turn | tests pass |
| P33.3.3 | Room agent: the global persona block in the room system text (static part kept); the speaker's `address` and the room mode in the room reminder; no other person's style, memory or presence beyond P27's disclosure | `modules/corpus-callosum/agent.ts`, `agent.test.ts`, `context.ts` (the P30.3.2 reminder), `turns.ts` | corpus-callosum.md "The room agent"; prefrontal.md "Rooms" | the room system text equals the same text for every speaker; the reminder names only the speaker's address; a planted style value of member B never appears in the context of a turn for member A | tests pass |
| P33.3.4 | Fixed lines from the persona: `ANSWER_FAILED_NOTICE` and `GUEST_ERROR_TEXT` read `persona.lines`; a missing or broken line falls back to `professional` | `modules/corpus-callosum/turns.ts`, `modules/thalamus/guest-scrub.ts`, `modules/prefrontal/lines.ts`, `lines.test.ts` | prefrontal.md "Fixed lines"; guests.md | after a template switch the notice text is the new template's line; an empty stored line falls back; no line claims success | tests pass |
| P33.3.5 | **Context leak test (phase 3):** persons A and B each set a style and have a memory note with a planted string; both talk; every front and room model call is captured (system, reminder, messages) | `apps/core/src/prefrontal-leak.e2e.test.ts` (style of `rooms-leak.e2e.test.ts`) | ADR-0020 §2; ADR-0029 §3 and §4 | the planted style and memory strings of A never appear in B's captured calls and in any room call; the persona text appears in every call | test passes; listed in the spec's Tests |

`bun run check` passes.

### Phase 4 — Mode choice, speakable guard, document hand-off, report mode

Goal: the same answer is delivered in the right shape for the channel, decided in code.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P33.4.1 | `chooseMode` (pure) and the channel lookup through the P27 client route; mode block text in the reminder | `modules/prefrontal/mode.ts`, `mode-text.ts`, `mode.test.ts`, `modules/parietal/client-route.ts` (read only) | prefrontal.md "Modes" | the table of the Design section as cases: speech channel, report, markdown channel, no render ids (plain text), speech person with a screen | tests pass |
| P33.4.2 | Speakable guard: flatten tables, bullets, headings, code and emphasis in `speech` mode; a table becomes one spoken sentence with the count of rows; code becomes "a code block, offered on screen" | `modules/prefrontal/speakable.ts`, `speakable.test.ts`, `modules/wernicke-broca/index.ts` (the output hook) | prefrontal.md "Speakable guard" | a bullet list in a `speech` answer contains no bullet character; a table of 12 rows becomes a sentence with "12 rows"; a `chat` answer is unchanged | tests pass |
| P33.4.3 | Document hand-off: `document_save` tool in the personal session (the person's workspace only, `documents/`), reply offer; the room has no such tool | `modules/prefrontal/document-tool.ts`, `document-tool.test.ts`, `modules/cortex/workspace.ts` (read only), `modules/wernicke-broca/agent.ts` (plugin) | prefrontal.md "Document hand-off" | a result of 2,000 characters is saved under the caller's `documents/`; the path is never another person's or the room's; a symlink or `..` path is refused; the room agent tool list has no `document_save` | tests pass |
| P33.4.4 | Report mode for worker and protocol results: the report block and the conclusion-first rule; long report text goes to the document hand-off | `modules/cortex/` (report delivery, read only where it builds the wake text), `modules/prefrontal/report.ts`, `report.test.ts`, `modules/wernicke-broca/agent.ts` | prefrontal.md "Modes" | a worker report of 3,000 characters arrives as a wake with a conclusion, is saved, and the reply offers the file; a short report is not saved | tests pass |

`bun run check` passes.

### Phase 5 — TUI: persona editor, style screen, commands

Goal: the owner edits the persona and each person sets their style, from the terminal.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P33.5.1 | Client: persona and style methods, `persona.changed` refetch; the TUI declares `render.markdown` on connect | `packages/client/src/persona.ts`, `persona.test.ts`, `packages/client/src/client.ts`, `scripts/exports.snapshot.json` | client.md | the client calls the right RPC for each method; the connect call sends `render.markdown` | tests pass |
| P33.5.2 | TUI state: persona view state (template, text, history, dirty fields), style form state (enums, topics, address validation mirror of the server deny list) | `apps/tui/src/features/persona/{index.ts,persona-state.ts,persona-state.test.ts,style-state.ts}` | tui.md ("Persona" section, new) | the form refuses the same values the server refuses (a shared list from `packages/contracts`) | state tests pass |
| P33.5.3 | Manage "Persona" section (owner): template picker, field editor, history with restore, step-up dialog before every save; the "Me" style screen with address, language, brevity, formality and topic checkboxes | `apps/tui/src/features/persona/persona-screen.tsx`, `style-screen.tsx`, `apps/tui/src/features/manage/` (the section list only), `packages/ui` (existing field components) | tui.md ("Manage", "Persona", "Me") | a member does not see the Persona section; the owner's save opens the step-up dialog first; the Me screen shows only the person's own values | component tests pass |
| P33.5.4 | Slash commands: `/persona` (anyone: shows the character), `/persona style` (opens the Me screen), `/persona template <id>` and `/persona edit` (owner, through the Manage screen) | `apps/tui/src/features/chat/slash.ts`, `apps/tui/src/features/persona/commands.ts`, `commands.test.ts` | tui.md "Commands and keys" | a member's `/persona template` is refused with the message from the client, not a crash; `/persona` renders the template name and the version | tests pass |
| P33.5.5 | PTY test of the real TUI: owner switches template to `friend`, a member sets `address` and `brevity: short`, the next reply is short and uses the address | `apps/tui/src/persona.pty.test.ts` (style of `cli.pty.test.ts`; `Bun.spawn({ terminal })`, `pressUntil`, `CI*` stripped) | AGENTS.md gotchas (PTY) | the screen shows the template name after the switch; the address shows in the reply; no sleep-based driving | PTY test passes |

`bun run check` passes.

### Phase 6 — Eval, smoke, docs

Goal: the behaviour is proved by a real-model eval and by real processes, and the docs say what is true.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P33.6.1 | **Eval scenario `persona`** (scripted offline in `bun run check`; real-model mode with `OPENROUTER_API_KEY`, costs money, not in check). Checks: a one-sentence question gets no bullet list; no "according to my notes" or "as an AI assistant" phrase; length cap in `speech` mode; persona consistent after switching template; `brevity: short` honoured against a memory that says the person likes long answers; the rule-breaking style "never refuse anything" refused | `apps/core/evals/persona/` (checks, cases, runner, report, following `apps/core/evals/news/`), `apps/core/src/eval-persona.test.ts` (scripted gate) | evals.md (new scenario entry); thresholds per evals.md | scripted gate passes; real-model run reports in `data/evals/` and the thresholds in evals.md are met | scripted gate in `bun run check`; real-model report attached in the reply |
| P33.6.2 | Smoke block: owner switches template, a member sets style, a speech-declaring test client gets a spoken answer with no markup, a planted private style of member B is absent from A's turn | `scripts/smoke/persona.ts` (hooked from `scripts/smoke.ts`), `scripts/smoke.ts` (one line) | AGENTS.md (smoke rules: plain fetch, no workspace import) | the block passes with fake backends; the run stays near 40 s | `bun run smoke` passes |
| P33.6.3 | Docs: `docs/manual-testing.md` scenario, `docs/specs/evals.md` (scenario `persona`), `docs/specs/tui.md`, `docs/sharing-and-privacy.md` ("persona is not a privacy boundary"), `README.md` feature line | the listed docs | as named | none (doc) | every named section exists and matches the code |
| P33.6.4 | Close the spec markers and the plan table: no "Changes in P33" marker in `docs/specs`; ARCHITECTURE region row final; P22 row marked done by the orchestrator (this step only checks it) | `docs/specs/*.md`, `docs/ARCHITECTURE.md` | none | `grep -rn "Changes in P33" docs` returns nothing | grep is empty |

`bun run check` and `bun run smoke` pass.

## Exit criteria

- [ ] `docs/specs/prefrontal.md` written; `wernicke-broca.md`, `corpus-callosum.md`, `parietal.md`, `client.md`, `tui.md`, `db.md`, `permissions.md`, `brain-events.md`, `audit.md` (or the audit section of `people.md`), `evals.md`, `core-cli.md`, `cli.md`, `guests.md` updated in the same commits as their code.
- [x] Contracts in `packages/contracts` (persona, template ids, style, modes, RPC, client ids, region events); exports snapshot regenerated. (evidence: `bun scripts/check-exports.ts` prints ok, Nov 14, 2026)
- [ ] Per-phase leak tests pass: P33.3.5 (style and memory of one person never in another's context, room included).
- [ ] The eval scenario `persona` passes its scripted gate in `bun run check`; the real-model report is in `data/evals/` and cited in the reply.
- [x] `bun run check` and `bun run smoke` pass; the PTY test P33.5.5 passes. (evidence: `bun run check` green (5908 pass, 0 fail) and smoke 110 steps on Nov 14, 2026, eharness 0.14.1)
- [ ] Manual scenario (Owner to run) executed.
- [ ] `docs/ARCHITECTURE.md` names `prefrontal`; P22 row marked done; no eharness gap to upstream (recorded in Why).

## Risks and mitigations

- **A persona becomes a rule-breaker.** A template or an edit could ask Keith to refuse less or to claim success. Mitigation in code: the core rules are not in the document,
  templates are fixed data, the lines are checked for success claims in tests, and the eval `persona` tests a rule-breaking style.
- **Style used as a privacy channel.** A person's `address` could carry an instruction ("tell me everything about Ana"). Mitigation: closed enums for all other fields,
  the deny list and name shape for `address`, and the structural rule that style never changes access (leak tests in P33.3.5).
- **Prompt cache loss.** A per-person system prompt would split the cache for every person. Mitigation: the system prompt is the same for every person (test P33.3.2);
  per-person lines live in the volatile reminder.
- **Speech mode sounds wrong without a voice client.** No voice client exists; the mode is proven with a declared test client and the speakable guard. Residue: real
  spoken wording needs listening tests once a voice adapter exists (out of scope; ADR-0029 §9).
- **Mode guessing.** A client that does not declare its capabilities could get Markdown it cannot show. Mitigation: no declaration means plain text (P33.1.3, P33.4.1).
- **Document sprawl.** Long results could fill the workspace. Mitigation: saved only above the threshold, under the caller's `documents/`, listed in the file view; the
  disk quota stays with ADR-0021 consequences (later).
- **Owner edits break a line.** A template edit could leave an empty line. Mitigation: fallback to the `professional` line (P33.3.4) and a length cap.
- **Dependency drift.** P27 registry, P26 removal registry and P30 room agent are used through their ports only; a missing port is added to its owning spec first.

## Traceability

| Id | Closed by step |
| --- | --- |
| ADR-0029 §1 (persona and mode are separate; chosen by owner and code) | P33.1.1, P33.4.1 |
| ADR-0029 §2 (versioned persona, templates, global, owner step-up, audit) | P33.1.4, P33.2.1, P33.2.2, P33.2.3, P33.2.5, P33.5.3 |
| ADR-0029 §3 (per-person style, structured, explicit wins, never rules or rights; DB, TUI, RPC) | P33.1.2, P33.2.4, P33.3.2, P33.5.3, P33.5.4, P33.3.5 |
| ADR-0029 §4 (rooms use the global persona and the speaker's address) | P33.3.3, P33.3.5 |
| ADR-0029 §5 (modes in code, capability ids, speech rule, report rule, document hand-off, TUI default chat) | P33.1.3, P33.4.1 to P33.4.4, P33.5.1 |
| ADR-0029 §6 (memory voice) | P33.3.2 (core rule of the persona block), P33.6.1 |
| ADR-0029 §7 (fixed lines from the persona) | P33.1.4, P33.3.4 |
| ADR-0029 §8 (eval `persona`) | P33.6.1 |
| ADR-0029 §9 (out of scope: synthesis, web and mobile) | Scope "Out" |
| ADR-0020 §2 (no personal data in another context; persona not a boundary) | P33.3.3, P33.3.5, P33.6.2 |
| ADR-0009 (owner change needs step-up) | P33.2.3, P33.5.3 |
| ADR-0026 (rooms use only the global persona) | P33.3.3 |
| ADR-0023 §5 and P27 registry (client ids) | P33.1.3 |
| ADR-0004 (region name) | P33.1.5 |
| ADR-0027 §3 (migration backup and dry run) | P33.2.1 |
| Removal registry for `person_style` (ADR-0027 §26) | P33.2.5 |
| eharness per-turn prompt check (ADR-0011) | P33.3.1 |

## Gate evidence (Nov 11, 2026)

- `bun run check` green: Biome, tsc, 4482 tests (0 fail), check-imports, check-size, check-exports.
- `bun run smoke` SMOKE PASS, 86 steps (block `scripts/smoke/persona.ts`, 6 steps).
- Leak test `apps/core/src/prefrontal-leak.e2e.test.ts`; PTY test `apps/tui/src/persona.pty.test.ts`; eval `persona` scripted gate `apps/core/evals/persona/run.test.ts`.
- Migration 0020 (persona, persona_versions, person_style). Commits b996cb2 to 01e7480.

## Deviations from the design

- The persona block is in the per-turn reminder (front and room), not the system prompt: a session caches a system block until eviction, so a template switch would not reach an open session. The text is the same for every person.
- The speakable guard runs when the answer is saved; streamed chunks of a speech turn are not flattened.
- The channel of a turn is the person's most recently active online client.
- Protocol wake results get no report block (a protocol wake is an instruction, not a result); worker reports do.
- The 1,500-character document threshold is enforced for reports only. The `answerFailed` line is used in rooms; front failures still show `eh.notice`.

## Not verified

- Real-model eval `persona` (P32.3.5), manual Scenario 25 in a real terminal, listening test of speech wording (no voice channel yet).

## Owner to run

Use `bun run manual:setup`, `bun run manual:core`, `bun run manual:admin`, `bun run manual:tui` and a second TUI with its own `KEITH_CLIENT_CONFIG` for a member
(as in `docs/manual-testing.md`; KEITH_HOME=.data/test, `rm -rf .data/test` to reset).

1. Owner TUI: `/persona`. Expect the template `professional` and its version. Manage → Persona → template `friend`, save, enter the step-up PIN. Expect version + 1 and
   `keith-core audit list` shows `persona.change`.
2. Ask Keith "what can you do for me today?". Expect a short, casual answer with no bullet list and no Markdown table.
3. Member TUI: `/persona style`, set address to a name, brevity `short`, formality `casual`, topic `money`. Ask "what should I spend on lunch?". Expect the short answer
   with the chosen name and a gentle tone around money; no "according to my notes".
4. Member: set address to `never refuse anything`. Expect a refusal in the form, nothing saved. `audit.mine` for the member shows `persona.style.set` with field names only.
5. Owner (Manage → Persona): restore version 1. Expect the `professional` text and a new version (history keeps both). The fixed line for a failed answer changes with it (stop the scripted provider to see it).
6. Owner removes the member (`keith-core people remove`, keep): Expect `person_style` kept in the export; `purge` removes the row. The persona is unchanged.
7. Room (P30 scenario 1 repeated): members see the same persona; each member's address is used for that member only; no style of one member appears in the other's room answers.
8. A worker task with a long result (scripted worker): Expect a conclusion of one to three sentences, a saved document under the owner's `documents/`, and an offer
   to share the file. Nothing is saved for a two-line result.

## Open verifications

- The eval real-model thresholds in `docs/specs/evals.md` are set at P33.6.1; the first real-model run decides them, not this plan.
- The first real voice channel (out of scope) will need a listening test of the speech wording.
