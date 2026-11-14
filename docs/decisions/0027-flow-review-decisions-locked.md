# 0027. Flow review 2026-11-09: every open decision locked

Status: Accepted (2026-11-10). Decided by the CTO role the owner delegated (owner instruction of 2026-11-10: "decide, I want the outcome").
Builds on ADR-0020 to ADR-0026. Amends ADR-0014 and ADR-0016 on migrations (point 3), ADR-0009 on `audit.read` (point 6) and OWN-008 (point 9).
Evidence: the local review folder `docs/flow-review/2026-11-09-full/` (gitignored); finding ids F-xxx and question ids Q-xxx refer to it.

## Context

The flow review left 53 findings after the three High ones (fixed in P21), eight open owner questions (Q-009 to Q-016), twenty conflicts between
documents (C-01 to C-20) and fourteen documentation gaps. Plans can only be complete if each of them has one decided outcome. This ADR is that
list; plans P23 to P31 implement it and cite the point numbers here.

## Decision

### Source authority
1. Newest ADR (with its amendments) > spec > README, SECURITY.md, ARCHITECTURE, plans. A doc that disagrees with a newer source is fixed, not
   obeyed (OWN-006). Done plans are history and are never edited.

### Identity and access
2. **PIN step-up follows the PIN zone rule** (loopback, lan, tailscale), like PIN sign-in (Q-011, F-031).
3. **Migrations** (C-13, F-011, F-027): `keith-core start` and setup may migrate a behind database, but only after writing a backup
   (`<dataDir>/backups/keith-<timestamp>.db` through SQLite `VACUUM INTO`) and printing what ran; `db migrate` takes `core.lock`; the stale-lock
   takeover uses an atomic create (F-026). This replaces "never at boot" in ADR-0014, ADR-0016, db.md and packages/db/AGENTS.md.
4. **`/auth/login` applies the same role and identifier-kind narrowing as `/auth/flow`** (Q-016, F-006); `sessionTerms` takes role and
   identifier kind (F-028).
5. **Credentials**: purging an approved but uncollected device request revokes its credential (F-014); `admin.tokens.revoke` and
   `admin.devices.revoke` act on the caller's own credentials unless the caller is the owner (F-015); offline setup or first-owner that sets a
   secret revokes the person's other sessions (F-029); offline `auth local set` runs the same policy guard as the RPC (F-030); policy fields
   `rateLimit` and `requireAssurance` are removed from the schema and ignored when read from old rows (F-047).
6. **Audit visibility** (Q-014, F-018): `audit.read` becomes owner only (added to `OWNER_ONLY_CAPABILITIES`, existing grants ignored and listed
   by doctor); every person gets `audit.mine`: the rows where they are the subject or the resource owner, including `acl.owner-access` rows
   (the promise of sharing-and-privacy.md). The first-login notice of ADR-0015 is shown once per person in the TUI and recorded (doc gap 3).
7. **Audit completeness**: setup changes are audited with `via: offline` (Q-013, F-044); `settings.provider.add` vs `settings.provider.key`
   are distinct kinds, `providers.test` writes `settings.provider.test`, a prune by the running core says `via: local` (F-045); the declared
   `acl.create`, `acl.remove`, `acl.deny` kinds are written (F-046); the approval row carries node, command and the applied remember scope (F-035).
8. **Owner self-share is allowed** (OWN-013, F-005): the share or chown row is the audit trail; acl.md says so.

### Nodes, shell, approvals
9. **Nodes are Keith's self layer** (ADR-0020): members with `nodes.read` see all nodes; OWN-008's "their own" applies to activity only
   (Q-010, F-017).
10. **Approvals expire**: a pending approval expires after 24 hours (setting `approvals.ttlHours`, 1 to 168), the TUI shows its age, and an
    expired request answers the tool as denied with reason `expired` (F-009). The `approval-stale` protocol (P28) later pings before expiry.
11. **Stopping a task cancels its parked approval** and a task row in a final state never goes back to `running` (F-007).
12. **Core shell confined like a node** (ADR-0021, F-032): realpath containment of cwd and the minimal env `PATH, HOME, LANG`.
13. **Node daemon** stops retrying on close code 4003 and on 401 at connect (F-033); join is one transaction (name check, consume with
    `usedByNode`, create) and a 409 counts as a failure for the guard (F-034); `purgeExpired` runs in the prune tick.
14. **TUI** shows "allow for task" only on items the caller may scope that way (F-036).

### Runtime and plugins
15. **Reconcile isolates failures per person** (F-008); wake checks the recipient is active (F-037); the "which people count" rule is written
    once in sessions.ts and used by every path (F-038); worker budget text cites the worker cap (F-039).
16. **Delivery is exactly once by run id** through one delivery service (P25): reminders pass their fire id as the inject key, `lastSlot` is
    written in the same transaction as the fire record, the boot tick fires at most the latest slot (F-019, F-020); fire counters are pruned
    after 48 hours (F-021); a reminder that could not be delivered is reported to its creator (F-010).
17. **A once reminder that falls due while its plugin is off fires once when the plugin is enabled again** (catch-up); cancel refuses rows
    already done or ended (F-022).
18. **The owner may cancel a member's reminder** (stop power of ADR-0020 point 4) but not read its text beyond the list line; the cancel writes
    `acl.owner-access` and notifies the member (Q-015, F-016). The owner still cannot delete a member's note (content stays with its author).
19. Notes create and delete run in one transaction (F-042); reviews are purged 30 days after decision in the prune tick (F-043); the access.ts
    comment about tool approval is corrected (F-048).
20. **Dead letters of guest sessions are only logged** (Q-012, F-049); compose-sessions and TST-079 change accordingly.

### Guests and money
21. **Trusted proxy for the guest listener** (Q-009, F-012): opt-in `guests.trustedProxy` (`none` default, or `cloudflare` / `x-forwarded-for`
    with a list of proxy addresses); without it, guests.md warns that behind a proxy all visitors share one window.
22. `registry.open` rechecks the kill switch and `enabled` after its await (F-023); `GET /guest/status` reads limits without seeding the ledger
    and has a per-IP rate limit (F-040); the TUI lets the server end a session at the turn cap so the reason is `turn-cap` (F-041).
23. **Unpriced models** (F-004): the eharness `W_MODEL_UNPRICED` warning is routed to the log, doctor and `budget.get` (`unpriced: [model]`);
    the guest role refuses an unpriced model; an owner may set a manual price per model (`models.price.set`).
24. Setup keeps an existing null budget limit (F-024) and renames the current owner, not the id `owner` (F-025).

### Data lifecycle (documentation gaps)
25. **Backup and restore** get one contract (doc gap 13): `keith-core backup` (database through `VACUUM INTO`, plus `secret.key`, plus
    workspaces and memory as a tar) and `keith-core restore` (core stopped); upgrade order is documented in core-cli.md.
26. **Removed person's data** (doc gap 4): removal keeps conversations, memory and workspace in `keith/removed/<personId>/` for 30 days, then
    purges them; `keith-core people export <person>` writes a tar before removal. `left` status is dropped from the enum (F-051).
27. **`can_login`** gets `admin.people.setLogin` (owner) and `keith-core people login on|off` (doc gap 6).
28. Node tokens rotate on every reconnect after 30 days and node messages are rate limited per node (doc gap 9).
29. Out of scope, recorded as not planned: reminder time zones per reminder (doc gap 8), web UI, TLS, mail or SMS recovery, TOTP (doc gap 5).

## Consequences

- Every finding, question, conflict and gap now has one outcome; plans P23 to P31 cite these points, and the coverage check of the review
  folder maps each id to a plan step or a doc change.
- Some changes alter shipped behaviour (audit.read, approval expiry, migrations with backup); the plan steps change the specs in the same commit.
- Revisit any point by a new ADR that supersedes the point by number.
