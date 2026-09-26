# ADR-0004: Keith owns the agent loop; providers stream one completion

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Kehai delegated the multi-step tool loop to the AI SDK (`streamText` + `stopWhen`) and had to follow a rule against hand-rolled loops. Keith's differentiators (interrupts, cancellation, delivery turns, briefings, task runs, per-step persistence) all live *inside* the loop.

## Decision

- The core implements one `runLoop` (see [core.md](../architecture/core.md#the-turn-loop)) used by user turns, delivery and briefing turns, and tasks.
- `LlmProvider.stream()` streams **one** completion and normalizes it into `LlmEvent`s. Adapters never loop or retry.
- No vendor AI SDK in core. Provider plugins may use any library internally.

## Consequences

- More code in core (tool-call assembly lives in adapters, the loop in core), but full control and a single place to test turn behavior.
- Switching or adding vendors never changes turn semantics.
