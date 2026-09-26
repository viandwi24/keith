# ADR-0007: Adapters only where a second implementation exists

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Rule R-6 forbids speculative abstraction. Some seams are an exception because users will *certainly* want to choose between cloud, cheap and local engines from day one.

## Decision

The only pre-approved adapter seams are:
- **LLM** (`LlmProvider`): OpenRouter and DeepSeek from phase 1, and more later.
- **Voice** (`VadProvider`, `SttProvider`, `TtsProvider`, `RealtimeProvider`): phase 3 ships one local and one cloud adapter each for STT and TTS.

Every other adapter layer needs its own ADR naming its two implementations.

## Consequences

- Storage, auth, the event bus and the logger have one implementation each, behind plain module interfaces.
