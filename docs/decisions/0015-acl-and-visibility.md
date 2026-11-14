# 0015. ACL and visibility: mode bits plus entries

Status: Accepted (2026-11-08). Builds on ADR-0009 (function-level capabilities stay) and ADR-0014 (the `Actor`). Plan: docs/plans/done/P15-acl-and-visibility.md. Amended by ADR-0020 (the four layers frame it) and ADR-0027 §6 (first-login notice, `audit.mine`).

## Context

Authorization today is function-level: a closed capability set per procedure (`ROLE_CAPABILITIES` plus `person_grants`, docs/specs/permissions.md).
Isolation of data is structural: `memory/<personId>/`, the session `front:<personId>`, per-person activity filters and budget scopes. Nothing can say
"this note belongs to Duta and Amel may read it". The owner wants Linux-like sharing (owner, team, public, plus named people and several groups),
private by default, usable by notes, reminders and later plugins. The agent is a confused-deputy risk: it acts for one person but reads content
written by others. eharness gives only an opaque `Principal` (ADR-0069) and a role-by-risk table in `eharness/identity`; it has no resource model.

## Decision

1. **A resource** is `(kind, id)` with an owner (a user), an optional group (its "team"), a `mode` of nine bits (`rwx` for owner, team, public) and
   a list of **entries** `(subject, bits, allow | deny)`. A new resource is `owner = creator`, no team, `0600`, no entries.
2. **Evaluation** is union then subtraction, with no I/O besides one membership lookup:
   suspended or left actor -> deny; `effective = owner bits if owner | team bits if member of the team | public bits | allow entries that match`;
   `effective &= ~deny entries that match` (deny always wins); for a guest, `effective &= GUEST_CEILING` (read on leaf and container, execute on
   operations marked public, never write). Allowed iff `effective` contains every wanted bit.
3. **Subjects:** `user:<id>`, `group:<id>`, built-in `@users` (every active user, no guests) and `@public` (everyone, guests included; it is the `public` class).
4. **Groups** are created and managed only by the owner, flat (no nesting). They are looked up at check time and are **never** stored in the
   principal (it is durable in the inbox and parked turns, so a copy would go stale). A user may `chmod` and `share` a resource they own, only to
   users and groups that exist, and cannot widen to `@public` without step-up and an approval of the action (below).
5. **Bits by kind.** Leaf (note): `r` read, `w` edit or delete, `x` must be 0. Container: `r` list, `w` create or delete children, `x` open a child by id
   (the child is checked too). Operation: `x` invokes (the guest allow-list). Action resource (reminder): `r` read, `w` edit, `x` let it fire.
6. **Visibility is enforced in SQL.** Lists, search, counts and cursors use a `visibleIds` subquery applied before ordering, limit, FTS ranking and
   counts. A denied read looks like "not found" (same error, same shape). Only someone who can already read learns they lack write.
7. **The owner is root, with a paper trail.** The owner may read any resource. Every owner access to another user's private resource is written to
   `audit_events` (`acl.owner-access`, actor, resource kind and id, never content), and this is stated in the member-facing docs and the first-login notice.
   This replaces the research recommendation of a separate break-glass flag.
8. **Confused deputy.** The agent acts with the principal of the session or turn that asked. Subagents, wake turns and scheduler fires keep the
   creator's or recipient's principal; a fire for someone who lost the right is skipped and audited. Tools and operations never take an actor argument.
   ACL-changing operations are always-ask via `tool.approve`, decided from the tool name and input only.
9. **Where it lives:** `packages/acl` (pure evaluator, a store port, an in-memory store for tests), a SQLite adapter in `packages/db`, contracts in
   `packages/contracts`. Keith-only (ADR-0011: not generic yet; ADR-0012 style, it can move later).
10. **The pending-owner-review queue** is not in this ADR; it is in ADR-0016 (it needs the operations registry). Reasoning is recorded there.

## Consequences

- The six cases are data: private `0600`; public read `0604`; users only `@users r` with public bits 0; groups A and B not C `allow group:A r`,
  `allow group:B r` (add `deny group:C r` when a broader share exists); Duta and Amel two user entries; Duta only one user entry.
- Every plugin pays one check per call and one subquery per list. The model is a degenerate Zanzibar tuple store and can grow into one.
- No live inheritance in v1: a container's defaults are copied at creation.
- A conformance test runs every plugin's operations with three actors (owner, outsider member, guest) and fails on any content or existence leak.
- Revisit when mail-based invitations exist, when nested groups are requested, or when a plugin needs relation-based access.
