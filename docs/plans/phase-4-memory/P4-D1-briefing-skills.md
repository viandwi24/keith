---
id: P4-D1
title: "Briefing skills: a default morning_briefing skill and person.arrived examples in tool-weather"
phase: 4
wave: 2
lane: D
status: todo
owner: null
depends: [P4-K1]
owns:
  - packages/core/src/builtins/skills/**
  - packages/core/src/plugins/skills.ts
  - packages/core/src/plugins/skills.test.ts
  - plugins/tool-weather/**
reads:
  - docs/contracts/plugin-api.md
  - docs/architecture/plugin-system.md
  - docs/architecture/core.md
  - docs/concept/scenarios.md
updates:
  - docs/architecture/plugin-system.md
scenarios: [S-1]
---

# P4-D1: Briefing skills

## Goal

A briefing reads like a good assistant's morning note, not a list dump. The core ships a default `morning_briefing` skill that the model loads on arrival, and a plugin can replace it. `@keith/tool-weather` shows how a plugin feeds a briefing: a daily forecast on the day's first arrival, besides the existing rain alert.

## Scope

**In:**
- **Default skills** (`plugins/skills.ts`): `registerDefault(skill)`, replacing the P4-K1 placeholder.
  - A default is listed and loadable like any skill (owner `core`).
  - A plugin that registers the same name replaces it (logged at info) instead of failing with `TOOL_NAME_TAKEN`.
  - A second plugin with that name still fails, as today.
  - `removeByPlugin` brings the default back.
  - Registering a default twice with the same name is a bug (`TOOL_NAME_TAKEN`).
- **`morning_briefing`** (`builtins/skills/morning-briefing.ts` + a `.md` file with the instructions, loaded with `Bun.file`):
  - Greet by name, in the tone of the relationship card.
  - Lead with what needs action (critical and high items, reminders due today: `reminder.list` if available), then finished work (task results), then plugin items (weather, news), then anything else.
  - At most about six sentences unless asked for more, and no item dropped (I-10).
  - Name the source of plugin items only when it helps.
  - When nothing is pending, a short greeting and one useful line (for example today's first reminder).
  - For spoken replies (the focus node is being heard), no lists or markdown.
  - The description says when to load it: "Load at the start of a briefing or when someone asks what they missed."
- **`@keith/tool-weather`** (`person.arrived` examples):
  - A new config key `dailyForecast` (boolean, default true; only with `homeCity`). On a person's first arrival of the local day (the date in the forecast's time zone), enqueue one `low` delivery: "Today in <city>: <min>–<max>°, <condition>".
  - Remember the last date per person in `ctx.data`, so a second arrival the same day adds nothing, and neither does a restart.
  - The rain alert stays as is. When both apply, send the forecast and the rain alert as two items, so urgency can differ.
  - Replay fixtures are recorded like the existing ones. No network in tests (R-13).
  - Update the plugin's header comment and the example in plugin-system.md.
- plugin-system.md: default skills (replaceable by name) and the weather plugin's arrival examples.

**Out:**
- A news plugin (optional in the overview; a later lane can add it as a new plugin).
- The context builder line that tells the model to load the skill. P4-B1 owns `context-sections.ts` and adds it.
- Wiring (P4-K1 already registers the default through `registerBuiltins`).

## Acceptance criteria

- [ ] `plugins/skills.test.ts`:
  - A default is listed and loadable.
  - A plugin replaces it, and `skill.load` returns the plugin's text.
  - A second plugin with that name gets `TOOL_NAME_TAKEN`.
  - `removeByPlugin` restores the default.
  - The name pattern still applies to defaults.
- [ ] `builtins/skills/morning-briefing.test.ts`: the skill's name and description are as above. Its instructions load, are non-empty, mention `reminder.list`, and are under 2 000 characters (they go into context whole).
- [ ] `plugins/tool-weather/test/weather.test.ts`:
  - The first arrival of the day enqueues one `low` forecast delivery. A second arrival that day enqueues none. The next local day enqueues again.
  - `dailyForecast = false` → none.
  - No `homeCity` → none.
  - The rain alert still works alongside.
- [ ] `bun run check` passes.

## Notes

- The skill is text for the model. Keep it short and concrete, because every word costs tokens on each briefing.
- Plugin rules apply to `tool-weather`: it imports only `@keith/sdk` and `@keith/protocol` (`bun run deps`).
- The date-per-person key in `ctx.data` could be `forecast:<personId>`. Keep it a plain `YYYY-MM-DD` string.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
