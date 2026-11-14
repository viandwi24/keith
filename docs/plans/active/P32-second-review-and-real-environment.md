# P32 — Second review round and real-environment checks

Nov 10, 2026 · status: **in progress: phases 1 and 2 done, phase 3 waits for the owner** · depends on: P23 to P31 (phase 1 may start earlier and feed those plans; phase 3 needs the built features) · ADR: 0027 §1 (newest source wins), 0020 to 0026 · closes: doc gaps 10, 11, 12 (unread docs), REQ-117, REQ-154 (not traced), review items R6, R7, R13, the "not verified" lists of done plans P8 to P20, and every finding of the folded-domain review that no other plan owns; the second review round FD10-01..16 and FD11-01..11 (placed below)

## Goal

The roadmap P23 to P31 is checked twice more: once on paper, for the domains the first review folded away (CLI, db and scripts, logging, client state, evals), and once in the real world, for everything no test can show (a container, a LAN, a real terminal, a real database, a real model). The owner ends with a list of checks that each say how to run it, what to expect and who runs it.

## Why

- The flow review of Nov 9 mapped 239 entry points but cited about half of the folded domains (CLI, db, scripts, TUI client state, logging, evals). The verification pass found state-changing flows there with no review evidence (`docs/flow-review/2026-11-09-full/CONSISTENCY.md` section 4.1) and a second folder of results is being produced: `docs/flow-review/2026-11-10-folded/`.
- Doc gaps 10, 11 and 12 (manual-testing scenarios 11 to 16, the "Owner to run" lists of the done plans P1 to P20, the non-visual rules of `docs/specs/tui-design.md`) were skimmed, not read; their acceptance rules are not in any plan.
- REQ-117 (doctor checks that the owner can sign in) and REQ-154 (`web_search` works only with OpenRouter) were never traced.
- The done plans list what they did not verify (P8 container recipe, P10 / P13 / P20 real-terminal behaviour, P11 real-provider scenarios and an upgrade with a worker running, P14 LAN and Tailscale zones and the idle lock wait, P15 scenario 13, P16 migration on a real database copy, P17 real LAN Host header and guest model compliance, P18 remote latency, P19 / P20 Home motion). No plan owns them.
- The new features (P27 presence tool, P28 agenda extraction and proposals, P30 rooms and handoff, P31 computer use) are tested with scripted models only; real-model compliance is unproven.

## Scope

In:

- Phase 1: a second flow review of the folded domains and a residue review of the unread docs; every finding gets an owner plan.
- Phase 2: the fixes of findings that belong to no other plan.
- Phase 3: the real-environment check list, each with how to run it, the expected result and who runs it (the owner or Keith), plus the eval scenarios for real-model compliance.

Out (with where it goes):

| Item | Where |
| --- | --- |
| Fixing a finding that belongs to a domain of P23 to P31 | a step added to that plan (listed in the table of phase 1) |
| A web UI, TLS, mail or SMS recovery, TOTP, per-reminder time zones | ADR-0027 §29, not planned |
| Automating the real-environment checks in `bun run check` or `bun run smoke` | not planned: they need a machine, a network or a paid model (the laptop overheats; AGENTS.md memory) |

## Design

### Findings table (filled by the review)

Every finding of `docs/flow-review/2026-11-10-folded/` and of the residue review gets a row and an owner. The orchestrator fills the table; a row with no owner plan becomes a P32 phase 2 step.

| Finding id | Domain | Severity | Summary | Owner plan and step |
| --- | --- | --- | --- | --- |
| FD10-01 | CLI, TUI, client | Medium | A revoked, suspended or demoted client keeps a live activity feed | P23.1.10 (high priority, first of phase 1) |
| FD10-02 | CLI, TUI, client | Medium | Terminal escapes from device labels and guest text reach the owner's terminal | P23.1.11 (strip at render, label validation); P24.5.5 (guest peek) |
| FD10-03 | CLI, TUI, client | Low | Setup re-run resets or collides the owner's username through raw SQL | P24.4.5 |
| FD10-04 | CLI, TUI, client | Low | `budget set ""` sets the limit to 0; two parsers | P24.4.6 |
| FD10-05 | CLI, TUI, client | Low | `keith login --token` saves unchecked text over a good login | P23.1.12 |
| FD10-06 | CLI, TUI, client | Low | Text login says "Run keith" but the app ignores that login | P27.3.4 |
| FD10-07 | CLI, TUI, client | Low | `keith logout` says revoked after it could not revoke | P27.3.4 |
| FD10-08 | CLI, TUI, client | Low | A new sign-in overwrites `client.json` without revoking the old credential | P27.3.5 |
| FD10-09 | CLI, TUI, client | Low | Memory-only sign-ins leave long server sessions | P23.1.13 |
| FD10-10 | CLI, TUI, client | Low | `doctor` asks for the PIN | P23.4.5 |
| FD10-11 | CLI, TUI, client | Low | Console "Start core" skips the owner sign-in offer | P23.1.14 |
| FD10-12 | CLI, TUI, client | Low | Identity and Manage sections never refresh | P27.3.6 |
| FD10-13 | CLI, TUI, client | Low | CLI secret prompts trim; TUI does not | P23.1.15 |
| FD10-14 | CLI, TUI, client | Low | Sign-in controller stores the credential before the person is still there | P27.3.7 |
| FD10-15 | CLI, TUI, client | Low | `doctor` writes to the database and may create `secret.key` | P23.4.6 |
| FD10-16 | CLI, TUI, client | Low (question) | Should `people remove` and `transfer-owner` confirm? | P23.1.17 (yes; `--yes` skips) |
| FD11-01 | Persistence, logging | Medium | A database newer than the code is accepted | P26.1.6 |
| FD11-02 | Persistence, logging | Medium | `secureDataDir` walks and chmods the whole data folder | P26.1.7 |
| FD11-03 | Persistence, logging | Low | Tables with no retention | P26.5.1 (inventory P26.1.5) |
| FD11-04 | Persistence, logging | Medium | Removed-person purge covers conversation rows only | P26.3.5 |
| FD11-05 | Persistence, logging | Low | A username may shadow another person's phone alias | P23.1.16 |
| FD11-06 | Persistence, logging | Low | A crash leaves no log line; shutdown has no failure path | P24.7.8 |
| FD11-07 | Persistence, logging | Low | `eval:news` handles real data loosely | P26.5.3 |
| FD11-08 | Persistence, logging | Low | `scripts/manual.ts` runs every command under `--watch` (uncommitted) | not planned: owner's uncommitted work; residue row below |
| FD11-09 | Persistence, logging | Low (doc drift) | db.md lock order, eh-ext version, logging retry claim | fixed in docs, Nov 10 (comment of `eh-ext/src/index.ts`: P26.5.2) |
| FD11-10 | Persistence, logging | Low | Startup failures classified as "behind" or "not set up" | P26.1.6 |
| FD11-11 | Persistence, logging | Low (doc drift) | Stream log retention is lazy | wording fixed in docs, Nov 10; prune-tick sweep in P26.5.2 |
| FD12-01 | Client state, doctor | Medium | A Manage call that fails leaves the list stale until `r` (no refetch on error) | P32.2.1 (a), fixed in 9410574 |
| FD12-02 | Client state, doctor | Low | Two Enter keys in one burst send the chat answer twice (`chat-view.tsx`) | P32.2.1 (b), fixed in 284c8c2 |
| FD12-03 | Client state, doctor | Low | An older Manage read that settles late overwrites a newer one (`use-load.ts`) | P32.2.1 (c), fixed in a1493c1 |
| FD12-04 | Client state, doctor | Medium | Two Enter keys in one burst send two heir claims (`succession-panel.tsx`) | P32.2.1 (d), fixed in cb66647 |
| FD12-05 | Client state, doctor | Low | No test of a disabled OpenRouter connection or an unreadable key in the `web_search` gate (REQ-154) | P32.2.1 (e), fixed in d708441 (test only) |
| FD12-06 | Client state, doctor | Low | `setupCheck` (REQ-117) has no unit test; covered only through `setup-owner.test.ts` | P32.2.1 (f), fixed in d708441 (test only) |
| FD13-01 | CLI, node, scripts | Medium | `keith-node driver add <folder>` imports the folder's code before the owner confirms | P32.2.1 (g), fixed in d60db4e |
| FD13-02 | CLI, node, scripts | Medium | `people transfer-owner` accepts a target with sign-in off; the CLI cannot switch that sign-in back on | P32.2.1 (h), fixed in a54d70b |
| FD13-03 | CLI, node, scripts | Low | Setup display name is written with a raw repo call and no audit row | P32.2.1 (i), fixed in 239f1d1 |
| FD13-04 | CLI, node, scripts | Low | `keith-core plugin enable` and `disable` act at once; the TUI asks | fixed in 16d79a6 (asks first; `--yes` skips; no TTY refuses) |
| FD13-05 | CLI, node, scripts | Low | `scripts/manual.ts` (uncommitted) adds `--watch` to one-shot and destructive commands | owner (not planned) |
| FD13-06 | CLI, node, scripts | Low | `ref-sync` cannot update a tag moved upstream and does not pin the commit | fixed in f0dd607 and b8445ba (commit pinned in `scripts/ref-pin.json`; `-- --update` accepts a moved tag) |
| FD13-07 | CLI, node, scripts | Low | `plugin:db:generate` checks table names only one level deep (the runtime guard still refuses) | accepted, low |
| FD13-08 | CLI, node, scripts | Low | doctor `owner sign-in` counts stored secret kinds, not `can_login` (REQ-117) | P32.2.1 (j), fixed in 86fe312 |
| FD13-09 | CLI, node, scripts | Low | No confirmation on `groups delete`, `acl chown`, `rooms end` or `guests end` | fixed in 16d79a6 (same helper as FD13-04) |
| FD13-10 | CLI, node, scripts | Low | `scripts/manual-clock.ts` checks the lock by PID only and takes no lock | fixed in cad19d4 (takes `core.lock`; moves `dream_runs`) |

Verified resolved in code, no row needed (P32-1.1 section 3): FD10-10, FD10-11, FD10-15, FD10-16, FD11-01, FD11-02, FD11-04, F-027. FD13-10 is in the committed `scripts/manual-clock.ts`; FD13-05 is in the owner's uncommitted `scripts/manual.ts`.

### Review residue table (output of P32.1.2)

| Source | Acceptance rule not yet in a spec or a plan | Owner plan or finding id |
| --- | --- | --- |
| FD11-08 (second review round, `scripts/manual.ts` uncommitted work) | owner to check: `--watch` on one-shot commands in scripts/manual.ts | owner (not planned) |
| CONSISTENCY 4.1 (`ref-sync` verifies the commit hash of the tag it fetches) | owner decision, low: not planned in P22 to P31; P32.1.1 reviews `ref-sync` and may turn it into a finding | owner (not planned) |
| ADR-0024 §5 follow-up: the old `plg_reminders_fires` table stays unread after P28 phase 6 | dropping it is a later owner decision after one release (P22 "Not planned") | owner (not planned) |
| A1 | tui-design 5.16 caption (`home-host.tsx:163`) | With the core down, the failed-approvals line is not shown | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A2 | tui-design 5.16 caption (`home-screen.tsx:190`) | Caption order: alert, then first notice, then subtitle; never taller than 2 rows | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A3 | tui-design 5.16 room banner and heir line | The room banner takes the caption only when nothing else holds it and no turn runs | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A4 | tui-design 5.16 subtitle (`packages/ui/src/subtitle.tsx`) | Continued text keeps typing progress; other text restarts; catch-up above 60 characters behind runs above 90 per second | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A5 | tui-design 5.16 menu (`home-menu.tsx:34-43`) | A menu taller than the terminal scrolls to keep the selection visible | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A6 | tui-design 5.16 menu levels (`home-screen.tsx:222`) | Reopening the menu starts at the top level | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A7 | tui-design 5.16 quick ask | The quick ask line is at most 76 columns (`CAPTION_MAX`) | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A8 | tui-design 5.16 motion, cost | One frame clock per screen serves the orb, the brain frame and the subtitle | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| A9 | tui-design 5.16 idle hide (`home-screen.tsx:280`) | A wheel notch counts as activity and fades the hidden Home parts back in | owner to check by hand (P32.3.8) |
| A10 | tui-design 5.16 idle hide | Only Home hides; chat, Manage and dialogs keep their content after the idle time | resolved: tests in 24660a8, 6ce3227; defect fixed in e89f4f2, 0e38e7e |
| B1 | P18 "Not verified" line 91; manual scenario 16 | `useKeith().events` gets a feed-backed port, so a view and the activity feed agree. Code gap; no plan step owns it | resolved: bb341ce and 349cdf9 (feed-backed `events` with `onResync`) |
| B2 | P11 "Not verified" line 102; manual scenarios 6 and 7 | The shell approval, the denial and the node without `--allow-shell` run once with a real provider | P32.3.6 (extend the list to scenarios 6 and 7, owner by hand) |
| B3 | P6 "Real model: not run by the agent" line 29; manual scenarios 1 to 5, 8 to 10 | Chat, memory, fake-key refusal, budget and the real-model eval run once with a real key | owner to check by hand (rows in P32.3.6) |
| B4 | P16 "Unverified" (1) and (6); scenario 14 step 4 | A real front model keeps reminder text framed as data, not as an instruction. The tests assert the wrapped text only | owner check: a real-model case in the P32.3.5 run list |
| B5 | P13 "Not verified" line 117 | The sign-in screen draws and works in a real terminal against a real core | P32.3.3 (add the sign-in screen) |
| B6 | P18 "Not verified" (remote latency) | A plugin view stays usable over a slow link | resolved: c692603 (slow after 400 ms, timeout after 10 s, `r` retries) |
| B7 | P20 "Not verified" (last bullet) | `bun run smoke` is run after the P20 changes | resolved: smoke ran after P30, P33 and P31 (last run: 90 steps) |
| B8 | P20 "Not verified" (first bullet) | By eye: box fills, right-edge toast placement, sidebar below the prompt row, narrowest menu width, wide-mode orb flight | P32.3.3 (add the items) |
| B9 | P17 "Unverified" (5) | The guest screen works in a terminal with neither Kitty keyboard nor mouse | owner to check by hand (P32.3.2 or P32.3.3) |
| B10 | P17 "Unverified" (4) | The model provider's retention and process memory | owner decision: accept; the banner states it |
| B11 | P26 "Not verified" (remove and export a person; node rotation on a real node) | Removing and exporting a person, and rotating a node's credential, work on real data and a real node | P32.3.4 (add them to the drill) |

Rows that name P32.2.1 for a test (A1 to A8, A10) have no phase 2 row yet: P32.2.1 covers only findings a to j. The owner decides whether they become rows.

### Real-environment check shape

Each check in phase 3 is a row: `id`, what it proves, how to run it (commands from `docs/manual-testing.md`), the expected result, and who runs it. A check that fails becomes a finding row above and a step in the owning plan. A phase 3 row is a check, not a step: it has no Files or Tests column.

### Eval scenarios (extend `apps/core/evals/`, as `eval:news` does)

Four cases with a cost cap and a `--scripted` offline mode each, each built by the plan that owns the feature (scripts `eval:agenda`, `eval:presence`, `eval:room`, `eval:guest`): agenda extraction does not invent times (P28.5.6); the `presence` tool never reveals a note (P27.4.4); a room turn refuses another member's instruction (P30.3.8); a guest prompt does not leak the system text (P24.7.9). The acceptance threshold per scenario is written in `docs/specs/evals.md` (P24.7.6) and reports go to `data/evals/`. This plan builds none of them: phase 3 only runs the real-model mode.

## Phases

### Phase 1 — Second flow review of the folded domains

Goal: every state-changing flow of the folded domains has review evidence, and every finding has an owner.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P32.1.1 | Run the flow review (skill `flow-review`) over the folded entry points: `keith-core` console, home and manager (EP-181), `people`, `groups`, `acl`, `plugin`, `guests` and `reviews` CLIs (EP-191 to EP-196), admin shell session (EP-202), `doctor` (EP-184), the setup wizard against headless `setup-apply.ts`, `packages/cli` prompts, `keith-node setup` and `status` (EP-206, 207), migrations on a populated copy, retention jobs, `scripts/` (`manual.ts`, `smoke`, `ref-sync`, `plugin-db-generate`), logging (REQ-186, REQ-187, 14-day retention), `eval:news`; results in the folded folder | `docs/flow-review/2026-11-10-folded/` (gitignored, read only for this plan) | n/a | none (read-only review) | every listed entry point is cited by a verdict or marked out of scope with a reason |
| P32.1.2 | Residue review (doc gaps 10, 11, 12): read `docs/manual-testing.md` scenarios 11 to 16, the "Owner to run" lists of `docs/plans/done/P1`..`P20` and the non-visual rules of `docs/specs/tui-design.md` (Home and Orb); for each acceptance rule not already in a spec or a plan, add a row to the "Review residue" table above with the plan that will own it (or a finding id from F-057) | `docs/manual-testing.md`, `docs/plans/done/`, `docs/specs/tui-design.md`, this plan | n/a | none (read-only; produces a table) | the table exists, possibly empty |
| P32.1.3 | Trace the untraced requirements: REQ-117 (does `doctor` check that the owner can sign in? cite the check and its test, or add a finding) and REQ-154 (`web_search` is OpenRouter-only: cite `providers.md` and the code, or add a finding) | `apps/core/src/cli/doctor/checks/`, `apps/core/src/modules/providers/`, `docs/specs/providers.md` | providers.md, core-cli.md (doctor) | the cited or new test per id | each id has a file and a test, or a finding row |
| P32.1.4 | Client-state flows nobody reviewed: retry and continue after a dropped stream (chat send, retry, continue, interrupt; EP-211, EP-212) and the shared mutation rule of the Manage sections (in-flight guard against a double submit, one step-up replay, refetch after an error; EP-216); add a finding per defect | `apps/tui/src/features/chat/`, `apps/tui/src/features/manage/`, `packages/client/src/` | tui.md | a reproduction test per finding | findings recorded with evidence |
| P32.1.5 | Place every finding: add it as a step to the plan whose domain it belongs to (P23 to P31) with a Traceability row there, or leave it for phase 2; fill the findings table above | P23 to P31 plan files, this plan | n/a | none | every row of the findings table has an owner plan and step |

Phase gate: the findings table has no row without an owner.

### Phase 2 — Fixes that belong to no other plan

Goal: nothing the second review found is left without a fix.

| Step | Task | Files | Test | Done when | Commit |
| --- | --- | --- | --- | --- | --- |
| P32.2.1 a | Manage: a refused or conflicting mutation reads the list again (`section-host.tsx` catch branch); spec sentence in `tui.md` | `apps/tui/src/features/manage/section-host.tsx`, `docs/specs/tui.md` | `apps/tui/src/manage-actions.test.tsx`: a refused call reads the list again | the list is current after a failed call | 9410574 |
| P32.2.1 b | Chat answer key: the guard is a ref, so two Enter keys in one burst answer once (`answerWith`) | `apps/tui/src/features/chat/chat-view.tsx` | `apps/tui/src/features/chat/chat.test.tsx`: "two enters in one burst answer the question once, not twice" (two calls before the fix) | one `protocols/answer` call per burst | 284c8c2 |
| P32.2.1 c | Manage load: a sequence token, so an older read cannot overwrite a newer one or show its error | `apps/tui/src/features/manage/use-load.ts` | `apps/tui/src/features/manage/use-load.test.tsx`: two tests (both failed before the fix) | the newest read wins | a1493c1 |
| P32.2.1 d | Succession claim: a ref guard released in `finally`, so two Enter keys send one claim | `apps/tui/src/features/manage/succession/succession-panel.tsx` | `apps/tui/src/succession.test.tsx`: "two enters in one burst send one claim" (two calls before the fix) | one `admin/succession/claim` per burst | cb66647 |
| P32.2.1 e | Test only: a disabled OpenRouter connection is not offered `web_search` (REQ-154) | none (test only) | `apps/core/src/modules/cortex/cortex.test.ts` (13 lines changed) | the gap is covered by a passing test | d708441 |
| P32.2.1 f | Test only: unit tests of `setupCheck` (REQ-117) | none (test only) | `apps/core/src/cli/doctor/checks/setup.test.ts` (new, 92 lines) | the check is covered beyond the CLI test | d708441 |
| P32.2.1 g | `driver add` reads the manifest without importing; the entry is imported only after the owner confirms | `apps/node/src/driver-command.ts`, `packages/driver-sdk/src/load.ts`, `packages/driver-sdk/src/index.ts`, `docs/specs/node-drivers.md`, `docs/specs/node.md`, `scripts/exports.snapshot.json` | `apps/node/src/driver-command.test.ts`, `packages/driver-sdk/src/load.test.ts` | the module does not run before the owner answers yes | d60db4e |
| P32.2.1 h | `transfer-owner` applies the same `canLogin` check as `succeed` | `apps/core/src/modules/people/people.ts`, `docs/specs/people.md`, `docs/specs/core-cli.md` | `apps/core/src/modules/people/people-guard.test.ts` (16 lines added: transfer to a sign-in-off member is refused) | a sign-in-off member cannot become owner | a54d70b |
| P32.2.1 i | Setup display name goes through the people service, with its audit row | `apps/core/src/cli/setup-steps.ts`, `apps/core/src/cli/setup-apply.ts`, `apps/core/src/cli/setup.ts`, `docs/specs/core-cli.md` | `apps/core/src/cli/setup-owner.test.ts` (14 lines added) | a display-name change writes an audit row | 239f1d1 |
| P32.2.1 j | `doctor` owner sign-in fails when `can_login` is off (REQ-117) | `apps/core/src/cli/doctor/checks/setup.ts`, `docs/specs/core-cli.md` | `apps/core/src/cli/setup-owner.test.ts` (22 lines added) | a sign-in-off owner reads as a failure with the hint | 86fe312 |

`bun run check` passes; phases that touch processes also run `bun run smoke`.

### Phase 3 — Real-environment checks

Goal: everything no test can show is run once on real things, with the result recorded.

| Step | Check and how to run it | Expected result | Who runs it | Status |
| --- | --- | --- | --- | --- |
| P32.3.1 | **Container recipe** (`docs/deploy/container/README.md`, marked untested in P8): `docker build` from `docs/deploy/container/Dockerfile`, `docker compose up`, run `keith-core setup`, sign in by device code from the host, then `keith-core backup`, `keith-core restore` into a fresh volume (P26) | the core boots, the TUI connects from the host, the backup restores with the same people, notes and chats | Keith writes the commands, the owner runs them (needs Docker) | pending (owner) |
| P32.3.2 | **LAN and Tailscale zones**: on a second device on the LAN and one on Tailscale, PIN sign-in, PIN step-up (P23.1.3), the guest URL and Host header (P17), `guests.trustedProxy` behind a real reverse proxy (P24.5.4), the 15-minute idle lock wait, `os.networkInterfaces()` and the real peer address (P14) | each zone allows and refuses exactly what `docs/specs/auth.md` says; guests behind the proxy get separate windows | the owner (needs two devices and a network) | pending (owner) |
| P32.3.3 | **Real terminal rendering** (the P10, P13, P20 not-verified lists): the setup wizard, the console, the sign-in screen, Home fades and menu, the toast on a short terminal, the orb frame rate and CPU over 30 minutes, and the new panels of P27 (presence), P28 (protocols), P29 (succession), P30 (room view) in iTerm, Terminal.app and a tmux pane at 80 and 120 columns; plus the P20 by-eye items (box fills, right-edge toast, sidebar below the prompt row, narrowest menu width, wide-mode orb flight) | no clipped rows, no flicker, the orb stays under the CPU limit in `tui-design.md`, offline hints read correctly | the owner by eye; Keith records the result | pending (owner) |
| P32.3.4 | **Upgrade drill on a copy of the real database** (P11, P16, P26): copy `~/.keith` aside, check out the previous tag, run it, create a worker and a pending approval, stop, check out this build, `keith-core start` on the copy; plus `people export` and `people remove` on the copy and node credential rotation on a real node (residue B11) | the backup is written first, every migration applies, the worker is repaired at boot, the pending approval is still pending, nothing in the real folder changed | the owner (the data is theirs); Keith supplies the steps | pending (owner) |
| P32.3.5 | **Real-model evals of the new features** (the real-model run only; the scenarios and their `--scripted` mode are built and tested in P24.7.9, P27.4.4, P28.5.6 and P30.3.8): `bun run eval:agenda`, `bun run eval:presence`, `bun run eval:room`, `bun run eval:guest`, `bun run eval:persona` with `OPENROUTER_API_KEY` and the cost cap; plus the owner check of reminder text as data (residue B4) | each scenario meets the threshold in `docs/specs/evals.md`; the report lands in `data/evals/` | the owner runs the paid run (it costs money); Keith confirms first that `--scripted` is green in `bun run check` | pending (owner) |
| P32.3.6 | **manual-testing.md scenarios 11 to 16** (two people, sign-in and local socket, groups and audited look, Notes and Reminders, guest on the LAN, plugin views) against the current build, plus the scenarios added by P23 to P31 (18 to 28) and scenarios 1 to 10 with a real key (residue B2, B3) | every "Expected" line holds | the owner (Keith may drive the TUI with `Bun.spawn({ terminal })` for the scripted parts) | pending (owner) |
| P32.3.7 | **Done plans' "Not verified" lists**: P8 container (3.1), P10 and P13 wizard and console in a real terminal (3.3), P11 scenarios 6, 7, 11 with a real provider and a worker across an upgrade (3.4, 3.5), P12 and P20 orb and toast (3.3), P14 (3.2), P15 scenario 13 (TUI Groups, end-to-end owner path), P16 front-model compliance with "reminder text is data" and the real-database migration (3.4, 3.5), P17 (3.2, 3.5), P18 `useKeith().events` feed port (residue B1, owner decision), terminal rendering and remote latency, P19 and P20 Home motion and menu (3.3) | each list item is ticked or turned into a finding row | the owner; Keith keeps the tick list (see the Phase 3 run sheet) | pending (owner) |
| P32.3.8 | **tui-design.md rules by eye**: the Home and Orb non-visual rules read in P32.1.2, plus every rule of sections 4 to 6 that a snapshot test cannot check (spacing, glyph fallback, key hints) | no rule is broken in the real terminal of 3.3 | the owner by eye | pending (owner) |

### Phase 3 run sheet

Run from the repo root unless a row says otherwise. The owner fills the last column: date, who, and `ok` or a finding id. Use a scratch data folder (`KEITH_HOME=.data/test`, `bun run manual:*`) for every check except 3.4, which copies the real folder first. Never type a real key into a file: use `read -rs` as in manual-testing scenario 9. The `--scripted` runs are offline and free; Keith may run them. The paid runs are the owner's.

| Id | Commands | Expected result | Who runs it | Result (date, who, ok / finding id) |
| --- | --- | --- | --- | --- |
| 3.1 | `docker build -f docs/deploy/container/Dockerfile -t keith-core:p32 .`<br>`cd docs/deploy/container && docker compose up -d`<br>`docker compose exec keith-core bun apps/core/src/cli.ts doctor`<br>host: `keith login --core <public url>`, then in the container `docker compose exec keith-core bun apps/core/src/cli.ts devices approve <code>`<br>`docker compose exec keith-core bun apps/core/src/cli.ts backup`<br>stop the service, copy the archive off the machine, start a fresh volume, stop core, `docker compose run --rm keith-core bun apps/core/src/cli.ts restore <archive>` (add `--force` only if the first start already made a database on the fresh volume) | the image builds; `doctor` shows `✓ owner sign-in`; the host login completes and the TUI connects; after restore, the same people, notes and chats are listed; `restore` prints `run keith-core doctor, then keith-core start` | the owner (needs Docker); Keith wrote the commands | _pending (owner)_ |
| 3.2 | `bun -e "console.log(require('os').networkInterfaces())"` (LAN and Tailscale addresses)<br>manual-testing scenario 12 (line 684): identifier-first sign-in, PIN, sessions, local socket, on the second device over `http://<LAN address>:7420` and `http://<tailscale address>:7420`<br>scenario 15 (line 813): guest on the LAN, public URL and Host header<br>`curl -H "Host: <KEITH_PUBLIC_URL host>" http://<LAN address>:7420/health` (a wrong Host gives 421)<br>leave the second device's TUI idle for 15 minutes: the lock appears<br>behind a reverse proxy: `guests.trustedProxy` (P24.5.4) | each zone allows and refuses what `docs/specs/auth.md` says; the wrong Host gives 421; guests behind the proxy get separate windows; the idle lock comes after 15 minutes | the owner (needs two devices and a network) | _pending (owner)_ |
| 3.3 | `bun run manual:setup` (wizard; Shift+Tab or Ctrl+B back, Esc cancels)<br>`bun run manual:core` in one tab, `bun run manual:tui` in another: the console, the sign-in screen (residue B5), Home (scenarios 0, line 250; 0a, line 290), the orb (scenario 17, line 875)<br>panels: scenario 21 (presence, line 993), 22 (protocols, line 1095), 23 (succession, line 1110), 24 (room, line 1127)<br>terminals: iTerm, Terminal.app, `tmux new -s p32 -x 80 -y 24` and `-x 120`; short terminal: `tmux resize-window -t p32 -y 12` for the toast<br>orb CPU, once for 30 minutes: `top -pid <tui pid>`<br>by eye (residue B8): box fills, right-edge toast, sidebar below the prompt row on a tall terminal, narrowest menu width, wide-mode orb flight | no clipped rows, no flicker, the orb stays under the CPU limit in `docs/specs/tui-design.md`, offline hints read correctly, each panel draws at 80 and 120 columns | the owner by eye; Keith records the result | _pending (owner)_ |
| 3.4 | `cp -R ~/.keith <copy>` (copy first; never run a command against the real folder)<br>`git worktree add <dir> <previous tag>` (a worktree keeps the owner's uncommitted edits untouched; do not `git checkout` in this repo)<br>previous build: `KEITH_HOME=<copy> bun <dir>/apps/core/src/cli.ts start`; in the TUI create a worker and a pending approval (scenario 6, line 481); stop core<br>`shasum -a 256 ~/.keith/keith.db` before and after<br>this build: `KEITH_HOME=<copy> bun apps/core/src/cli.ts doctor`, then `KEITH_HOME=<copy> bun apps/core/src/cli.ts start`<br>`KEITH_HOME=<copy> bun apps/core/src/cli.ts people export <username> --out <file>`, then `people remove <username>` on the copy (confirm or `--yes`)<br>node credential rotation on a real node, as in `docs/specs/node.md` | a backup file is written before the first migration (`backups/keith-<timestamp>.db`); every migration applies; the worker is repaired at boot; the pending approval is still pending; export writes the archive; a removed person's data stays in `workspace/keith/removed/<id>` until `keptUntil`; the real folder's checksum is unchanged | the owner (the data is theirs); Keith supplies the steps | _pending (owner)_ |
| 3.5 | Offline first (Keith may run): `bun run eval:agenda -- --scripted`, `bun run eval:presence -- --scripted`, `bun run eval:room -- --scripted`, `bun run eval:guest -- --scripted`, `bun run eval:persona -- --scripted`, `bun run eval:dreaming -- --scripted` (all six ran offline on Nov 12, 2026 by Keith: pass, 0 failures)<br>paid, once per scenario: `read -rs "OR_KEY?OpenRouter key: "; echo` then `OPENROUTER_API_KEY="$OR_KEY" bun run eval:agenda -- --max-usd 0.50` (same for `eval:dreaming`, `eval:presence`, `eval:room`, `eval:guest`, `eval:persona`); `unset OR_KEY`<br>owner check (residue B4): manual-testing scenario 14 step 4 (line 775) with a real front model: a reminder whose text gives an instruction | each `--scripted` run exits 0; each paid run exits 0 and meets its threshold in `docs/specs/evals.md` (zero invented times, zero undisclosed notes, zero actions on another member's instruction, zero leaked markers); the persona threshold is set from this first real run and written into `evals.md`; owner check B4: the model treats the reminder text as data; reports in `<KEITH_DATA_DIR>/evals/` (`<name>-<time>.json`, 0600) | the owner runs the paid run (it costs money; default cap, see `evals.md`); Keith confirms `--scripted` green in `bun run check` first | _pending (owner)_ |
| 3.6 | `bun run manual:setup`, `manual:core`, `manual:tui`, `manual:node`, `manual:admin <command>`; reset between runs with `rm -rf .data/test` (manual-testing section 3)<br>scenarios 6 (line 481) and 7 (line 518) with a real provider; scenarios 1 to 5 (lines 345, 366, 393, 421, 451), 8 (549), 9 (575, `bun run eval:news`) and 10 (612) with a real key (residue B3)<br>scenarios 11 (644), 12 (684), 13 (745), 14 (775), 15 (813), 16 (847)<br>scenarios 18 (890), 19 (928), 20 (964), 21 (993), 22 (1095), 23 (1110), 24 (1127), 25 persona (1148), 26 desktop driver (1191), 27 sandbox (1251), 28 client notifications (1288), 29 context reset and compaction (1320), 30 dreaming (1364), 31 activity logs (1411), 32 where am I (1429, steps 1 to 5 need a real model) | every "Expected" line in those scenarios holds; each deviation is a finding row | the owner; Keith may drive the TUI with `Bun.spawn({ terminal })` for the scripted parts (never `expect … sleep`) | _pending (owner)_ |
| 3.7 | the tick list below; each item's check is in its row | every box ticked or turned into a finding row | the owner; Keith keeps the tick list | _pending (owner)_ |
| 3.8 | `bun run manual:tui`; Home per scenario 0 (line 250) and 0a (line 290); `grep -n '^## ' docs/specs/tui-design.md` for sections 4 to 6, read by eye<br>glyph fallback: `LANG=C bun run manual:tui`; key hints on screen<br>residue A9: a wheel notch on a hidden Home | no rule of sections 4 to 6 is broken in the real terminal of 3.3 | the owner by eye | _pending (owner)_ |

### Phase 3 tick list (P32.3.7, from the residue review)

Each line is a "Not verified" item of a done plan, with the check that maps it. Tick it when the check passes, or turn it into a finding row.

- [ ] P8 container recipe boots (`docs/deploy/container` untested) → 3.1
- [ ] P9 manual scenario 11 written from the CLI source, not run by hand → 3.6
- [ ] P10 wizard and console in a real terminal → 3.3
- [ ] P10 member with extra capabilities does not see the section → resolved in P10, no check
- [ ] P11 scenarios 6 and 7 with a real provider → 3.6 (residue B2)
- [ ] P11 scenario 11 with a real provider → 3.6
- [ ] P11 database upgrade with a worker running → 3.4
- [ ] P12 orb frame rate and CPU over a long session → 3.3
- [ ] P12 real-terminal capture of "M5" (owner to say what M5 is) → 3.3
- [ ] P13 sign-in screen on a real terminal against a real core → 3.3 (residue B5)
- [ ] P14 `os.networkInterfaces()` and the real LAN peer address on a phone → 3.2
- [ ] P14 LAN warning and PIN on a real LAN, the Tailscale zone, the public URL → 3.2
- [ ] P14 real 15-minute idle-lock wait → 3.2
- [ ] P14 unlock and socket sign-in panels in a real pty against a real core → 3.6 (scenario 12)
- [ ] P15 scenario 13 not run by an agent → 3.6
- [ ] P15 TUI Groups driven only against the fake core → 3.6 (scenario 13)
- [ ] P16 real front model compliance with "reminder text is data" → 3.5 (residue B4)
- [ ] P16 no sentinel check of real model output → 3.5 (residue B4)
- [ ] P16 migration on a copy of the real database → 3.4
- [ ] P16 LAN behaviours (second machine, public route) → 3.2
- [ ] P16 TUI sections driven against the fake core → 3.6 (scenario 14)
- [ ] P17 real LAN client and its Host header → 3.2
- [ ] P17 Tailscale peers and a public `https:` route → 3.2
- [ ] P17 real guest model compliance and cost → 3.5 (`eval:guest`)
- [ ] P17 model provider's retention → none (residue B10, accepted by owner decision)
- [ ] P17 terminal without Kitty keyboard or mouse → 3.2 or 3.3 (residue B9)
- [ ] P17 manual scenario 15 → 3.6 and 3.2
- [ ] P18 plugin view rendering in real terminals (colours, resize, flicker) → 3.6 (scenario 16)
- [x] P18 remote latency over a slow link → resolved in c692603 (slow state, timeout, retry); the real slow link is by eye in 3.6 scenario 16
- [ ] P18 trust in third-party plugins → out of any check (design limit)
- [x] P18 `useKeith().events` feed-backed port → resolved in bb341ce and 349cdf9
- [ ] P18 manual scenario 16 steps 1 to 7 → 3.6
- [ ] P19 scenario 0a, the fades by eye on a real terminal → 3.3
- [ ] P20 box fills, right-edge toast, sidebar below the prompt row, narrowest menu width, wide-mode orb flight → 3.3 (residue B8)
- [ ] P20 toast on a very short terminal → 3.3
- [x] P20 `bun run smoke` after the changes → resolved (smoke ran after P30, P33 and P31; residue B7)
- [ ] P20 owner list (manual:tui, core restart, sign-in toast, `/logout`, menu levels, orb start) → 3.3
- [ ] P33 persona and answer modes with a real model (`eval:persona`, scenario 25) → 3.5, 3.6
- [ ] P34 `/new` and `/compact` against a real summarizer call (scenario 29) → 3.6
- [ ] P35 dreaming run with a real judge model and the 03:00 protocol (scenario 30, `eval:dreaming`) → 3.5, 3.6
- [ ] P36 activity logs on a real turn (scenario 31) → 3.6
- [ ] ADR-0033 "where am I" with a real model on a laptop (scenario 32 steps 1 to 2) → 3.6

Phase gate: every check has a recorded result (date, who, ok or finding id).

## Exit criteria

- [x] `docs/flow-review/2026-11-10-folded/` is cited by P32.1.1; the findings table has no row without an owner plan and step.
- [x] The "Review residue" table exists (possibly empty).
- [x] REQ-117 and REQ-154 are traced to a file and a test or to a finding.
- [ ] The four eval scenarios exist (built by P24.7.9, P27.4.4, P28.5.6, P30.3.8) with a `--scripted` mode and thresholds in `docs/specs/evals.md`; their real-model run is recorded here (P32.3.5).
- [ ] Every check of phase 3 has a result recorded in this plan (date, who, ok or finding id).
- [ ] `bun run check` passes after phase 2; the P22 roadmap row is marked done.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| The review keeps finding things (no end) | The review has a fixed entry point list (P32.1.1); a new finding is placed once; the plan ends when the table has no unowned row |
| The paid eval run costs money | A cost cap per scenario and a `--scripted` offline mode; the owner decides when to run the paid run |
| The container and real-network checks need hardware Keith does not have | The commands are written by Keith, the owner runs them; each check names who runs it |
| Real-terminal checks drive the laptop hot | 30-minute orb check only once; no loops; processes cleaned up after (AGENTS.md memory) |

## Traceability

| Id | Closed by step |
| --- | --- |
| Doc gaps 10, 11, 12 (unread docs) | P32.1.2, P32.3.6, P32.3.8 |
| REQ-117, REQ-154 (not traced) | P32.1.3: REQ-117 in `apps/core/src/cli/doctor/checks/setup.ts`, test `apps/core/src/cli/setup-owner.test.ts`; REQ-154 code in `apps/core/src/modules/cortex/` (`web-search.ts`, `search-gate.ts`), tests `apps/core/src/modules/providers/service.test.ts` and `apps/core/src/modules/cortex/cortex.test.ts` |
| Review R6, R7 (client-state flows) | P32.1.4 |
| Review R13 (evals for the new risks) | P24.7.9, P27.4.4, P28.5.6, P30.3.8 (build, `--scripted`), P32.3.5 (real-model run) |
| Done plans' "Not verified" lists (P8 to P20) | P32.3.1 to P32.3.8 (P32.3.7 maps each) |
| Folded-domain review findings | P32.1.1, P32.1.5, P32.2.1 |
| FD10-01..16 and FD11-01..11 (second review round) | placed in the findings table above; FD11-08 is the owner's residue row, FD11-09 and FD11-11 wording fixed in the docs on Nov 10 |

## Gate evidence after phase 2 (Nov 11, 2026)

- `bun run check` passes (exit 0) and `bun run smoke` passes (SMOKE PASS, 90 steps) after the fixes of P32.2.1.
- Phase 3 stays open: it needs the owner's machines, networks and the paid model run (see the run sheet).

## Owner to run

1. Read the findings table after P32.1.5; accept, defer or reject each finding that has no owner plan.
2. Run the checks of phase 3 that name you (3.1 to 3.8), in the order of the table, and write the result next to each row: date, ok or finding id.
3. Run the paid eval run once (3.5) after the `--scripted` run is green; read the report in `data/evals/`.
