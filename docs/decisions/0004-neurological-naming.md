# 0004. Neurological naming

Status: Accepted (2026-10-26)

## Context

Keith's design is described as a brain (Thalamus, Cortex, Amygdala, …), and the brain panel in
the TUI shows these regions live.

## Decision

Core modules use the region names as folder names and commit scopes (`thalamus`,
`wernicke-broca`, `cortex`, `motor`, `amygdala`, `ras`, `hippocampus`) next to plain feature
names (`tasks`, `nodes`, `brain-events`, `auth`). `docs/ARCHITECTURE.md` maps every region to
its technical role, folder and eharness part.

## Consequences

- The brain panel, events (`brain.<region>.<phase>`) and code share one vocabulary.
- Newcomers need the map; it must stay current when a module is added.
