# ADR-0001: One Mind, many Relationships and Threads

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Keith must feel like one continuous awareness that talks to several people at once, each with a different "face", and shares context only when appropriate. Kehai gave every user their own CEN + DMN agent pair. That kept sessions apart but contradicted "one awareness", and duplicated the machinery per person.

## Decision

- Exactly one **Mind** per deployment (identity, memory, scheduler, registries).
- The per-person face is a **Relationship** (tier, tone, notes, memories about them, commitments to them).
- Conversations are **Threads** with one or more participants. Each Thread builds its **own LLM context** per turn. Threads don't share one context window.
- Cross-thread awareness goes through a visibility-filtered **awareness digest** and memory recall, not a shared context.
- Group threads (collaboration) exist in the data model from phase 1 and ship in phase 5.

## Consequences

- Parallel conversations are cheap and robust: they are independent LLM calls.
- Privacy is a single rule (memory visibility, I-4) instead of process isolation.
- "Truly simultaneous" awareness (one context seeing everything) is rejected. It is expensive, fragile, and leaks privacy.
