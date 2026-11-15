# Specs

One spec per core module or package: `docs/specs/<module>.md`. A spec is the contract of the
module (inputs, outputs, events, errors, invariants). Changing behaviour means changing the spec
in the same commit. Write the spec and the `packages/contracts` change before the code.

## Index

- [hypothalamus](hypothalamus.md): protocols (data, triggers, conditions, steps, limits), the engine, authoring rules, proposals, the agenda, audit kinds, events, settings and ports (P28).
- [web](web.md): the browser client `apps/web` (SvelteKit SPA at `/app`): sign-in with the cookie, shell, chat, approvals and step-up, Home and the orb, screens, Manage, plugin views, the guest page, PWA and push, tests (P38, ADR-0035).
- [app-model](app-model.md): `packages/app-model`, the framework-free logic the TUI and the web share (chat items, tool lines, approvals and consent, step-up, presence, style, rooms, Manage section models) (P38).
- [push](push.md): Web Push: subscriptions, the VAPID key pair (sealed in the vault), the RFC 8291 sender, the neutral payload, failure handling and the push route of the reach ladder (W9, ADR-0035).
- [succession](succession.md): the owner's heir, the `owner-absence` protocol, grace, the heir's claim and the suspended previous owner (P29, ADR-0022 §3).
- [corpus-callosum](corpus-callosum.md): shared rooms, the group call with Keith: members, the room session and one principal per turn, the window, private requests, control and removal, the room ACL kind, audit, transport, RPC (P30, ADR-0026).
- [node-drivers](node-drivers.md): the capability model of the nodes, manifest v1 and v2, the driver package and `keith-node driver`, the desktop and sandbox drivers, client capabilities, workspace references, errors, audit (P31, ADR-0023).
- [prefrontal](prefrontal.md): persona (versioned, from templates, owner step-up), per-person style and its guard, prompt assembly, answer modes and the speakable guard, document hand-off, report mode, fixed lines, audit, removal, RPC (P33, ADR-0029).
- [chat-context](chat-context.md): the front session chain and its generations, `/new` and `/compact` (refusals, flush, switch, old transcripts), RPC, boot, removal, audit, activity, TUI, tests, eharness harness check (P34, ADR-0030; built).
- [dreaming](dreaming.md): memory consolidation of one person (ADR-0031, P35): tiers, collect, judge, applier rules, modes, scheduling, flush, retention, removal, RPC, TUI; built in P35.
- [activity-logs](activity-logs.md): the model-call log per session (ADR-0032, P36): session kinds registry and id rules, capture on `model.call`, tables, redaction, size, settings, retention, removal, rights (`canReadSession`), RPC, CLI, TUI, audit kinds, eharness harness check; design, built in P36.
