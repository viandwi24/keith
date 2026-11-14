# P15 — ACL and visibility

Nov 9, 2026 · status: **done, all 10 steps (3d0e929, 520380f, 95dead2, 5ed546c, 84cbe8b, ac8573e, f4a3832, 64c4159, then step 9 `feat(tui)` and step 10 `docs(repo)`)** · ADR-0015 · specs touched: new `acl.md`, `permissions.md`, `people.md`, `db.md`, `tui.md`, `core-cli.md`
Order: P14 -> **P15** -> P16 -> P17 -> P18. Needs from P14: the `Actor` type, `person` identifiers and the session `zone`.
Gives P16 the `Acl` helper, `visibleIds`, the conformance kit and the audit kinds; gives P17 the guest ceiling.

## Goal

Every shareable thing (a note, a reminder, later more) has an owner, an optional team, Linux-like `rwx` bits for owner, team and public, and extra
entries for named users and groups with allow and deny. Private by default. The six sharing cases are data. Lists, search and counts are
filtered in SQL, a denied read looks like "not found", the owner can see everything but every look at a member's private data is audited, and the
agent can never act with more than the person who asked.

## Verified starting point

- Roles `owner | member`, a closed `CAPABILITY_IDS` set and `person_grants` (`packages/contracts/src/capabilities.ts`, docs/specs/permissions.md). Function level only.
- No `groups`, `resources` or ACL table in `packages/db/src/schema/keith.ts`. `auditEvents` exists and has **no pruning code** (grep `prune|retention` in
  `modules/audit` finds nothing), so audit volume must be designed, not assumed.
- eharness 0.12: `Principal` is `{ id, name?, [k]: JSON }`, durable through inbox, park and wake, inherited by subagents (ADR-0069); `eharness/identity` has an
  open `Person.role` and `decideByRisk`; there is no resource model and no groups. (The research reports said 0.11; the repo pins 0.12.0.)
- Isolation is structural today (`memory/<personId>`, `front:<personId>`, `thalamus/activity-filter.ts`, budget scopes). P15 does not replace it; it adds the
  resource layer on top for plugin data.
- `tool.approve` must decide from input and static tables only (AGENTS.md gotcha).

## Decisions taken (ADR-0015)

| Question | Decision |
| --- | --- |
| Model | owner/team/public `rwx` + entries (user or group, bits, allow or deny); deny wins; union of allows minus denies, then the guest ceiling |
| Default | `0600`, owner = creator, no team, no entries; a kind may default to at most `0640`; `public` bits only by an explicit act |
| Groups | Owner-created and managed only; flat; looked up at check time; never in the principal |
| Who may share | The resource's owner, to existing users and groups; widening to `@public` needs step-up and the action approval |
| Owner access | Allowed, audited (`acl.owner-access`), documented for members; no break-glass flag |
| Filtering | `visibleIds(actor, kind, bits)` SQL subquery before order, limit, ranking, counts; denied read = not found |
| Inheritance | None live; container defaults are copied at creation |
| Pending-owner-review queue | **Not here: P16.** It stores an operation name and validated input and replays it through the host guard as the requester on approval, so it needs the operations registry and the audience rules. P15 only provides the rule "who may approve" (owner) and the audit kinds |

## Non-goals

Nested groups, live inheritance, relation-based access, per-field ACLs, UI beyond the manage section for groups. The plugin host and the
operations (P16). Guests themselves (P17); P15 only defines their ceiling. Moving `memory/` or sessions under the ACL.

## Design in brief

**Subjects and classes:** `owner`, `team` (the resource's `group`), `public`; entries use `user:<id>`, `group:<id>`, `@users`, `@public`. Guests are in
`@public` only, never in `@users` or a group.

**Evaluation** (`packages/acl/src/check.ts`, pure, takes a `Membership` port):

```
check(actor, res, want):
  suspended or unknown actor -> deny
  eff = 0
  if actor == res.owner: eff |= mode.owner
  if actor in res.group:  eff |= mode.team
  eff |= mode.other
  for allow entries matching actor: eff |= bits
  for deny entries matching actor:  eff &= ~bits
  if actor.kind == guest: eff &= GUEST_CEILING
  allowed = (eff & want) == want
```

**The six cases** as conformance tests: (1) `0600`; (2) `0604`; (3) `0600` + `allow @users r`; (4) `allow group:A r`, `allow group:B r`, and with `@users r`
plus `deny group:C r`; (5) `allow user:duta r`, `allow user:amel r`; (6) `allow user:duta r`. Each asserts owner, A member, B member, C member,
Duta, Amel, an outsider member and a guest.

**Storage** (additive migration, generated): `groups(id, name unique, created_by, created_at)`, `group_members(group_id, person_id, added_by, added_at)`,
`resources(kind, id, owner_id, group_id, mode, created_at, updated_at; pk(kind, id); index(owner_id, kind))`,
`resource_acl(kind, id, subject_kind, subject_id, bits, effect, created_by, created_at; index(subject_kind, subject_id))`.
The plugin's content table holds content; the `resources` row is written by the helper in the same transaction, so a check for write happens inside
the writing transaction (`BEGIN IMMEDIATE`, as the other adapters) and TOCTOU is closed.

**`Acl` helper** (`@keith/acl`, bound per call to the `Actor`, never to tool input): `check`, `require` (read denied -> `NOT_FOUND`), `create`, `visibleIds`/`filterSql`,
`share`, `unshare`, `chmod`, `chown`, `explain`, `remove`. Ids are random 128-bit, never placed in error text.

**Owner-access audit without flooding:** one row per (owner session, resource) per 10 minutes, kind `acl.owner-access`, detail `{ kind, id, owner, bits }` (no
content); denied reads are counted, not logged one by one (`acl.deny` sampled). Audit retention is a P15 decision: add a
configurable prune (default 180 days) so the table cannot grow without bound; this is the first pruning code and it has its own test.

**Confused deputy:** `Acl` gets its actor from the session or turn principal through the `Actor` resolver of P14, re-read from the database each call
(status and role), not from the stored principal. Background fires and wake turns are P16; P15 ships the test helper that proves a worker or wake
turn runs as the creator or recipient and that a suspended person's queued turn is refused.

## Steps (one commit each, in order; `bun run check` green after each)

1. **DONE 3d0e929.** **Spec and contracts.** `docs/specs/acl.md` (model, bits by kind, evaluation, errors, audit kinds), `Bits`, `Resource`, `Entry`, `Subject` schemas;
   `permissions.md` gets the "function level vs resource level" section. Scope `contracts`.
2. **DONE 520380f.** **`packages/acl`.** Pure evaluator, `Membership` port, in-memory store, the six conformance cases plus deny, guest ceiling, suspended actor,
   unknown kind, `x` bits on leaves rejected; property test: deny never grants, adding an allow never removes access. New package: scaffold with the
   generator, `bun test --pass-with-no-tests` dropped with the first test, add to `check-exports`. Scope `host`.
3. **DONE 95dead2.** **DB and `visibleIds`.** Generated migration; SQLite adapter in `packages/db` (repos only `apps/core` imports); `filterSql` fragment; tests for ordering,
   limit, cursors, counts and FTS5 ranking with a hidden row, and a transaction test. Specs `db.md`. Scope `db`.
4. **DONE 5ed546c.** **Owner-access audit and audit pruning.** Dedupe window, kinds `acl.create|share|unshare|chmod|chown|owner-access|deny|group.*`, the prune with a retention
   setting; spec `auth.md` (audit table) and `acl.md`. Scope `core`.
5. **DONE 84cbe8b.** **Groups.** Owner-only procedures `admin.groups.*` and capability `groups.manage` (owner role only; the closed-set test in contracts is updated),
   `keith-core groups create|list|add|remove|delete`, audit. A deleted group removes its entries (or refuses while entries exist; decide in step 5, default refuse with a count). Specs `permissions.md`, `core-cli.md`, `people.md`. Scope `core`.
6. **DONE ac8573e.** **Share, chmod, chown.** Core procedures and `keith-core acl show|share|chmod|chown`; a member may change only own resources, only to existing users
   and groups; widening to public needs step-up; `explain` prints an `ls -l`-like view. Spec `acl.md`. Scope `core`.
7. **DONE f4a3832.** **Conformance kit.** `@keith/acl/testing` exports `leakCheck({ operations, actors })`: runs list, search, count, get, update and delete for owner, an outsider
   member and a guest and fails on content, title, count or error-text differences between "forbidden" and "missing". P16 uses it for Notes and Reminders. Scope `host`.
8. **DONE 64c4159.** **Principal tests.** Scripted-model tests: a subagent, a wake turn and a parked turn run as the asking principal; a person suspended after queueing is refused;
   the resolver ignores group or role data in the stored principal. Scope `core`.
9. **DONE.** **Groups in the TUI.** A "Groups" section in `keith manage` (list, create, add and remove members) through `packages/client`; owner only. Specs `tui.md`,
   `client.md`. Scope `tui`.
10. **DONE.** **Docs and proof.** Member-facing text (what the owner can see, and that it is audited), `docs/manual-testing.md`, ADR index, the plan to `done/`. Scope `repo`.

## Deviations and outcomes (2026-11-09, steps 1-4)

- **Scope `acl`** was added to `commitlint.config.js` for the new package (the plan said `host`); `packages/acl` was scaffolded with `bun init`, then conformed with `bun pm pkg` (CLAUDE.md, .gitignore and index.ts deleted).
- **Owner root is read-only** (`OWNER_ROOT_BITS = r`): the plan's pseudo-code had no root; ADR-0015 says "may read any resource". The evaluator returns `ownerAccess` only when root made the difference. Root is applied after deny entries (an entry cannot hide a resource from the owner) but a suspended or unknown person is denied even as owner. Chown or delete on removal of a person are store calls (`removePerson`), not a `check`.
- **Defaults by class:** `0o600` is invalid for an `operation` (w must be 0), so the default per class is leaf and action `0o600`, container `0o700`, operation `0o500`; a kind default is still capped (owner any, team `r`, public nothing).
- **Class tables in contracts:** `VALID_BITS`, `GUEST_CEILING` (leaf, container, action `r`; operation `x`) and `OWNER_ROOT_BITS` live in `packages/contracts/src/acl.ts`; a request for bits outside the class is denied, a mode or entry with such bits is refused at write.
- **No foreign keys on person ids** (`resources.owner_id`, `group_members.person_id`, entries): `PersonStore.delete` is a hard delete and a foreign key would block removing a person. Orphans grant nothing (the person is not active) and `removePerson(personId, heirId)` hands resources to the heir; **`people.remove` does not call it yet: step 5/6 must wire it** (open verification 2: decision = chown to the owner).
- **Audit prune applies to every kind**, `person.*` events included (db.md used to say they are never deleted). `audit.retentionDays` has no CLI or rpc yet (settings repo only).
- **Open verification 1 (FTS5):** confirmed; the rank (`bm25`) is computed over the whole index, so a plugin must never expose the raw score (db.md). **Open verification 4:** the dedupe key is per (session, kind, resource) with one batched row per resource owner for a search. **Not yet verified:** 3 (plugin capability ids) and 5 (`tool.approve` always-ask), both for P16.
- The 0008 migration test now cuts the journal at its own entry (`src/testing/migrations.ts`) instead of popping the last one, so later migrations do not break it.
- Counts: `bun run check` after step 1: 1649 tests; step 2: 1692; step 3: 1713; step 4: 1730; 0 failures each. `bun run smoke`: 26 steps PASS, no process left.

## Deviations and outcomes (2026-11-09, steps 5-8)

- **Step 5.** `groups.manage` is in `OWNER_ONLY_CAPABILITIES`: a grant is refused (`BAD_REQUEST`) and `capabilitiesOf` ignores a stray row, so "owner role only" holds even for a member granted everything else. `deleteGroup` refuses with the count (default kept). `people.remove` now hands resources to the owner **inside the delete transaction** through a `beforeDelete` option of `sqlitePersonStore` (nested `BEGIN IMMEDIATE` becomes a savepoint under bun:sqlite; a throw rolls the removal back; tested); the move is audited as `person.resources.moved`. Open verification 2 is closed (chown to the owner). `keith-core audit retention [show | set <days>]` and `admin.audit.retention.get|set` (owner only, step-up, audited `audit.retention.set`) were added; `0` keeps everything and the help says so. Core exposes `core.acl` and `core.kinds.register(...)` (an empty kind table until P16).
- **Step 6.** Added `chgrp` (and the audit kind `acl.chgrp`, 13 kinds) because a team could not otherwise be set; `show` is limited to the resource's owner and the instance owner (a reader gets `NOT_FOUND`, so entries stay private). `acl.*` procedures are `authenticated` and decide in the handler on the stored resource inside one transaction; `chown` is `people.manage` with step-up plus a role check. Widening is "an allow for `@public` or `@users` with new bits, or more `other` bits", confirmed by step-up over TCP; the local socket is always confirmed; an agent tool is never confirmed on its own. Targets are names or ids typed by a person and resolved server side (a member needs no `people.manage`).
- **Step 7.** `leakCheck` also takes the baselines before the seed and compares after (so total, rank and hint leaks show), requires a `term` valid for the plugin's search, and reports a vacuous fixture. Applied to the SQLite store with an FTS5 plugin (db), to `acl.show|chmod|unshare` over TCP (core); the guest actor is optional because core has no guest path before P17.
- **Step 8.** `createAclActors().of(ctx.principal)` is the per-call resolver (id only; status and role read now; a username or guest id never resolves). Tools must read `ctx.principal` from the tool factory context, not the setup context. `aclGuard()` (always-ask for `acl_*` tools by name, mounted on the front agent and workers) closes open verification 5: it decides from the name and a static table only. Not covered here: the wake turn started by `inject` is a generic eharness path, so the tests assert the principal at the tool, not the inbox internals.
- **Counts.** `bun run check`: step 5 1740 tests, step 6 1749, step 7 1759, step 8 1767, 0 failures (one TUI login test, `home-login.test.tsx`, timed out once under load and passed alone and on the rerun). `bun run smoke`: 26 steps PASS, no process left. Smoke had no `acl` step yet (done in step 10, see below).

## Deviations and outcomes (2026-11-09, steps 9-10)

- **Step 9.** The Groups section sits right after People (`groups.manage`, owner only: a member never sees it, and a grant of the capability is refused by the core). Rows `GROUP / MEMBERS / USED BY`, the detail line names the members. `n` creates; the row actions are `Add a member` (a `‹ person ›` choice over the active people not in the group, so "pick from the people list" is a picker, not free text), `Remove a member` (a choice over the members) and `Delete` (a confirm). A delete of a group in use is refused by the core (`CONFLICT`) and its message with the count (`family is used by 2 resources: ...`) stays in the confirm dialog; the confirm text already warns when the row's `usage` is above zero. Step-up goes through the existing `guard`; a PIN session that cannot step up shows the core's message as every other section does. **Audit retention** went to Access (the plan did not say where): the fact line `audit     kept 180 days` and the action `Audit retention` (`admin.audit.retention.get|set`, days, 0 keeps everything); the line is hidden when the person may not read the audit. Adding a ninth section changed `n/8` to `n/9`, the Home menu order (`j` after People now opens Groups) and the owner list in four tests; one `home.test.tsx` case timed out at 5 s on this and was the real cause (not load): fixed by updating the test. The Home menu got a one-line detail for Groups.
- **Flake watch.** `home-login.test.tsx` did not fail in any of the runs of this step (the file passed alone, in `bun test ./apps/tui` and in `bun run check`); the earlier time-out is still not reproduced, so it is neither confirmed as flaky nor fixed.
- **Step 10.** Member-facing text is `docs/sharing-and-privacy.md` (plain language: the owner can read everything and every look is audited, how sharing works, who sees what, Keith acts with your rights only), linked from the README. Manual scenario 13 in `docs/manual-testing.md` is the plan's "Owner to run" list; the steps that need a resource are marked as needing P16. ADR-0015 was already `Accepted`; only its plan link changed.
- **Smoke `acl` steps** (`scripts/smoke/acl.ts`, plain fetch and the real CLIs): groups create, add, list, remove and delete through `keith-core` (a duplicate create is refused); a member (duta, password login over TCP) gets 403 `FORBIDDEN` on `admin/groups/list|create` and `admin/audit/retention/get|set` and creates nothing; `acl/show` of a missing kind and of a missing id answer the same `NOT_FOUND` for the member; audit retention show, set 90, set 0, 9999 refused, restored; the audit lists `acl.group.create|add|remove|delete` and `audit.retention.set` and holds no passphrase. **What the smoke cannot prove, honestly:** core registers no resource kind until P16, so there is no real resource to share, to read as an outsider or to have audited as an owner access. The gate wording "share, member reads, outsider gets not found, owner read audited" is therefore **not run end to end**; it is covered by the `@keith/acl` conformance and leak kits (in-memory and SQLite with FTS5), the core procedures' tests over TCP, the owner-access audit tests and the `acl.show|chmod|unshare` leak check. It joins the smoke with the Notes plugin in P16. No fake production kind was added.

## Gate evidence

Nov 9, 2026, on the working tree of the commit that closes this plan. It is **not** a clean-copy run: the tree also held the owner's uncommitted `apps/tui/src/cli.tsx` and `scripts/manual.ts`, which were neither touched nor staged.

- `bun run check`: exit 0. Biome (one pre-existing warning, an unused parameter in `auth-commands.test.ts`), tsc on every package and the scripts, `bun test` (**1778 pass, 13 skip, 0 fail**, 1791 tests in 217 files; 1767 after step 8, 1778 after step 9, step 10 adds none), check-imports (694 files, 12 packages), check-entry, check-size (warnings only, none above 800; `scripts/smoke.ts` 448, `sign-in.ts` 438) and check-exports ok (11 entries).
- `bun test ./apps/tui` alone and every pty file alone (`cli.manage`, `cli.pty`, `cli.home`, `cli.login`, `cli.input`, `cli.signin`, `cli.nocore`): pass. New: `manage-groups.test.tsx` (7: list, create, add and remove a member, delete refused with the count, delete, step-up retry, audit retention), `features/manage/groups/groups-state.test.ts`, and the real-pty `cli.manage.pty.test.ts` (creates a group and adds a member from the keyboard).
- `bun run smoke`: `SMOKE PASS (31 steps ok, about 21 s)` (26 before; five `acl` steps added), no keith, node or smoke process left.
- The verification items of the gate: the six cases for eight actors, the leak kit and its mutation check, one `acl.owner-access` row per window with no content, and a group removal that takes effect on a queued turn are tests of steps 2, 4, 7 and 8 (counts above). The migration test on a copy of the real database was run by the migration tests of step 3 on fresh and migrated files, **not on the owner's own database**.

**Unverified.** (1) Open verification 3, whether plugin-registered capability ids fit the closed `CAPABILITY_IDS` set, goes to P16 with the plugin layer. (2) The manual scenario 13 and the plan's "Owner to run" list were not run by an agent: they are **owner to run** (steps 4 to 8 need a resource, so they wait for the Notes plugin). (3) The end-to-end smoke with a real resource (above). (4) The TUI Groups section was driven against the fake core in a pty and in component tests, not against a real core by hand. (5) The wake turn that `inject` starts is a generic eharness path: the tests assert the principal at the tool, not the inbox internals.

**Addendum (Nov 9, 2026, P16 step 11).** The end-to-end ACL gate that this plan could not run for lack of a resource kind now runs in `bun run smoke` (`scripts/smoke/plugins.ts`, Notes as the resource, plain `fetch` and the real CLIs): a member's private note is `404 NOT_FOUND` for an outsider with the same body as a made-up id (get, and absent from list and search), a share to a group lets a group member read it and still not the outsider, a public share is read through `public_get` (a group-only note is not), the owner's read of a private note writes an `acl.owner-access` row, and no note text reaches the audit log. Open verification 3 (plugin capability ids in the closed set) was settled in P16 (registry at load, grants through `admin.people.grant`). The manual scenario 13 steps 4 to 8 are runnable by hand with Notes (scenario 14 of `docs/manual-testing.md`); they remain owner to run.

**For P16.** Consume `@keith/acl` (the evaluator, `Membership`, the in-memory store and `@keith/acl/testing`'s `leakCheck`), `sqliteAcl` (`packages/db`, `visibleIds` and `filterSql` for every list, search and count, never your own post-filter, and never expose the FTS `bm25` score), `aclGuard()` (mount it on the front agent and workers so `acl_*` tools always ask) and `createAclActors().of(ctx.principal)` (read the principal from the tool factory context, not the setup context). Register kinds with `core.kinds.register(name, def)`; each kind needs its class (leaf, container, action or operation) and a default of at most `0640`. Run `leakCheck` for Notes and Reminders with the owner, an outsider member and, from P17, a guest. Add the end-to-end `acl` smoke (share, member reads, outsider not found, owner read audited) once a kind exists. Plugin capability ids are open verification 3.

## Risks

- **A plugin forgets the check.** Mitigation: the only list API is `filterSql`, the conformance kit is a gate for every plugin (P16), and `check-imports` forbids a plugin from importing `@keith/db`.
- **Audit flood or growth** from owner access: dedupe window and pruning (steps 4).
- **Group lookup cost:** one membership query per check, cached per call and invalidated by the store; lists use the subquery.
- **Stale truth:** if group membership changes between enqueue and run, the run sees the new membership (by design).
- **Injection through shared content:** results from resources not owned by the actor are wrapped as untrusted data with the author named; ACL-changing operations always ask (P16 wires it).

## Open verifications

1. `bun:sqlite` has FTS5 compiled in and an FTS query can join a `visibleIds` subquery with correct ranking and no leak through `bm25` or `snippet()`: write the Notes-shaped test in step 3.
2. A person removal with owned resources: chown to the owner or archive; confirm `people.remove` behaviour in `modules/people` and pick one (default chown to the owner).
3. Whether `CAPABILITY_IDS` can take plugin-registered ids (P16) without breaking the contracts test "every procedure has a known capability".
4. The cost of one audit row per owner access on a Notes search that touches 50 notes (the dedupe key must be per search, not per note; define it in step 4).
5. Whether the always-ask rule can sit in `tool.approve` using only tool name and input (it must; confirm with `motor/risk.ts` as the model).

## eharness impact

None required. Optional follow-ups, only if P16 proves a need: the typed `Principal` (ADR-0069 future work) and an optional `agent.deleteSession` (P17). Neither is a prerequisite.

## Verification items for the gate

- The six cases pass for all eight actors, with and without deny entries.
- The leak kit passes on a toy plugin with the three actors; a planted post-filter bug makes it fail (mutation check, removed after).
- Owner reads of a member's private resource produce one audit row per window and no content.
- Group removal takes effect on a queued wake turn.
- Migration test on a copy of the real database; `bun run check` and `bun run smoke` pass.

## Gate

`bun run check` exit 0 on a clean copy; smoke gains an `acl` step (create group, share, member reads, outsider gets not found, owner read audited). Record counts like P13.

## Owner to run

1. `keith-core groups create friends`, add two people; as a member (second terminal) confirm they cannot create groups.
2. As a member, create a resource through the P16 Notes plugin later; for now `keith-core acl show` on a test resource and `chmod 640`.
3. Share to Duta only; sign in as Amel and see "not found".
4. As the owner, open Duta's private resource and read the audit: one `acl.owner-access` row, no content.
5. Try to widen to public as a member without step-up: refused.
6. Remove Duta from the group while a wake turn is queued; the turn no longer reads the resource.
