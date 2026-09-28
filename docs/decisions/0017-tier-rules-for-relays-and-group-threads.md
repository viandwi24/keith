# ADR-0017: Tier rules for relays, group threads and invite links

- **Status:** proposed
- **Date:** 2026-09-28
- **Rules/invariants affected:** I-3, I-4, I-13, R-14

## Context

Phase 5 lets several people use one Keith ([phase-5 plan](../plans/phase-5-people/README.md)). I-13 says a relay happens only if "the sender's tier allows it", but no doc says which tiers allow what. S-6 says invitees join "on accept (or auto-join, if config and tier allow)" and that a leaver "keeps the history up to that point", which can be read two ways. These rules fix the `minTier` of five new built-in tools, the checks inside the relay and group services, and who may read a group after leaving. P5-K1 writes the tool specs and the lanes implement the checks in parallel, so the rules must be settled before P5-K1 starts. Otherwise two lanes would pick them differently.

## Decision

**Relays (I-13)**
- `relay.send` has `minTier: 'guest'`. Owners and members may relay to any other person. A guest may relay only to the owner.
- A relay is refused when the recipient's `relationships.blocked_relay_from` names the sender. The block wins over every tier.
- Nobody relays to themselves.
- A refusal never says which rule refused it: the tool answers "I can't pass messages from you to <name>." for a tier refusal and for a block alike. An unknown name answers "I don't know anyone called <name>."
- `relay.block { from }` and `relay.unblock { from }` have `minTier: 'guest'`. They change only the caller's own relationship. The owner can also change anyone's list with `keith person block` / `unblock` (CLI).
- The owner's relays can be blocked too. No tier is exempt from a block.
- A relay is surfaced as a `relay` delivery authored by the sender. The recipient always sees the sender: the delivery turn's message carries `meta.relayFrom`, and the context labels the item with the sender's name.
- A relay writes no memory. The text reaches later contexts only through the recipient's thread history.

**Group threads**
- `thread.start_group` and `thread.invite` have `minTier: 'member'`. Owners and members may start groups and invite, guests may not. Anyone, guests included, may be invited, and `thread.join` and `thread.leave` have `minTier: 'guest'`.
- Only a current participant may invite to a group, and only while the group has fewer than `mind.group.maxParticipants` (default 8) current participants plus pending invitations.
- The creator has no special rights after creation. Every current participant with tier `member` or higher may invite. Nobody can remove another participant in v1.
- An invitee joins by accepting (`thread.join`). With `mind.group.autoJoin = true` (default false), an invitee with tier `member` or higher joins at once and still gets the invitation delivery as a notice. Guests always accept explicitly.
- `thread.leave` in a group removes the caller (sets `left_at`). On a pending invitation it declines it.
- **After leaving**, the leaver has no access to the group: it leaves their thread list, and `thread.open` and history requests for it answer as for any thread they are not part of. The group keeps its whole history, the leaver's messages included. `thread` memories of the group stay readable to the remaining participants (I-4 already says so, because `thread` visibility counts current participants only). Someone invited again sees the whole history, like any new participant.
- In a group, the rules that already exist stay as they are. Tools are filtered by the lowest tier among the current participants (a guest in the group limits everyone's tools). Memory reads admit only what every participant may see (I-4). `memory.remember` and reflection write `thread`. A guest in the group makes the awareness digest counts-only.

**Invite links**
- Only the owner creates invite links (`keith person add`, `keith person invite`, which run on the host). A link is single-use and expires after `auth.inviteTtlHours` (default 72). Only its SHA-256 hash is stored, like auth tokens (R-14).
- A new link for a person revokes their older unused links. Accepting a link sets the person's username and password and returns a session, like a login. A wrong, used or expired code answers `401 UNAUTHORIZED`, the same answer for all three.
- Exactly one person has tier `owner`. `keith person tier` sets only `member` or `guest`, and never changes the owner.

## Consequences

- P5-K1 can write every tool spec with its final `minTier`. P5-B1 and P5-C1 implement the checks against this list, and P5-I2 tests them end to end.
- Guests can still reach the owner ("tell Tony the kids are asleep"), but they can't spam other people or build groups.
- Former participants lose access. A read-only view of the history up to the moment they left (one reading of S-6) is not built. It would need its own access rule in the server and storage, and a later ADR.
- Nobody can remove another participant from a group. A person who misbehaves in a group is handled by the owner outside Keith, or by deleting the person ([ADR-0018](0018-deleting-a-person.md)).
