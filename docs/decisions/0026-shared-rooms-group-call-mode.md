# 0026. Shared rooms: group call mode (corpus callosum)

Status: Accepted (2026-11-10), built in P30. Amended by the P30 design: the control tools only create a request that a human confirms, and a room has a state `open` while invitations are out. New region `corpus-callosum` (ADR-0004). Uses ADR-0020 (layers), ADR-0021 (room
workspace) and ADR-0025 (presence).

## Context

The owner wants a "group call" with Keith: the owner (or a member) starts a call with one or more people; everyone in it talks to the same Keith,
which shares recent activity among them, like a fictional assistant helping the whole team in a fight. The initiator and the owner keep control: they can end the
call or remove someone; anyone can leave by saying so. There is no audio or video yet; the first version shows an indicator and relays text.
The risk is a shared model context with several principals: one person's words could make Keith act with another person's rights.

## Decision

1. **A room** is `id, initiator, members[], state (active | ended), window (minutes and events), workspace (rooms/<id>/), transport`.
   Only people with `rooms.start` (owner, and members it is granted to) may start one; invitees accept or decline.
2. **One room session, one principal per turn.** Each message carries its speaker; the turn runs as that speaker. The eharness session lock
   serialises turns, so Keith answers one speaker at a time in order.
3. **Room-scoped tools only.** Inside a room Keith gets: `room_say` (relay or announce), `room_presence` (disclosed presence of members),
   `room_activity` (the window), room workspace files, `room_leave` (speaker leaves), and for the initiator or owner `room_remove`, `room_end`.
   Personal tools (memory, notes, nodes, shell, plugin operations) are not loaded. A request that needs them is answered with "I will do it in your
   own chat" and becomes a task in the speaker's personal session with their own rights; the result is posted to the room only if that person agrees.
4. **Shared awareness is a window, not memory.** The room context holds the last N minutes or events of the room (default 30 minutes, 200 events),
   the members' disclosed presence and the room workspace listing. No personal memory, agenda or private resource is loaded. When the room ends,
   its transcript and workspace are kept for the members (ACL resource of kind `room`), never merged into anyone's memory.
5. **Control follows the speaker's principal, decided in code.** `room_leave` affects only the speaker; `room_remove` and `room_end` need the
   initiator or the owner; the owner may also end any room from the TUI. The model only chooses which tool to call; the tool checks the right.
6. **Transport is an adapter.** `RoomTransport` (`join, leave, say, indicator, end`) has a text and indicator implementation now (TUI banner and
   messages). Audio and video are later adapters behind the same contract (`packages/contracts`).

## Consequences

- Team coordination without breaking personal isolation: a room only ever sees what was said or disclosed in it.
- A room cannot be used to borrow rights (no personal tools in the room), at the cost of a hop to the personal chat for real actions.
- Needs: room store, room session plumbing, TUI banner and room view, contracts, audit kinds `room.*`.
- Revisit when voice arrives (turn-taking by audio activity) or when a protocol must open a room on its own (for example an alarm that calls the family).
