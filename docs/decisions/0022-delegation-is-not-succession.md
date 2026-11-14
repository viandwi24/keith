# 0022. Delegation is not succession

Status: Accepted (2026-11-10). Amends ADR-0009 (grants) and docs/specs/permissions.md for `people.manage`. Fixes flow-review finding F-001 (owner
answer OWN-015). Succession runs on the protocol engine of ADR-0024. Plan: P21 (delegation limit, done), P29 (succession protocol).

## Context

`people.manage` can be granted to a member. That member, after a step-up with their own PIN, could reset the owner's password, rename the owner
and call `transferOwner`, which is a takeover (proved by `proof-tests/F-001.proof.ts`). The owner does want two real things: a trusted person
(their spouse) who helps manage the household's accounts, and a way for that person to inherit Keith if the owner is gone, but only through an agreed protocol.

## Decision

1. **Delegation acts on members only.** A grant never lets its holder act on the owner. Every `admin.people.*` call whose target is the owner
   (password, PIN, unlock, clear secret, rename, aliases, grants) needs the owner role; so do `transferOwner` and any grant or revoke on the
   caller themselves. The check sits in the people service (same pattern as `notOwner`), not only in the RPC gate, so every path (RPC, socket,
   CLI) gets it.
2. **Ownership changes in exactly two ways.**
   - **Hand-over:** the owner calls `transferOwner` (owner role, step-up). Unchanged, plus a check that the target can sign in (has a password
     or PIN), which closes F-013.
   - **Succession:** a protocol (ADR-0024) the owner sets up in advance. It is the only way ownership moves without the owner acting.
3. **The succession protocol** (`owner-absence`, built in, off until the owner names an heir):
   - The owner names one heir (an active member) and may change or remove them at any time; this is audited.
   - Keith tracks the owner's last sign of life (any authenticated activity on any client, a presence signal, an answered check-in).
   - **Day 1 without a sign:** Keith checks in on every channel it has (each client, push when mobile exists, a node notification). Then daily.
   - **Day 14 without a sign** (default, owner may set 7 to 90): Keith starts a **grace period** of 7 days, tells the heir that the protocol
     started and tells the owner on every channel that ownership will move. Any owner sign cancels it.
   - **End of grace:** the heir may **claim** with their own credential plus step-up. The claim calls the same transfer as a hand-over, writes an
     audit row `owner.succession`, keeps the previous owner as a member (suspended, not removed) and never reveals the previous owner's secrets.
   - Nothing happens automatically at the end of grace; the heir has to claim.
4. **Recovery stays offline.** `keith-core token recover` on the machine (ADR-0008) remains the break-glass path for whoever controls the host.

## Consequences

- A spouse can still manage the children's accounts; they can no longer quietly become owner.
- Succession needs presence signals and the protocol engine first, so it lands in P29; the delegation limit lands now (P21).
- An owner who is away longer than the window without signing in must tell Keith (pause the protocol) or accept the check-ins.
- Revisit for several heirs, a quorum of members, or a legal hand-over document.
