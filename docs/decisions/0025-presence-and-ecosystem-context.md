# 0025. Presence and ecosystem context (parietal)

Status: Accepted (2026-11-10), design; build in P27 (presence, clients) and P28 (agenda, §2). New region `parietal` (ADR-0004). Feeds ADR-0024 (protocols) and ADR-0026 (rooms).

## Context

Keith should know what a person is doing and where they can be reached: which clients are connected, which one is in use, the last activity, the
device location when the person allows it, and what they said they would do ("meeting at 9", "flying to Tennessee tomorrow"). It should use this
to choose a channel (show a visual on the web client that is in use, send a notification to the phone) and to answer "what is the owner doing?"
without leaking more than the owner allows.

## Decision

1. **Signals** are facts with a time and a source: `client.connected|disconnected`, `client.active` (input in the last N seconds),
   `device.location` (coarse, opt-in), `node.event`, `activity` (a turn, a command). Clients report them through `@keith/client`; each client
   registers a **client record** (`id, person, kind: tui|web|mobile, capabilities, lastActiveAt`). Raw signals are kept for 7 days.
2. **Intentions** are what a person said they will do, extracted by the front agent into the person's **agenda** (`what, when, where?, source
   message`), confirmed in the chat when unsure. The agenda is personal data (ADR-0020, personal layer).
3. **Presence** is computed in code from signals and agenda: `state: active | idle | away | busy | offline`, `reachableOn: [client ids]`,
   `activeClient`, `note` (for example "in a meeting until 10:00"). It is recomputed on every signal and every minute.
4. **Disclosure is a rule, not a prompt.** Each person sets what others may know, per audience (`owner`, `group:<id>`, `@users`): `none`,
   `state` (busy or available), `detail` (the note). The default: the owner sees `detail` of everyone (audited like any owner access), members
   see `state` of each other and of the owner. Only the disclosed presence line enters another person's model context.
5. **Routing uses presence.** "Send it to my phone" or a protocol `notify` picks `activeClient`, then the most recent reachable client that has the
   needed capability (ADR-0023, client capabilities), then queues for the next connection.

## Consequences

- Keith can answer "is Duta free?" safely and route visuals to the screen the person looks at.
- Needs client registration and heartbeats in `@keith/client` and the TUI now, mobile and web later; location stays off until a mobile client exists.
- Agenda extraction costs model tokens; it runs in the front turn that already reads the message, no extra call.
- Revisit for shared calendars or when presence must be inferred across several people (a room's "everyone is here").
