---
id: P5-D1
title: "Addressing detector: rules first, utility-model fallback, don't interrupt when unsure"
phase: 5
wave: 2
lane: D
status: in-progress
owner: agent-P5-D1
depends: [P5-K1]
owns:
  - packages/core/src/mind/addressing/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/concept/scenarios.md
  - docs/architecture/core.md
  - docs/architecture/providers.md
  - docs/architecture/memory.md
updates:
  - docs/architecture/core.md
  - docs/architecture/providers.md
scenarios: [S-6]
---

# P5-D1: Addressing detector

## Goal

In a group thread, Keith answers when someone talks to it, and stays quiet when people talk to each other (S-6 "Hard parts: Addressing"). A cheap rule pass decides most inputs. The `utility` model decides the rest, and when it is still unsure, Keith doesn't interrupt.

## Scope

**In:** `createAddressing(deps)` (`mind/addressing/`), replacing the P5-K1 placeholder, with the same deps and verdict values.
- **Rules** (`rules.ts`, pure, in this order):
  1. Fewer than two human participants → `single_human`, addressed.
  2. The Mind's name (`mind.name`, case-insensitive, as a word, also "hey Keith", "@keith") → `name`, addressed. When the input starts by naming another participant ("Pepper, …") and doesn't name the Mind, → `other_human`, not addressed.
  3. **Reply** (D6: there is no reply-to in the protocol): the latest visible message before the input is the Mind's, it ended with a question, and the input's author was a participant then → `reply`, addressed.
  4. A question ("?", or an interrogative opening) that names no participant, while the last three visible messages include the Mind's → `question`, addressed.
  5. Everything else is **unsure**.
- **Classifier** (`classifier.ts`), only for unsure inputs and only when `mind.group.addressing = "rules+utility"`:
  - One `RunLoop` run: `modelRole: 'utility'`, no tools, one step, `persist: null`. It runs through `scheduler.run('foreground', …)`, because a human is waiting (I-5). `runCtx` is the thread and its participants (I-3).
  - Its input holds only the Mind's name, the participants' names, the up to 10 recent messages and the input. There are no memories and no cards.
  - The reply is zod-validated JSON, `{ "addressed": boolean, "confidence": number }`. It counts as addressed only when `addressed` and `confidence ≥ 0.7`.
  - A 5 s timeout, an invalid reply, a provider error or an abort all give `unsure` (not addressed), logged at warn without the text.
  - The prompt is a constant in `addressing/prompts.ts`.
- `decide` never throws.
- **Transcript corpus** (`addressing/corpus.ts` + `corpus.test.ts`): at least 40 labelled group lines over the Tony/Pepper/Rhodey cast, each with its recent messages and the expected verdict. It covers name mentions, "@keith", other-human openings, replies to Keith's questions, open questions, small talk between humans, and ambiguous lines. The rule pass must decide every non-ambiguous line correctly without the classifier. Ambiguous lines are labelled `unsure`, and the test checks they reach the classifier.
- core.md: the addressing part of "Group threads", with its `(P5-D1)` marker removed. providers.md: `utility` also classifies addressing.

**Out:** calling the detector and acting on its verdict (P5-C2), a reply-to field in the protocol (not in v1, D6).

## Acceptance criteria

- [ ] `rules.test.ts`: every rule above with positive and negative cases, including word boundaries ("Keithley" is not a mention) and names in other letter cases.
- [ ] `corpus.test.ts`: all non-ambiguous lines are right with the rules alone. With a scripted `utility` fake answering by the label, all lines are right.
- [ ] `classifier.test.ts`: a timeout, an invalid JSON reply and low confidence each give not addressed. The request carries no tools and only the recent messages. It runs in the `foreground` lane.
- [ ] With `addressing = "rules"`, no model is ever called.
- [ ] `bun run check` passes.

## Notes

- The rule pass must stay cheap and synchronous: P5-C2 calls `decide` on every group input.
- Tests use the scripted fake LLM (R-13). No live model runs in CI. The human run in P5-I2 checks the prompt against a real model.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
