# Phase 5: People + collaboration (overview)

> Task files are in [phase-5-people/](phase-5-people/README.md). This overview is kept for history.

**Goal:** several people use one Keith. Each has a private relationship, they can pass messages through Keith, and they can collaborate in a group thread (S-4 privacy, S-5, S-6).

## Lanes (sketch)

| Lane | Work |
|---|---|
| 0 (contract) | Additive protocol: `thread.invite`, participant fields in frames, a `ThreadDto` list for the group UI, relay attribution in `MessageDto` |
| A | People: `keith person add`, invite links, member/guest tiers, relationship card editing, blocking relays |
| B | Relay: `relay.send`, I-13 checks, attribution in delivery turns |
| C | Group threads: `thread.start_group`, `thread.invite`, `thread.leave`, invitations as deliveries, human-to-human fan-out without an LLM turn, author names in `LlmMessage.name` |
| D | Addressing detector: rule-based pass plus `utility`-model fallback, a "don't interrupt humans when unsure" policy, tests from a transcript corpus |
| E | Visibility everywhere: `thread` visibility, group viewer intersection audit across context builder, digest, recall and task results |
| F | Clients: group thread UI in web and TUI (participants, authors) |
| I | Integration + S-4 privacy, S-5, S-6 e2e |
