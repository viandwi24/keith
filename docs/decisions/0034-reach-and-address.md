# ADR-0034: Reaching the person, and how Keith addresses them

> Amended by ADR-0036 (conversational consent): §3 "persona tools wait for approval" holds only when the conversation is tainted.

Status: accepted (Nov 14, 2026). Plan: `docs/plans/active/P37-reach-and-address.md`. Builds on ADR-0024 (delivery), ADR-0025
(protocols and agenda), ADR-0029 (persona and answer modes) and ADR-0033 (client context).

## Context

A good personal assistant does more than answer. It knows whether the person is at their desk, on the move or out; it decides how and
when to reach them; it waits when they are busy and says why when it cannot wait; and when they come back it briefs them on what
happened. It also speaks to each person the way they want to be spoken to, starting from its character.

Keith has most of the parts. Presence computes `active`, `idle`, `away`, `busy` and `offline` from each client's activity and has
overlays (a manual busy status, the agenda). The delivery service delivers the proactive messages of protocols, plugins and reminders exactly once, through a route planner that tries the active client, the other clients, then the front session, with a
`push` slot for routes outside the clients. Protocols have `quietHours` and `urgent`. The persona is versioned and the per-person
style has an `address` field. What is missing is the policy that ties them together, and a way to set all of it in conversation.

## Decision

1. **Answer craft is a core rule, not a persona trait.** Every persona answers the same way in substance: the point first (the action,
   then the reason, then the deadline); a briefing as a count, then each item with rounded figures and something to compare them with,
   then one closing line; a done action confirmed in two to four words; after a refusal, the key fact once more and one yes/no next
   step; a proactive message that says first why it interrupts. These rules live in the front agent's static instructions, so they are
   cached and the same for everyone. "Let me check" before a slow tool is said only in speech mode.

2. **The address comes from the persona, the person can override it, and it lives in the style, never in memory.** A template's
   `addressing` names the default form (butler: "sir" or "madam"; friend: the first name; professional: the name). The person's style
   `address` overrides it. Memory holds facts about the person; the style holds how Keith behaves toward them, validated, audited and
   visible (ADR-0029 §3: memory never sets a style). A butler that does not yet know which form a person wants uses their name.

3. **Persona and style are set in conversation too.** The front agent gets tools: `style_get` and `style_set` (the speaker's own style),
   and for the owner `persona_get`, `persona_template`, `persona_edit` and `persona_restore`. A persona change waits for the owner's
   approval in the approval bar, and answering it from a remote client needs a step-up, like every persona change (ADR-0029 §2). The
   commands and the Manage screen stay.

4. **Onboarding is a conversation.** A person without a stored style is onboarded in their first conversation: Keith asks how to
   address them, their language and how long answers should be; the owner is also asked which persona to use. Saving the style ends it;
   "skip" saves the defaults. Keith never asks again unless asked.

5. **Presence knows what the person said.** A person can state, in chat, that they are `out` (away from their desk, reachable on a phone
   or chat) or `busy` (do not disturb), from a time and until a time (`presence_status_set`, the speaker's own status only). A confirmed
   agenda item stays a `busy` overlay. Presence adds a `where` hint, derived from facts and never shown as a place: `desk` (the active
   client is a computer on the local socket, loopback or LAN), `mobile` (the active client is a phone or the network is public), `out`
   (stated or from the agenda), `unknown`.

6. **The planner reaches the person by state, where and urgency** (the reach ladder). Active or idle at the desk: the active client
   (toast), the front session as the fallback. Busy: a normal message is held until the busy status ends; an urgent one is delivered at
   once and its first sentence says why. Out, away or offline: a normal message is held for the return digest; an urgent one goes to
   every online client and the front session, and to the `push` routes once a channel plugin (a phone, a chat app) fills them. A
   protocol's quiet hours keep applying as they do today.

7. **Held messages wait in the deliveries table, not in memory.** A held delivery has the status `held` and keeps its text; nothing else
   reads it. When the person comes back (presence leaves `away`/`offline` for `active`, or a stated `out` or `busy` ends), the delivery
   service releases every held delivery of that person as **one digest**: one wake turn of the front agent that receives the held items
   and briefs the person in their language and address, following rule 1, plus one notice to the active client. Each released delivery
   becomes `delivered` with the route `digest`. This works on a fresh install with no protocol to write.

8. **The owner can switch a role's model in chat** (`model_role_set`): owner only, waits for the owner's approval, step-up from a remote
   client, the same rule as `keith-core model set`.

9. **Not now:** phone calls, chat apps, speaking for the owner to third parties, smart-home control and business data sources are
   plugins and come later; this decision leaves the `push` routes and the protocol triggers ready for them. Arriving home already works
   with a protocol on the `brain.parietal.presence` event and `open.view`; the guide shows it.

## Amendment (Nov 14, 2026, during P37.5)

A delivery the person asked for or set for a time is never held: `needs.immediate` (a room handoff of their own request; a reminder
through `ctx.wake({ immediate: true })`). A reminder exists to arrive on time, so holding it for the return digest would defeat it.
Note-mode deliveries (failure notices, protocol notes, the owner's test notice) are never held either.

## Consequences

- The presence status gains a kind (`out` next to `busy`) and a start time; the `presence_status` table gets a `from` column (migration).
- The deliveries table gains the `held` status (no schema change; `reason` names why it is held).
- A held delivery is not retried on a timer; it waits for the person's return. A delivery held longer than 7 days is released into the
  front session as a plain note, so nothing is held forever.
- Onboarding adds a turn-reminder line only while the person has no style; nobody else pays for it.
- A wrong `where` hint costs a less suitable route, never a lost message: the front session is always the last route.
- A worker's report wakes the front agent through the subagent inbox, not the delivery service, so it is not held: it lands in the
  chat when the task ends. Routing it through the ladder is a later change.
