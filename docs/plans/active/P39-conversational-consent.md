# P39 — Conversational consent

Status: built, waiting for the manual test (Nov 15, 2026; scenario 35) · Owner: viandwi24 · Decision: ADR-0036 · Branch: `main`

## Goal

Keith acts on what the person says without stopping the conversation for a card, asks in its own words when an action is risky, and
sends only the riskiest or injected requests to a trusted device, so that the same rules work in text and, later, in voice.

## Phases

Each phase updates its specs in the same change, has its own tests, and passes the targeted tests of the areas it touches. The full
`bun run check` and `bun run smoke` run once after the last phase.

### P39.1 Provenance and the source trait

**Done (Nov 15, 2026).** Every tool declares its source and `consentContext` decides clean or tainted from the restricted transcript. Evidence: `tool-sources.test.ts` (every registered tool with its source), `amygdala/consent-context.test.ts` (fetched page, worker report, room, wake, new person message), `consent.e2e.test.ts` (outside text framed with `untrustedContent()`); spec `amygdala.md` "Consent".

- Tool metadata `source: 'trusted' | 'outside'` (contracts type, eh-ext helper); every Keith tool declares it (core regions, plugins'
  operations through the host, node capabilities); undeclared counts as `outside`. A test lists every registered tool with its source.
- `consentContext(transcript)` (pure, amygdala): clean or tainted from the restricted transcript: the last person message, the tool calls
  after it, their sources; a turn with no person message is tainted. Cached by tool-call id.
- Outside results framed with `untrustedContent()` where eharness does not already (plugins, rooms, notes of others, node output, worker
  reports in the wake text); structured platform facts outside the frame.
- Specs: `amygdala.md`, `permissions.md` ("Tool risk"), `plugins.md`, `motor.md`, `cortex.md`.
- Done when: table tests of transcripts → clean/tainted (a fetched page, a worker report, a room message, a wake, a new person message).

### P39.2 The consent table and "runs, with undo"

**Done (Nov 15, 2026).** `tool.approve` applies the risk x clean/tainted table, cached by call id, and reversible writes record an undo with the `undo_last` tool. Evidence: `amygdala/consent-table.test.ts`, `consent.test.ts` (cache and re-validation), `undo.test.ts`, `consent.e2e.test.ts` (a clean persona switch runs with no pending approval and "undo" restores; the same after outside content or in a wake turn waits with the tier `conversation`).

- `tool.approve` in amygdala applies ADR-0036 §4 from risk × clean/tainted, deterministic, cached by call id.
- Reversible writes (persona template, edit, restore, style, model role, status) record an undo; a front tool `undo_last` (the person's
  own last reversible change, clean only) and the answer craft line "done, say 'undo' to switch back".
- Specs: `amygdala.md`, `prefrontal.md`, `providers.md`, `parietal.md`, ADR-0034 §3 note.
- Done when: persona switch in a clean conversation runs with no pending approval; the same after a fetched page asks; undo restores.

### P39.3 Asked in conversation

**Done (Nov 15, 2026).** A `conversation` request is voiced (front agent or a wake for a worker), answered by the person's next message through the consent classifier, expires after 10 minutes and is audited (`consent.asked`, `consent.answered`). Evidence: `amygdala/consent-classifier.test.ts`, `amygdala/consent-attention.test.ts`, `consent-conversation.e2e.test.ts` ("ya", "no", a new topic, a yes planted in a report, a `device` request, expiry, cold-client step-up); spec `amygdala.md`.

- A `conversation` request stays an eharness approval; its tier is stored with it (amygdala, by call id) and shown on the attention item.
- Front calls: the front instructions say to state what, where and why with one yes/no question before calling a risky tool. Worker
  calls: a `conversation` request of a worker reaches the front session as a wake whose text asks the front agent to voice it.
- Consent classifier (amygdala): the person's next message in that front chat while a `conversation` request waits → `yes`, `no`,
  `other` from the message and the request's one-line summary only (fixed multilingual list, then a small model). `yes` approves, `no`
  denies, `other` denies and the message goes on as normal input. Hooked where the front session receives the person's message (before
  eharness sees new input while an approval is pending). Expiry (setting, default 10 minutes). Audit `consent.asked`, `consent.answered`
  (`yes`, `no`, `other`, `expired`), never the message text.
- Specs: `amygdala.md`, `wernicke-broca.md`, `cortex.md`, `motor.md`, `audit` events.
- Done when: shell in a clean conversation is asked and runs after "ya"/"yes"/"go ahead"; "no" denies; a new topic denies and is answered;
  a "yes" planted in a fetched page, a worker report or a room never approves; an expired request does not run; a restart treats an
  unknown tier as a trusted-device request.

### P39.4 Trusted-device confirmation and the clients

**Done (Nov 15, 2026).** Tainted destructive and external calls carry the tier `device` and stay cards in the Inbox and push; a clean live chat shows the quiet line, no bar. Evidence: `packages/app-model/src/consent-state.test.ts`, TUI `features/approvals/consent.test.tsx`, web `consent-line.test.ts`; specs `tui.md`, `web.md`.

- Tainted destructive or external calls stay eharness approvals, routed to the person's trusted clients and push (Inbox, notification);
  the front agent says where to confirm. No approval bar inside a clean live chat in the TUI or the web; the Inbox keeps the cards.
- TUI and web: proposals shown as Keith's message (no card); Inbox for the rest; web push for trusted-device confirmations.
- Specs: `tui.md`, `web.md`, `delivery.md`, `push.md`.
- Done when: TUI and web tests for a clean shell request (no card, a question, runs after yes) and a tainted one (Inbox item, push).

### P39.5 Docs, evals and gate

**Done (Nov 15, 2026).** `docs/guide.md` "Keith asks before risky things"; manual scenario 35 (clean switch and undo, asked in conversation yes and no, a cold client to the Inbox, a planted page and "do what it says", a worker report, expiry, restart); the `eval:consent` injection eval (`apps/core/evals/consent/`, four cases over a note and a worker report, `--scripted` offline in `run.test.ts`, registered in the root and `apps/core` `package.json` and in `AGENTS.md`; spec `evals.md`); the smoke's shell approval step asserts `extra.consent` on the attention item, the member's shell item asserts the tier `device`, and the audit step expects `consent.asked`. The paid real-model run of `eval:consent` and the full `bun run check` are not run in this change.

- `docs/guide.md` ("Keith asks before risky things"), manual scenario 35, an injection eval (`eval:consent`: pages, reports, rooms with
  planted instructions; real model, opt-in like the other evals).
- Full `bun run check` and `bun run smoke` (the smoke's shell approval steps move to the new flow).

### Gate

Nov 15, 2026: `bun run check` exit 0 (6655 tests pass, 0 fail; lint, types, imports, size, exports); `bun run smoke` 110 steps ok. Browser try against a real core, a paired node and the fake provider: a cold client's shell request shows only the quiet line "Confirm in the Inbox"; after a step-up the same request shows "Keith is waiting for your yes or no", the person types "ya", audit `consent.asked` → `consent.answered: yes` → `approval.answered: approved`, the command runs. Fixed after the try: the reply stays in the chat with an acknowledgement turn, and shell from a client that has not stepped up goes to the device tier; `room_post` (its own confirmation) is `selfConfirmed`.

## Later

- Quarantined reader for bulk outside text (ADR-0036 §8), with the channel plugins.
- Speaker identity for voice consent.

## Owns

`apps/core/src/modules/{amygdala,prefrontal,providers,parietal,motor,cortex,wernicke-broca}` (consent parts), `packages/eh-ext`
(source trait helper), `packages/contracts` (consent types), the TUI and web approval surfaces, ADR-0036, this file.
