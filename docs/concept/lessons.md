# Lessons from Kehai

Kehai was Keith's predecessor: the same vision, built on Bun/TS with a server plus nodes. It stalled under its own weight. Each lesson below became a rule, and the rule shows up somewhere else in these docs.

| # | What happened in Kehai | Rule for Keith | Where enforced |
|---|---|---|---|
| L-1 | Brain anatomy (CEN, DMN, cortex…) became module boundaries, so structure was built before any need existed. | Metaphors describe behavior. They never name folders or packages. | [conventions.md](../rules/conventions.md) |
| L-2 | Abstractions came before second implementations: `plugin-database` (types only), a Postgres driver, storage adapters, a full lifecycle. | No new abstraction or package without a second real consumer. Exceptions need an ADR (LLM and voice have one). | [engineering.md](../rules/engineering.md) R-6, [ADR-0007](../decisions/0007-adapters-only-with-two-implementations.md) |
| L-3 | The MVP ("owner chats in a browser") didn't test what made Kehai different. Proactivity, commitments and background work were all post-MVP. | Phase 1 must prove the differentiator: *promise → background task → unsolicited delivery → remembered next day*. | [roadmap.md](../plans/roadmap.md) |
| L-4 | A CEN + DMN pair per user contradicted "one awareness". | One Mind. A Relationship is the per-person face. | [model.md](model.md) I-1 |
| L-5 | `chat` vs `voice` "protocols", one active session per user, and explicit takeover made a state machine nobody needed. | Modality per message. Focus is the node with the latest input. | I-6, I-7, [ADR-0003](../decisions/0003-modality-per-message-and-focus.md) |
| L-6 | Web was a special node with its own port and a configless `apiUrl` override. Plugins wanted to depend on web to show UI. | Web is a `client-app` plugin on the core's port. Plugins emit UI blocks and never depend on web. | I-8, I-9, [ADR-0002](../decisions/0002-plugins-run-in-core-nodes-do-not.md) |
| L-7 | Plugin `depends` + `contributes` + a four-phase lifecycle + topological sort. | Plugins provide and consume **services** and publish **events**. Lifecycle is `setup` / `start` / `stop`. | [ADR-0005](../decisions/0005-services-for-requests-events-for-facts.md) |
| L-8 | The architecture doc drifted from the code and needed a "design vs reality" sync note. | Docs describe the code. Unbuilt parts are marked `> Planned (phase N)`. Docs change in the same commit as behavior. | [engineering.md](../rules/engineering.md) R-16 |
| L-9 | Coupling to the AI SDK's loop ("never hand-roll loops, it breaks the message protocol") meant the loop wasn't Keith's. Interrupts, deliveries and scheduling all need to own it. | Keith owns the agent loop. Providers are streaming adapters. | [ADR-0004](../decisions/0004-keith-owns-the-agent-loop.md) |
