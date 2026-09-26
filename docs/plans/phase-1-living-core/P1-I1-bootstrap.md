---
id: P1-I1
title: Bootstrap and CLI (keith setup, keith start, keith migrate)
phase: 1
wave: 2
lane: I
status: in-progress
owner: agent-P1-I1
depends: [P1-A1, P1-B1, P1-C1, P1-D1, P1-E1, P1-F1, P1-G1, P1-M1]
owns:
  - packages/core/src/bootstrap.ts
  - packages/core/src/cli/**
  - packages/core/test/**
  - packages/core/src/builtins/index.ts
  - packages/core/src/index.ts
  - packages/core/package.json
  - package.json
reads:
  - docs/architecture/overview.md
  - docs/architecture/config.md
  - docs/architecture/nodes.md
  - docs/architecture/repository.md
updates:
  - docs/architecture/overview.md
  - docs/architecture/config.md
scenarios: []
---

# P1-I1: Bootstrap and CLI

## Goal

`keith setup` then `keith start` gives a running Keith that the TUI can talk to.

## Scope

**In:**
- `bootstrap(opts)`: construct everything in the exact order of core.md "Construction order". `opts` accepts `home`, config `flags`, and, for tests only, `plugins?: PluginDefinition[]` (passed straight to the plugin host) and `clock?: Clock`. Graceful shutdown on SIGINT/SIGTERM (stop accepting, cancel turns, `presence.flushPresence()`, stop plugins, close db).
- `cli/`: `keith setup` (interactive: create `KEITH_HOME`; ask DeepSeek or OpenRouter and a model id, then write `config.toml` enabling only that provider with an `env:` key and all roles mapped to that model, per config.md; write `persona.md`; run migrations; create the owner person; idempotent password reset), `keith start [--port] [--host]`, `keith migrate`, `keith --version`. Pick a small prompt library, or use Bun's built-in `prompt()` where sufficient (record the choice in the Outcome).
- `bin` entry `keith` in `@keith/core`. Root script `dev` runs `keith start` in watch mode.
- `builtins/index.ts`: registers the built-in tools from each lane's file.

**Out:**
- End-to-end scenario tests (I2).

## Acceptance criteria

- [ ] `keith setup` in a temp `KEITH_HOME` creates config, persona, db and owner. Running it again offers a password reset without duplicating the owner.
- [ ] `bootstrap({ plugins: [fakeLlmPlugin], clock })` from `packages/core/test/` serves `/v1/health` and answers a turn.
- [ ] Shutdown test: an in-flight turn is cancelled and persisted as partial, and the process exits cleanly.
- [ ] Manual: `keith start` with a real `DEEPSEEK_API_KEY` plus the TUI gives a streamed reply.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
