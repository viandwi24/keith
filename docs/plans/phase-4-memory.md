# Phase 4: Memory + proactivity (overview)

> Task files are in [phase-4-memory/](phase-4-memory/README.md). This overview is kept for history.

**Goal:** Keith learns from conversations without being told, keeps long threads coherent, and reminds you of things on time.

## Lanes (sketch)

| Lane | Work |
|---|---|
| A | Reflection job (background lane): distill new messages into semantic memories and relationship card updates, dedupe (FTS match + LLM merge) |
| B | Thread summaries: rolling summary with the `utility` model, context builder integration |
| C | Reminders: `reminder.set/cancel`, `reminders` table, tick-driven deliveries |
| D | Briefing skills: a default `morning_briefing` skill, plus `person.arrived` examples in `tool-weather` (news plugin optional) |
| E | `keith backup` / `keith restore` |
| I | Integration + S-3 (semantic) e2e: a fact stated on day 1 is recalled on day 2 without the raw message in context |

Decide on `sqlite-vec` only if lane A's recall tests fail with FTS (ADR).
