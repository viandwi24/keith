# ACL (resource-level access)

Code: `packages/contracts/src/acl.ts` (bits, mode, subjects, entries, resource, class tables), `packages/acl` (evaluator,
`Membership` port, store port, in-memory store; step 2), `packages/db` (SQLite adapter and `filterSql`; step 3), audit in
`apps/core/src/modules/audit` (step 4). ADR: `docs/decisions/0015-acl-and-visibility.md`. Plan: `docs/plans/done/P15-acl-and-visibility.md`.

## Purpose

Function-level access (capabilities, `permissions.md`) says which calls a person may make. This module says which **resources** a
person may touch: a note, a reminder, a tool. Linux-like `rwx` bits for the owner, the team and the public, plus entries for named
users and groups with allow and deny. Private by default. Nothing reads it yet in P15 steps 1-4; plugins consume it from P16.

## Model

A **resource** is `(kind, id)` with `ownerId` (a person), `groupId` (the team, or null), a `mode` of nine bits (`0o640` is
`rw-r-----`) and up to 64 **entries** `(subject, bits, effect)`. The content lives in the plugin's own table; the resource row only
carries the access data. A new resource is `owner = creator`, no team, `0o600`, no entries. A kind may default to a wider mode, never
wider than `0o640`; the public bits are set only by an explicit act of a person, never by a default.

**Bits:** `r` = 4, `w` = 2, `x` = 1 (`Bits`). **Subjects** (`Subject`): `user:<id>`, `group:<id>`, `@users` (every active user, never
a guest), `@public` (everyone, guests included; the same audience as the `other` class). **Entries** have an effect, `allow` or `deny`;
a subject has at most one of each per resource (a second write replaces the first).

### Bits by class

| Class | `r` | `w` | `x` | Valid bits (`VALID_BITS`) | Guest ceiling (`GUEST_CEILING`) |
| --- | --- | --- | --- | --- | --- |
| `leaf` (a note) | read the content | edit or delete | must be 0 | `rw` | `r` |
| `container` (a notebook) | list the children | create or delete children | open a child by id (the child is checked too) | `rwx` | `r` |
| `operation` (a tool, `tool:<name>`) | see it described | must be 0 | invoke it | `rx` | `x` |
| `action` (a reminder) | read it | edit it | let it fire | `rwx` | `r` |

A mode or entry that sets a bit outside the valid bits of its class is refused when written. At check time a request for a bit outside
the valid bits is denied. The class of a kind is registered by the plugin that owns the kind; an **unknown kind is denied**. Core registers
one kind itself at boot, `room` (class `container`, the transcript and workspace of a shared room, `apps/core/src/compose-identity.ts`,
`docs/specs/corpus-callosum.md`, "ACL"); every other kind comes from a plugin.

## Evaluation (`check`, pure)

Inputs: an `AclActor` (`kind` user or guest, `id`, `role`), the resource, the wanted bits and a `Membership` port. No other I/O.

```
suspended, left or unknown actor, or a system actor  -> deny
unknown kind, or wanted bits outside VALID_BITS[class] -> deny
eff = 0
if actor is a user and actor.id == res.ownerId:       eff |= mode.owner
if actor is a user and isMember(res.groupId, actor):  eff |= mode.team
eff |= mode.other
for allow entries matching the actor:                 eff |= bits
for deny entries matching the actor:                  eff &= ~bits      (deny always wins)
eff &= VALID_BITS[class]
if actor is a guest:                                  eff &= GUEST_CEILING[class]
normal = eff
if actor.role == owner (active user):                 eff |= OWNER_ROOT_BITS (read)
allowed = (eff & want) == want
ownerAccess = allowed and (normal & want) != want and actor.id != res.ownerId
```

An entry **matches** when: `user:<id>` and the actor is that user; `group:<id>` and the actor is a user and a member of the group
(looked up now, through `Membership`); `@users` and the actor is a user; `@public` always (a guest included). A guest is never an
owner, never in the team, never in a group and never in `@users`; whatever is stored. Deny wins over every allow, also over the team
and public bits. The instance owner's root read is applied after the deny, so no entry can hide a resource from the owner; that read
is what `acl.owner-access` records.

`AclDecision` is `{ allowed, effective, ownerAccess }`. `ownerAccess` is true only when root access made the difference, so reading
a resource the owner could read anyway (their own, or one shared with them) writes nothing.

**Groups are never in the actor or the principal.** `Membership.isMember(groupId, personId)` and `Membership.isActive(personId)` are
asked at check time, so a removal or a suspension is effective for a queued turn at once.

## The six cases (conformance, all as data)

| # | Case | Mode and entries | Who reads |
| --- | --- | --- | --- |
| 1 | Private | `0600` | the owner (and, audited, the instance owner) |
| 2 | Public read | `0604` | everyone, guests included |
| 3 | Users, no guests | `0600`, `allow @users r` | every active user, no guest |
| 4 | Groups A and B, not C | `allow group:A r`, `allow group:B r`; with a broad share, `allow @users r` and `deny group:C r` | members of A or B; with the broad share, everyone but C |
| 5 | Duta and Amel | `allow user:duta r`, `allow user:amel r` | those two |
| 6 | Duta only | `allow user:duta r` | Duta |

The conformance suite of `packages/acl` runs each case for eight actors: the owner, a member of A, B and C, Duta, Amel, an outsider
member and a guest, and is run again against the SQL filter in `packages/db`.

## API of `@keith/acl`

| Export | What it is |
| --- | --- |
| `check({ actor, resource, want, kinds, membership })` | the evaluator; returns `AclDecision` |
| `defineKinds({ note: { class: 'leaf', defaultMode? } })` | the `KindRegistry`; throws on a bad name or on a default wider than `0o640` (owner any, team `r`, public nothing). Defaults by class: leaf and action `0o600`, container `0o700`, operation `0o500` (`DEFAULT_MODE_BY_CLASS`, `defaultModeOf`) |
| `modeProblem`, `entryProblem`, `resourceProblem` | why a mode, entry or whole resource is refused for a class (x on a leaf, bits 0, over 64 entries) |
| `Membership` | `isActive(personId)`, `isMember(groupId, personId)`; both asked at check time |
| `AclStore` | `createResource`, `getResource`, `setMode`, `setOwner`, `setGroup`, `setEntry`, `removeEntry`, `removeResource` (unchecked); `check(actor, kind, id, want)`, `visibleIds(actor, kind, want)` (checked, same rule); groups: `createGroup`, `getGroup`, `listGroups`, `deleteGroup` (refuses `CONFLICT` while `groupUsage > 0`), `groupUsage`, `addMember`, `removeMember`, `members` |
| `memoryAcl({ kinds, now? })` | the in-memory `AclStore` plus `activate(id)` and `deactivate(id)` for tests |
| `requireAccess(store, actor, kind, id, want)` | the checked read: throws `AclError('NOT_FOUND')` for a denied or missing resource, `FORBIDDEN` only when the actor can read but lacks the wanted bits |
| `removePerson(personId, heirId)` (on `AclStore`) | a person leaves: resources to the heir, their `user:` entries and memberships removed; returns the count moved |
| `aclActorOf(actor)` | `Actor` (P14) to `AclActor`; `undefined` for a system actor or a user without a person id |
| `AclError` | `code`: `NOT_FOUND`, `FORBIDDEN`, `INVALID`, `CONFLICT`; the message never names an id, kind or person |
| `sqliteAcl` (`@keith/db`) | the SQLite `AclStore` with `filterSql` and `transaction` (`db.md`, "ACL storage") |
| `@keith/acl/testing` | `SHARING_CASES`, `CASE_ACTORS`, `CASE_GROUPS`, `CASE_PEOPLE`, `CASE_KINDS`, and the leak kit `leakCheck`, `assertNoLeak` (below) |

The instance owner's root is read only: `OWNER_ROOT_BITS` is `r`, so an owner can never write or fire another person's resource through
the evaluator. Administrative changes on a person's resource (chown when a person is removed) are store calls that the core makes
under its own authority and audits; they are not a `check`.

The owner may give themselves an entry on a member's resource, or chown it (`acl.share`, `acl.chown`): allowed on purpose (ADR-0027 §8, OWN-013). That share or chown row is the audit trail; once an entry covers the want, `ownerAccess` is false, so later reads write no `acl.owner-access` row, and the share or chown row names the resource owner (`resourceOwner`), so that member reads it under `audit.mine`. Content stays with its author: a member's note is deleted only by its resource owner. Reminders are different: the owner role may cancel any reminder today (`plugins/reminders/operations/manage.ts`, the stop power of ADR-0020) and the cancel writes no `acl.owner-access` row. The cancel of a reminder between two other people writes `acl.owner-access` and tells both people (`plugin.reminders.cancelled-by-owner`, ADR-0027 §18); the owner still cannot read the text beyond the list line.

## Not found

A denied read and a missing resource look the same to the caller: the same error (`ACL_NOT_FOUND`, `NOT_FOUND`), the same message,
the same shape. Only someone who can already read learns that they lack write (`FORBIDDEN`). Identifiers are random 128-bit values
and never appear in error text.

## Visibility in lists (`visibleIds`, `filterSql`)

Lists, search, counts and cursors are filtered **in SQL, before** ordering, limit, ranking and counting: the filter is a subquery
`SELECT id FROM resources WHERE kind = ? AND <rule>` that a plugin joins or uses in `IN (...)`. The fragment has bound parameters
only (never a string-built id) and applies the same rule as `check` (status, ownership, team, public, allow, deny, guest ceiling,
owner root). The in-memory store offers `visibleIds` with the same answer, and a differential test compares the two over generated
resources. The details are in `db.md`.

## Audit

Kinds (`ACL_AUDIT_KINDS`): `acl.create`, `acl.share`, `acl.unshare`, `acl.chmod`, `acl.chown`, `acl.remove`, `acl.owner-access`,
`acl.deny`, `acl.group.create`, `acl.group.delete`, `acl.group.add`, `acl.group.remove`. `acl.create` and `acl.remove` are written when a plugin's own operation makes or removes a resource (`k.acl.createResource|removeResource`):
the host's `auditedAcl` (`packages/host/src/acl-audited.ts`) records them as the person who made the call, through the core's ACL audit. A
guest or other non-person call writes nothing. `acl.deny` is written by the plugin access port (`createAccessPort`, `modules/plugins/access-port.ts`)
on a resource-level refusal of `k.access` (the resource is missing or not visible, or it is not theirs to change); function-level refusals (an unknown
kind, a guest) stay `plugin.denied`, written by the guard (`plugins.md`, "Audit"). The detail of each is a short, fixed set of fields (kind, id, owner,
mode, bits, counts); **never the content, the title or any secret**.

- `acl.owner-access`: the instance owner read a resource that is not theirs and that the rules alone would not give them (`AclDecision.ownerAccess`;
  for a list, the rows in `filterSql` but not in `filterSql(..., { rootAccess: false })`). One row per owner session and resource per window
  (10 minutes, `ACL_AUDIT_WINDOW_MS`); a batch (a search touching 50 notes) is one row per resource owner with `count` and the first 20 ids, and the same
  search again writes nothing. Detail `{ kind, id, owner, bits }` or `{ kind, ids, count, owner, bits }`. The member-facing docs say the owner can do this and that it is audited.
- `acl.deny`: denied reads are counted, not logged one by one: the first deny per (session, kind) in a window writes a row (`count`, `suppressed`: what the
  previous window held back), the rest only increase a counter; `flush()` writes the remainder.
- `acl.create` detail `{ kind, id, owner, mode, resourceOwner }` (`owner` and `resourceOwner` are the resource owner); `acl.remove` detail `{ kind, id, resourceOwner }`.
- The others are written when the change succeeds, by the person who made it. `acl.share`, `acl.unshare`, `acl.chmod`, `acl.chgrp` and `acl.chown` carry `resourceOwner` (the person who owns the resource; for `chown` the owner before the change). `acl.owner-access` carries `owner` for the same purpose. These keys are how `audit.mine` finds the rows about a person (`auth.md`, "Audit"); in `acl.share` and `acl.unshare` the key `subject` stays the ACL principal (`user:<id>`, `group:<id>`, `@users`), not the canonical person key.
- Every detail is validated against `AclAuditDetailSchemas` (contracts): an allow-list of short fields, other keys dropped, never content, title or secret.
  The recorder is `createAclAudit` (`apps/core/src/modules/audit/acl-audit.ts`); `createAuditRetention` is the prune.

Audit retention is a setting (`audit.retentionDays`, default 180, 0 keeps everything) with a prune that runs at boot and every 10 minutes; see `auth.md`, "Audit".

## Groups (administration)

`createGroupsService({ acl, people, audit })` (`apps/core/src/modules/acl/groups.ts`) and `admin.groups.list|get|create|delete|add|remove`
(`groups.manage`, owner role only; changes need a step-up over TCP; CLI `keith-core groups ...`, `core-cli.md`). A group is named by name or id, a name
is lowercase 2-32 characters. `add` needs an active person; `remove` takes anyone off, whatever their status; both are idempotent and write an audit row only
when something changed. A member id that names no person is listed with status `removed` (it grants nothing). `delete` is refused with `CONFLICT` and the count while a resource uses the group (as a team or in an entry): the default of the plan,
nothing is removed silently. Membership is read at check time, so a person who is suspended, or who is taken out of a group, loses what it gave at once (a
queued turn included); a suspended person is also denied as the actor. Core exposes the store as `core.acl` and the kind table as `core.kinds.register(name, def)`
for plugins (P16).

## Changing access (`share`, `unshare`, `chmod`, `chgrp`, `chown`)

`createAccessService` (`apps/core/src/modules/acl/access.ts`) and `acl.show|share|unshare|chmod|chgrp|chown` (the CLI is `keith-core acl ...`, `core-cli.md`).
Each call re-reads the caller from the people directory (status and role, never the principal's stored copy), then runs **one `BEGIN IMMEDIATE`
transaction** that loads the stored resource, checks the right and writes, so a check and its write cannot race. The owner of a resource is read from the
store, never from the request.

| Call | Who | Rules |
| --- | --- | --- |
| `show` | the resource's owner, the instance owner | the mode as `rw-r-----`, owner, team and entries with names. The instance owner looking at someone else's resource writes `acl.owner-access` (once per window) when root made the difference |
| `share`, `unshare` | the resource's owner, the instance owner | the target is `user:<name or id>`, `group:<name or id>`, `@users` or `@public`; a user must exist **and be active**, a group must exist (a member may name any existing group); bits must be valid for the kind's class; `--deny` works on the deny entry. `unshare` also removes an entry whose person is gone |
| `chmod`, `chgrp` | the resource's owner, the instance owner | a mode must fit the class; `chgrp` takes an existing group or clears the team |
| `chown` | the instance owner only (`people.manage` with a step-up, and the role is checked) | to an existing active person |

**Widening needs a confirmation.** Granting `@public` or `@users` something they did not have (an `allow` entry, or more `other` bits in `chmod`) is refused with
`KEITH_STEP_UP_REQUIRED` unless the call is confirmed: over TCP that is a step-up (the local socket is always confirmed); when an agent tool makes the call, it
is never confirmed on its own, so the tool must ask first (the approval path, P16 wires the tools; `tool.approve` already marks ACL-changing tools always-ask,
`permissions.md`). Narrowing, deny entries and named people never need it. A refusal writes nothing.

**Errors.** A missing resource, an unregistered kind and a resource the caller may not touch all answer `NOT_FOUND` with the same message; a caller who can
already read it but does not own it gets `FORBIDDEN`. A bad target or bits is `BAD_REQUEST`. Each change that changes something writes `acl.share|unshare|chmod|chgrp|chown`
inside the transaction (an unchanged repeat writes nothing) with the **before and after bits and ids only**: no title, content or secret. `acl.chgrp` is
`{ kind, id, from, to }` (group ids or null); it was added to the plan's kinds because a team could not otherwise be set.

## Conformance kit (`leakCheck`)

`leakCheck({ operations, actors, term, seed })` from `@keith/acl/testing` is the gate every plugin passes (P16 runs it for Notes and Reminders). `operations`
are the plugin's `list`, `search(actor, term)`, `count`, `get`, `update`, `delete` as a caller would use them (return what the caller sees, throw what the caller
sees; omit the ones the plugin lacks). `actors` are the `owner`, an `outsider` member, a `groupMember` (a member of a group that has **no** entry on the
resource) and a `guest` (omit only when the operations have no guest path). `seed()` creates one private resource for the owner and returns `{ id, missingId, secrets }`:
the content and title strings that must never reach anyone else. It returns a `LeakReport` `{ ok, problems }`; `assertNoLeak` throws with the list.

The kit takes the baselines of `list`, `search(term)` and `count` for every non-owner **before** the seed, seeds, and then requires: the same answers after
(no row, count, total, rank or hint changed); `get`, `update` and `delete` on the real id read exactly like the same call on `missingId` (same error code, status
and message, the requested id masked); no secret and no id in any result or error; the owner can still read the resource (so a non-owner write did not land) and
sees it in `list` (so the fixture is not vacuous). Tests: `packages/acl/src/leak.test.ts` (a clean toy plugin passes; a count before the filter, a forbidden-versus-not-found
answer, a search hint and an unchecked write each fail), `packages/db/src/repos/acl-leak.test.ts` (a Notes-shaped plugin on `filterSql` and FTS5 passes, and ranking before
the filter fails), and `modules/acl/access.test.ts` (the `acl.show|chmod|unshare` procedures over TCP pass).

## Confused deputy (principals)

A tool or operation never takes an actor argument. It resolves one with `createAclActors({ people }).of(ctx.principal)` (`modules/acl/actors.ts`), per call:
the **id** of the principal is the only field used; the person is read from the directory now (status and role), and `role`, `groups` or anything else
carried in the stored principal is ignored (the principal is durable in the inbox and in parked turns). A missing, unknown, suspended or removed person, a
username, and a guest id all resolve to `undefined`, and the work is refused (a guest has no path here until P17). Tools read `ctx.principal` from the
tool factory context (`tools: { name: (ctx) => tool(...) }`), because the setup context has none.

What `modules/acl/principal.test.ts` proves with scripted models and the SQLite adapters: a parked turn answered by the owner still checks as the one who asked; a wake
turn checks as the person whose session it wakes; a subagent and the wake turn that delivers its report check as the asker (inherited principal, ADR-0069); a person
suspended **after** their turn was queued is refused when it runs; and the dead-letter route (`compose-sessions.ts`) never serves a guest (a guest session id is only logged:
no notice reaches the owner or a guest front, and a person who is suspended or gone is only logged; ADR-0027 §20, F-049; `compose-sessions.test.ts`).

**ACL-changing tools always ask.** `aclGuard()` (`modules/acl/guard.ts`, mounted on the front agent and on every worker) is a `tool.approve` hook that answers
`user-approval` for `acl_share|unshare|chmod|chgrp|chown` and any tool named `acl_*`, from the tool name and a static table only (verification 5 of the plan:
`tool.approve` is re-run on re-validation, so it reads no live state). It can only ask, never approve or deny; the policy cannot waive it, and it is on top of the
step-up that a widening needs.

## Out of scope (P15)

Nested groups, live inheritance, relation-based access, per-field ACLs. The plugin host and the operations registry (P16). Guests
themselves (P17); this module only defines their ceiling. Moving `memory/` or sessions under the ACL.
