---
id: P2-E1
title: "@keith/tool-weather: reference tool plugin with a service, an event and a card"
phase: 2
wave: 2
lane: E
status: review
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

- [x] Loads with `setupFakePlugin`, registers exactly the tool, the service and the event schema.
- [x] The card block passes `UiBlock` validation; `uiBlockToText` gives a readable fallback.
- [x] `onAction` refresh returns an updated card.
- [x] Arrival with rain → one delivery; without → none.
- [x] No network in tests; `bun run check` passes.

## Outcome

**Built:** `plugins/tool-weather` (`@keith/tool-weather`, kind `tool`, namespace `weather`), scaffolded with `bun init --yes` (R-18; generated README.md, CLAUDE.md, .gitignore and nested node_modules deleted, `index.ts` moved to `src/`), deps via `bun add`.

- `src/open-meteo.ts`: keyless Open-Meteo client with injectable `fetch`. Geocoding (`count=1`) then forecast (`current` + 12 `hourly` hours, `timezone=auto`, unit params from `units`). Unknown place → `NOT_FOUND`; HTTP error, unreachable source or unexpected body → `PROVIDER_ERROR`; an aborted signal rethrows the abort. WMO code → text table.
- `src/service.ts`: type-only entry (`exports["./service"]`) with `Forecast`, `WeatherService`, `WeatherAlertRaised` and the `declare module '@keith/sdk'` merges for `ServiceMap.weather` and `EventMap['weather.alert_raised']`.
- `src/tool.ts`: `weather.current({ city })`, `minTier: 'member'`, `timeoutMs: 20 000`. Returns `content` plus a `card` (`id: weather`) whose children are a `keyValue` (`weather_details`) and an `actions` block (`weather_actions`) with a `refresh` button carrying `{ city }`. `onAction` handles `weather_actions`/`refresh` by fetching again and returning an updated card; other actions return `undefined`; a refresh without a valid city throws `TOOL_INPUT_INVALID`.
- `src/index.ts`: `createWeatherPlugin({ fetch?, forecastUrl?, geocodingUrl? })`, default export `createWeatherPlugin()`. Config `{ homeCity?: string, units: 'metric' | 'imperial' = 'metric' }`. Provides service `weather`, defines `weather.alert_raised` with a zod schema, registers the tool. On `person.arrived` with `homeCity` set: if rain is likely in the next 6 hours (`RAIN_LOOKAHEAD_HOURS`; rainy WMO code or precipitation probability ≥ 50 %), enqueues one delivery ("Rain expected in Surabaya around 16:00 (80% chance).", urgency `normal`) and emits `weather.alert_raised`. A failing forecast is logged as a warning and delivers nothing.
- Tests (`test/weather.test.ts`, 16): registrations, config, event schema, request URLs and units, error mapping, abort, card passes `UiBlock` and exact `uiBlockToText` fallback, `onAction` refresh, arrival with rain / without / rain beyond the window / no `homeCity` / failing forecast. `test/live.test.ts` runs only with `KEITH_LIVE=1` (passed once on 2026-09-26).

**Weather source:** Open-Meteo, docs read on 2026-09-26: https://open-meteo.com/en/docs (forecast, `https://api.open-meteo.com/v1/forecast`) and https://open-meteo.com/en/docs/geocoding-api (`https://geocoding-api.open-meteo.com/v1/search`). Free without a key for non-commercial use; the card footer credits "Weather data by Open-Meteo.com". Fixtures: `recorded-*` are real responses captured 2026-09-26 (Surabaya geocoding, empty geocoding, metric and imperial forecasts, a 400 error); `synthetic-forecast-surabaya-rain.json` is hand-made from the recorded forecast. The geocoding API returns no `results` key at all when nothing matches (the docs don't say), which the client handles.

**Decisions / deviations:**
- The Refresh `actions` block is a child of the card (depth 2), because `ToolResult.ui` is a single block.
- The service signature is `forecast(city, opts?: { signal })`: the optional signal lets the tool pass `t.signal`.
- Unit labels come from a fixed table (`°C`/`km/h`/`mm`, `°F`/`mph`/`in`) rather than the API's `current_units` (which reports `mp/h`).
- `weather.alert_raised` is emitted once per arrival that finds rain (payload: `city`, `condition: 'rain'`, `at` local time, `timezone`, `precipitationProbability`); no de-duplication across arrivals.
- Arrivals with `awayMs: null` (first-ever attach) are treated like any other arrival.

**Follow-ups for P2-I1:**
- Add `"@keith/tool-weather": "workspace:*"` to `packages/core/package.json` dependencies (via `bun add` in `packages/core`) so the core can load it by package name from `plugins.enabled`.
- Consumers that want the service types add `@keith/tool-weather` as a devDependency and `import type {} from '@keith/tool-weather/service'`.
