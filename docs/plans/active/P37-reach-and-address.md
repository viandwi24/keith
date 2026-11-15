# P37 — Reach and address

Status: built, waiting for the manual test (Nov 15, 2026; scenario 33; amended by ADR-0036 for persona and model approvals) · Owner: viandwi24 · Decision: ADR-0034 · Branch: `main`

## Goal

Keith reaches each person the way a good assistant would: it knows whether they are at their desk, on the move or out, waits when
they are busy, says why when it cannot wait, and briefs them when they come back. It answers with the same craft in every persona,
addresses each person the way their persona and their own choice say, and both can be set in conversation.

## Phases

Each phase updates its spec in the same change, has its own tests, and passes the targeted tests of the areas it touches. The full
`bun run check` and `bun run smoke` run once after the last phase.

### P37.1 Answer craft and persona addressing (ADR-0034 §1, §2) — done

Evidence: rules in `FRONT_INSTRUCTIONS`, "let me check" in `SPEECH_TEXT`, butler/friend/professional addressing and butler attitude; targeted tests prefrontal, wernicke-broca and the leak e2e pass.

- Front static instructions (`wernicke-broca/agent.ts`, `FRONT_INSTRUCTIONS`): the answer-craft rules of §1. The speech-mode block
  (`prefrontal/prompt.ts`) adds "say a short 'let me check' before a slow tool".
- Templates (`prefrontal/templates.ts`): `addressing` per §2 (butler: "sir" or "madam" once the person's choice is known, their name
  before that). The butler's `attitude` adds: calm when the person is upset, at most one line of humour after the facts, never argues.
- Specs: `wernicke-broca.md`, `prefrontal.md`.
- Done when: a test reads the rules in the instructions; the template tests read the new addressing.

### P37.2 Persona and style in conversation, onboarding (ADR-0034 §3, §4) — done

Evidence: `prefrontal/persona-tools.ts`, `onboarding.ts`, `STEP_UP_TOOLS` and the `canAnswer` step-up; `persona-tools.test.ts` and `amygdala/step-up-tools.test.ts` pass.

- Front tools (prefrontal plugin): `style_get`, `style_set` (the speaker's own style, the same validation and audit as `persona.style.set`),
  and owner-only `persona_get`, `persona_template`, `persona_edit`, `persona_restore` through the persona service. Persona tools wait for
  approval (`tool.approve` → `user-approval`); answering them from a remote client needs a step-up (`amygdala/attention.ts canAnswer`).
- Onboarding: while the speaker has no `person_style` row, the turn reminder carries an onboarding block (ask address, language,
  brevity; the owner also the persona); `style_set` ends it, "skip" stores the defaults.
- Specs: `prefrontal.md`, `amygdala.md`, `permissions.md` if a capability is involved.
- Done when: tests cover each tool (own style only, owner-only persona, approval, step-up from remote), the onboarding block appearing
  only without a style row, and ending after `style_set`.

### P37.3 Stated status and the where hint (ADR-0034 §5) — done

- `presence_status` gets `from` (generated migration). The status kind is `busy` or `out`, with `from` and `until`; `out` makes the
  computed state `away` with the note, `busy` stays `busy`; a status whose `from` is in the future does nothing until then.
- Front tool `presence_status_set` (the speaker's own status: kind, from, until, note, or clear) beside `/busy` and `/free`.
- `where` hint (`desk`, `mobile`, `out`, `unknown`) from the active client's kind and network and the stated status; in `Presence`, the
  "Where the person is now" block and the planner input; never a place.
- Specs: `parietal.md`, `client.md` if the client sees it, `db.md`.
- Done when: compute tests for out/busy/scheduled/where; tool tests; migration generated and applied in tests.
- Evidence: migration `0026_powerful_ego.sql` (`migration-0026.test.ts`); `parietal/status.test.ts` (compute, service, tool, context line) plus the parietal, db and contracts suites pass (898 tests); the planner input is `presence().where`, the planner itself comes in P37.4.

### P37.4 The reach ladder (ADR-0034 §6) — done

- `createPresencePlanner`: a plan by state, where and urgency; a `hold` answer for busy (normal) and away/out/offline (normal).
- Urgent deliveries carry the reason line requirement into the front session wake text.
- Specs: `delivery.md` "Planner seam", `parietal.md` "Routing".
- Done when: a table test of state × where × urgency → routes or hold.
- Evidence: `RoutePlan = DeliveryRoute[] | { hold }`; `parietal/planner-ladder.test.ts` (16-row table, `until`, note, `immediate`, reason line) and `planner.test.ts` pass; `needs.immediate` (optional) keeps a room handoff from being held.

### P37.5 The return digest (ADR-0034 §7) — done

- Delivery service: a `hold` plan stores the row as `held` (`reason` = why); no retry timer. On `brain.parietal.presence` from
  `away`/`offline` to `active`, or when a stated `out`/`busy` ends, release every held row of the person as one wake turn of the front
  agent (the digest instruction plus the held items) and one notice to the active client; rows become `delivered`, route `digest`.
  Rows held more than 7 days are released into the front session as plain notes.
- Specs: `delivery.md`, `ras.md` if the wake turn changes.
- Done when: tests for hold, release on return, release on status end, one digest for many items, the 7-day release, and removal of a
  person's held rows.
- Evidence: `delivery/digest.test.ts` (hold per reason, one digest for many items, idempotent release, presence feed, tick release, 7-day note, urgent reason line, removal) and the `plugins-reminders`, `rooms-handoff` e2e pass; `delivery.md` "Hold and digest".

### P37.6 Model switch in chat (ADR-0034 §8) — done

- Owner tool `model_role_set` (role, model ref) through the provider service; approval and remote step-up as in P37.2; audited like
  `keith-core model set`.
- Specs: `providers.md`.
- Done when: tests for owner only, approval, step-up, an unknown model refused.
  Evidence: `providers/model-tools.test.ts` (owner only, approval for the set and not the get, unknown model refused, audit row) and `amygdala/step-up-tools.test.ts` (step-up) pass.

### P37.7 Docs and gate

Done (docs): guide section "Getting to know you, and reaching you", manual scenario 33, ADR-0034 amendment for `immediate`.
Gate (Nov 14, 2026): `bun run smoke` 110 steps ok; the test run 5989 pass with 1 fail (`platform/db.test.ts` pinned 26 core migrations;
fixed to 27 for migration 0026, the file passes); lint, check-imports, check-size and check-exports ok. Real-model behaviour waits for
manual scenario 33.

- `docs/guide.md`: onboarding, statuses in chat, the digest, the arrival protocol example. `docs/manual-testing.md`: one scenario.
- Full `bun run check` and `bun run smoke`.

## Owns

`apps/core/src/modules/{wernicke-broca,prefrontal,amygdala,parietal,delivery,providers}`, `packages/contracts` (persona, presence,
delivery), `packages/db` (presence schema, generated migration), the specs above, ADR-0034, this file.
