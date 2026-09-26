---
id: P1-I1
title: Bootstrap and CLI (keith setup, keith start, keith migrate)
phase: 1
wave: 2
lane: I
status: review
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

- [x] `keith setup` in a temp `KEITH_HOME` creates config, persona, db and owner. Running it again offers a password reset without duplicating the owner.
- [x] `bootstrap({ plugins: [fakeLlmPlugin], clock })` from `packages/core/test/` serves `/v1/health` and answers a turn.
- [x] Shutdown test: an in-flight turn is cancelled and persisted as partial, and the process exits cleanly.
- [ ] Manual: `keith start` with a real `DEEPSEEK_API_KEY` plus the TUI gives a streamed reply.
- [x] `bun run check` passes.

## Outcome

**Built**

- `packages/core/src/bootstrap.ts`: `bootstrap({ home, flags?, env?, plugins?, clock?, log?, importModule?, timing? })` builds the core in the exact order of core.md "Construction order" (steps 1 to 12, commented in the code), emits `core.started`, and returns a `Keith` handle (`config`, `paths`, `version`, `host`, `port`, `url`, `log`, `events`, `repos`, `threads`, `plugins`, `stop()`). If a step throws (for example `CONFIG_INVALID` from the provider check in `load`), everything built so far is torn down in reverse order, including closing the db, and the error is rethrown. `stop()` is idempotent. It emits `core.stop_requested`, calls `presence.flushPresence()`, then `server.stop()`, then `threads.stop()`, cancels every running turn and awaits it (the partial text is persisted with `meta.cancelled`), then `presence.dispose()`, `scheduling.stop()`, `memory.stop()`, `plugins.stopAll()`, `events.idle()` and `db.close()`. `KEITH_VERSION` is read from `packages/core/package.json`.
- `packages/core/src/builtins/index.ts`: `registerBuiltins(...)` registers `task.start/status/cancel`, `memory.remember/recall/forget` and `skill.load` through `tools.registerBuiltin` (step 10).
- `packages/core/src/cli/`: `index.ts` has `runCli(argv, io)` with `setup`, `start [--port] [--host]`, `migrate`, `--version`/`help`, returning an exit code. `start` waits for the first SIGINT/SIGTERM (a second one exits with code 1), then calls `keith.stop()`. `setup.ts` has `runSetup` (see config.md "keith setup"). `prompt.ts` has the `Prompter` interface, `terminalPrompter()` and `scriptedPrompter()`. `main.ts` is the executable.
- `packages/core/package.json`: `bin: { keith: ./src/cli/main.ts }`. Root `package.json`: `dev` is `bun --watch packages/core/src/cli/main.ts start`. I checked it by hand: it starts, serves, and stops on SIGINT.
- `packages/core/src/index.ts` exports `bootstrap`, `KEITH_VERSION`, `Keith`, `BootstrapOptions` and `runCli`.
- Tests (`packages/core/test/`, 19 tests): `bootstrap.test.ts` covers `/v1/health` on port 0, a streamed and persisted turn with the fake LLM over a real WebSocket, the built-ins offered to the model, in-process shutdown persisting a cancelled partial reply, idempotent `stop()`, teardown and db release after a failed start, and a missing config. `signals.test.ts` spawns `keith start --port 0` (fixture `test/fixtures/start-fake.ts`, fake LLM that stalls after the first delta), starts a turn, sends SIGTERM, and checks exit code 0, a partial assistant message with `meta.cancelled`, and a flushed `last_seen_at`. `cli.test.ts` covers setup with DeepSeek and with OpenRouter (the written config is parsed with `parseConfig`), a rerun that keeps files, offers a reset and never duplicates the owner, password mismatch, running out of answers, `--version`, unknown command, `migrate`, the `KEITH_HOME` default, and `start` with `waitForStop`. All tests use a temp `KEITH_HOME`, port 0, the fake LLM and no network.
- `bun run check` is green: 752 pass, 2 skip (the opt-in live tests).

**Decisions**

- **Prompt input:** no library. I read Bun's docs (runtime/console, guides/process/stdin): `console` as an async line iterator and the web `prompt()` can't hide a password. So `terminalPrompter` reads `process.stdin` itself, with raw mode and its own echo on a TTY, and one line per answer when stdin is piped. Commands take a `Prompter`, and tests use `scriptedPrompter`.
- **Setup defaults:** DeepSeek offers `deepseek-flash` (checked on api-docs.deepseek.com on 2026-09-26). OpenRouter offers `~openai/gpt-sol-latest` (the example in providers.md, not verified). Both are labelled as possibly outdated. The chosen plugin goes in both `enabled` and `required`, and the key is written as `env:<VENDOR>_API_KEY`. A rerun keeps `config.toml` and `persona.md` and only offers the owner a password reset. The username defaults to the name, lower-cased and dashed. Passwords need at least 8 characters and are asked twice.
- **Dependencies:** I ran `bun add @keith/provider-deepseek@workspace:* @keith/provider-openrouter@workspace:*` in `packages/core`. With the isolated linker, the plugin host's `import('@keith/provider-deepseek')` from core could not resolve without them. They are not statically imported, so check-deps (R-1) is unaffected. Recorded in config.md. No other dependency was added.

**Cross-lane gaps (worked around inside owns, no blocker)**

1. E1's `MindThreadManager.stop()` only unsubscribes and clears holds. It doesn't cancel running turns, and there is no "list busy threads" API. Bootstrap tracks busy threads from `thread.state_changed` and calls `threads.cancel({ threadId, nodeId })` for each, then `threads.idle()`, repeating until none are left. `cancel` requires a `nodeId` that the implementation ignores, so shutdown passes a freshly generated `nod_` id. A cleaner follow-up would be a `cancelAll()` on `MindThreadManager` (in `mind/`, not in my owns).
2. Plugin package resolution (see Dependencies above).
3. Workspace `bin` entries are not linked into any `node_modules/.bin` (the same is true for `keith-tui`). In the repo, run `bun run dev` or `bun packages/core/src/cli/main.ts <cmd>`. A global `bun link` or a published package would expose `keith`.

**Not done**

- The manual acceptance item (`keith start` with a real `DEEPSEEK_API_KEY` plus the TUI gives a streamed reply) needs a human with a key. It is unticked. I did run `keith setup` and then `keith start` with a dummy key: the real DeepSeek plugin loads and starts, the server listens, and SIGINT shuts down cleanly.
- The C1/E1 `historyLimit` follow-up (open returns at most 50 messages) is untouched.

**Docs:** `overview.md` has a new section, "Commands, startup and shutdown". `config.md` has a new "keith setup" section and the `--host` flag in the precedence example. No contradictions found between docs.
