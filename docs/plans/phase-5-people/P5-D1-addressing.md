---
id: P5-D1
title: "Addressing detector: rules first, utility-model fallback, don't interrupt when unsure"
phase: 5
wave: 2
lane: D
status: done
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

- [x] `rules.test.ts`: every rule above with positive and negative cases, including word boundaries ("Keithley" is not a mention) and names in other letter cases.
- [x] `corpus.test.ts`: all non-ambiguous lines are right with the rules alone. With a scripted `utility` fake answering by the label, all lines are right.
- [x] `classifier.test.ts`: a timeout, an invalid JSON reply and low confidence each give not addressed. The request carries no tools and only the recent messages. It runs in the `foreground` lane.
- [x] With `addressing = "rules"`, no model is ever called.
- [x] `bun run check` passes.

## Notes

- The rule pass must stay cheap and synchronous: P5-C2 calls `decide` on every group input.
- Tests use the scripted fake LLM (R-13). No live model runs in CI. The human run in P5-I2 checks the prompt against a real model.

## Outcome

**Built** (`packages/core/src/mind/addressing/`, with the same `AddressingDeps` and verdict values as P5-K1):
- `rules.ts`: `decideByRules` (pure, synchronous), in the task's order:
  - `single_human`: fewer than two distinct participant names.
  - `name`: `mind.name` as a whole word, in any letter case, with Unicode word boundaries. "@keith", "hey Keith" and "Keith's" match; "Keithley", "mckeith" and "Keith2" don't.
  - `other_human`: the input opens by naming another participant. That means "@pepper …", "hey Pepper …", or the bare name followed by punctuation or the end. "Pepper is late" is not an opening.
  - then `reply`, `question`, and otherwise `unsure`.

  It also exports the helpers `mentions`, `opensWith`, `isQuestion` and `visibleMessages`. A multi-word name also matches by its first word.
- `classifier.ts`: `classify(deps, input, { timeoutMs? })`.
  - One `RunLoop` run (`utility`, `tools: []`, `maxSteps: 1`, `persist: null`) through `scheduler.run('foreground', …)`.
  - The caller's signal is combined with a 5 s timeout (`CLASSIFIER_TIMEOUT_MS`). The timeout also wins a race against a run loop that ignores the abort.
  - The reply is zod-checked `{ addressed: boolean, confidence: 0..1 }`. The JSON may sit in a code fence or inside other text.
  - The warn log has `threadId` and `reason` (`timeout` | `aborted` | `invalid_reply` | `error`), plus the error code for `error`. It never logs message text.
- `prompts.ts`: `ADDRESSING_SYSTEM_PROMPT` (with a `{name}` placeholder) and `addressingSystemPrompt(name)`.
- `index.ts`: `createAddressing` runs the rules first. The classifier runs only for `unsure`, and only with `"rules+utility"`. `decide` never throws: a failing rule pass gives `unsure` and logs a warn.
- `corpus.ts`: 46 labelled lines over Tony / Pepper / Rhodey. They cover name mentions, "@keith", other-human openings, replies to Keith's questions, open questions, small talk, word-boundary traps, one-human groups and ambiguous lines.
- `testing.ts`: test-only fakes. A one-step utility `RunLoop` over `createFakeLlm`, a scheduler that records lanes, transcript builders and ids.
- Tests:
  - `rules.test.ts`
  - `classifier.test.ts`
  - `corpus.test.ts`: rules alone, rules plus a utility fake answering by the label, and `"rules"` mode with no model call.
  - `index.test.ts`: replaces the placeholder test.
- Docs:
  - core.md "Group threads" now describes addressing in full. P5-D1 is gone from the factories' Planned note and from the section's Planned marker. The markers left belong to P5-C1, P5-C2 and P5-I1.
  - providers.md needed no change: P5-K1 already wrote that `utility` runs the addressing classifier.

**Decisions**
- **Confidence:** at 0.7 or more, the verdict is `by: 'classifier'` with the model's answer, whichever way it goes. Below 0.7 it is `unsure` (not addressed), whatever the model said. So "addressed only at ≥ 0.7" holds.
- **Rule 3's "the input's author was a participant then" can't be checked.** `decide` gets no join times. The thread manager only asks about current participants, so rule 3 counts every current participant. This is commented in `rules.ts` and stated in core.md.
- **The classifier's `runCtx.participants`** is the input's author plus the humans who wrote the recent messages. `decide` gets participant names, not ids, and `RunLoop` loads each participant id as a person. The field only matters for tool filtering, and this call has no tools.
- **Author labels in the classifier input.** For the same reason, human authors appear as "Person A", "Person B", … in order of appearance. The Mind's messages carry `mind.name`, and the participants' names are listed separately. Each message is cut to 500 characters.
- **Question detection:** a question is "?" anywhere, a wh-word opening, or an auxiliary followed by a subject ("can you", "is it"). "do" needs a personal subject ("do we", "do you"), so "do it now" is not a question.
- **Rule 2 can't skip the author's own name**, because the detector doesn't know which name is the author's. So "Pepper, …" written by Pepper counts as `other_human`. No harm done: that line isn't addressed to the Mind anyway.

**Deviations:** none. Nothing outside `owns`, and no interface or contract change.

**Notes for other lanes**
- **P5-C2:**
  - Pass `recent` as visible messages, oldest first. Tool rows and empty tool-calling assistant steps are tolerated and skipped.
  - `participantNames` should hold only the current human participants.
  - With `"rules+utility"`, `decide` can take up to about 5 s on unsure inputs. It never throws.
- **P5-I1:** `createAddressing({ config, runLoop, scheduler: scheduling.scheduler, log })`, as P5-K1 said.
- **P5-I2 (human run):** check `ADDRESSING_SYSTEM_PROMPT` against a real `utility` model, using the corpus's ambiguous lines.
- **Later:** if `decide` ever gets participant ids or join times (an interface change), rule 3 can check join times and the classifier can use real names.
