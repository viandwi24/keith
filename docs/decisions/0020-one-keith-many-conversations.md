# 0020. One Keith, many conversations: four layers of awareness

Status: Accepted (2026-11-10). Frames ADR-0015 (ACL and visibility) and ADR-0017 (guests); detailed by ADR-0021 to ADR-0026. Source: the owner's
vision after the flow review of 2026-11-09 (owner answers OWN-010, OWN-011, OWN-014, OWN-015).

## Context

Keith is the owner's personal assistant, modelled on a personal assistant from fiction: one mind that talks to the owner and to the people the owner lets in, each
in their own way, and that can coordinate a team when asked. The code so far isolates people well (one front session per person, memory per
person, activity filtered per person, owner access audited), but a few parts are shared without a decision (one worker workspace for everyone,
nodes without an owner, the owner's attention queue). The flow review found that most open questions (F-002, F-005, F-017, F-018) come from this
missing model, not from single bugs. The other risk is the language model itself: anything placed in a model's context can be repeated, so a
prompt is never a privacy boundary.

## Decision

1. **Keith has four layers of awareness.**

   | Layer | Holds | Owned by | Who sees it |
   | --- | --- | --- | --- |
   | Self | nodes, capabilities, tasks, protocols, Keith's own notes | the owner | the owner; members see what a capability grants (e.g. `nodes.read`) |
   | Personal | one conversation per person, their memory, workspace, agenda, presence | that person | that person; the owner with an audit row (ADR-0015) |
   | Shared room | a group call: members, recent activity, a room workspace | the room's members | the room's members while they are in it (ADR-0026) |
   | Ecosystem | the person's clients, devices and signals | that person | that person; others only through presence disclosure (ADR-0025) |

2. **Isolation is enforced by code, disclosure is a policy.** Data of one layer never enters a model context that runs for another principal
   unless a rule in code put it there on purpose (a room's window, a disclosed presence line, a shared resource that the ACL allows). Keith may
   then speak about it. The model is never asked to keep a secret that it can read.
3. **Every model turn runs as exactly one principal**: the person who spoke (front session, room turn) or the person a protocol acts for. Tools,
   ACL checks, budgets and audit rows use that principal. A turn never borrows another person's rights because their words are in the context.
4. **The owner keeps control.** Members are people the owner invited; the owner can see, stop and remove anything, and every such access to a
   member's private layer is audited. Delegated rights never reach the owner's own account or ownership itself (ADR-0022).
5. **New brain regions** (ADR-0004 naming) carry the new layers: `hypothalamus` (protocols and proactive behaviour, ADR-0024), `parietal`
   (presence and ecosystem context, ADR-0025) and `corpus-callosum` (shared rooms, ADR-0026). Workspaces stay in `cortex` (ADR-0021).

## Consequences

- Each open review question gets one rule: F-002 per-owner workspaces, F-005 owner self-share stays (the share is the audited act), F-017 nodes
  are Keith's body (self layer, readable with `nodes.read`), F-018 audit rows about a member become visible to that member.
- New features must say which layer their data belongs to; a feature that needs two layers needs an explicit bridge (a room, a disclosure rule).
- Cost: more plumbing than "one big shared context", and some answers are "I can tell you only that Duta is busy".
- Revisit when Keith runs on several cores (a distributed self layer) or when a member asks for data the owner should not see at all.
