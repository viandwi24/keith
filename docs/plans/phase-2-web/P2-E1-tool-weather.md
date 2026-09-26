---
id: P2-E1
title: "@keith/tool-weather: reference tool plugin with a service, an event and a card"
phase: 2
wave: 2
lane: E
status: in-progress
owner: agent-P2-E1
depends: [P2-K1]
owns:
  - plugins/tool-weather/**
reads:
  - docs/contracts/plugin-api.md
  - docs/architecture/plugin-system.md
  - docs/contracts/ui-blocks.md
  - docs/concept/scenarios.md
updates: []
scenarios: [S-1, S-8]
---

# P2-E1: @keith/tool-weather

## Goal

The reference `tool` plugin that shows plugin authors every mechanism once: a tool with a UI card, a service other plugins can use, an event, a delivery on arrival, and an `onAction` button.

## Scope

**In:**
- `bun init` in `plugins/tool-weather` (R-18), kind `tool`, namespace `weather`.
- Weather source: a free, keyless API (read its current docs, e.g. Open-Meteo, record URL and date). `fetch` injectable; tests use recorded or synthetic fixtures (R-13).
- Tool `weather.current({ city })` returning `content` + a `card` UI block (+ `keyValue` child) and an `actions` block with a "Refresh" button handled by `onAction`.
- Service `weather` (`forecast(city)`), typed via `declare module '@keith/sdk'` in a type-only `src/service.ts` entry (`exports["./service"]`).
- Event `weather.alert_raised` defined with a schema; on `person.arrived`, if configured `homeCity` has rain in the next hours, enqueue a delivery ("rain at 16:00").
- Config: `homeCity?`, `units` (default metric).

**Out:** anything in core or the web app.

## Acceptance criteria

- [ ] Loads with `setupFakePlugin`, registers exactly the tool, the service and the event schema.
- [ ] The card block passes `UiBlock` validation; `uiBlockToText` gives a readable fallback.
- [ ] `onAction` refresh returns an updated card.
- [ ] Arrival with rain → one delivery; without → none.
- [ ] No network in tests; `bun run check` passes.

## Outcome

_To be filled._
