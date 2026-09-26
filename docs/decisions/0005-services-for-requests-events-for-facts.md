# ADR-0005: Services for requests, events for facts

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Kehai plugins declared `depends` on other plugins and exposed `contributes`, which required a topological sort and a four-phase lifecycle.

## Decision

- Plugins **provide and consume services** by name (`ctx.services.provide/get/find`), typed by declaration merging. A plugin may declare `needs: [...]` for an early, clear failure.
- Plugins **emit and listen to events** for facts (past tense, namespaced). Events never carry commands.
- Lifecycle is `setup` (register only) → `start` (may use services) → `stop`.
- Plugins never import each other (R-2), except `import type` of a service type entry.

## Consequences

- No dependency graph: load order is config order, and services resolve at `start`.
- The rule of thumb for authors: need an answer → service; announcing something → event.
