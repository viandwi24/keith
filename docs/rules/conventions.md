# Conventions

Conventions keep code uniform. Unlike [engineering rules](engineering.md), they can change through a normal PR.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Files and folders | `kebab-case` | `turn-loop.ts`, `context-builder/` |
| Types, interfaces, classes | `PascalCase`, no `I` prefix | `ThreadManager`, `LlmProvider` |
| Functions, variables | `camelCase` | `buildContext` |
| Constants | `camelCase`, or `SCREAMING_SNAKE` for true compile-time constants | `DEFAULT_PORT` |
| Error codes | `SCREAMING_SNAKE` | `SERVICE_MISSING` |
| Packages | `@keith/<name>` | `@keith/provider-deepseek` |
| Plugin packages | `@keith/<kind>-<name>` for first-party (`provider-`, `tool-`), bare name for client apps | `@keith/tool-weather`, `@keith/web` |
| Events | `<namespace>.<noun>_<past-verb>` | `weather.alert_raised` |
| Tools | `<namespace>.<name>` snake_case segments | `task.start`, `weather.current` |
| Config keys | `camelCase` in TOML | `awayAfterMinutes` |
| Domain vocabulary | Only the terms in [glossary.md](../concept/glossary.md) | `Thread`, not `Session` |

## Identifiers

IDs are prefixed ULIDs: `<prefix>_<ULID>`. Generate them only through the injected `ids` helper.

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `per_` | Person | `tsk_` | Task |
| `nod_` | Node | `cmt_` | Commitment |
| `thr_` | Thread | `dlv_` | Delivery |
| `msg_` | Message | `mem_` | Memory |
| `trn_` | Turn | `fil_` | File |
| `win_` | Workspace window | `rem_` | Reminder (phase 4) |

## Files and modules

- One primary concept per file. A file over ~300 lines is a signal to split, not a hard limit.
- Each core folder exposes `types.ts` (interfaces other folders may use) and `index.ts` (the constructor/factory). Everything else is private to the folder.
- No default exports, except plugin entry files (`export default definePlugin(...)`).
- No barrel files beyond a folder's `index.ts`.
- Prefer plain functions and factory functions (`createThreadManager(deps)`) over classes. Use classes only for stateful objects with a real lifecycle.
- Dependencies are passed explicitly as a `deps` object to factories. No service locator inside core.

## Tests

- Runner: `bun test`. Tests sit next to the code as `*.test.ts`. Cross-package end-to-end tests go in `tests/e2e/*.test.ts`.
- Test names describe behavior: `"queues text input while speaking and runs it after"`.
- Tests for an invariant or scenario cite it: `"I-7: audio goes only to focus node"`, `"S-2: delivery arrives unsolicited"`.
- Every test that touches files uses a temp `KEITH_HOME` created and removed by a helper.
- Contract tests: `packages/protocol` parses every doc example ([contracts/README.md](../contracts/README.md)).
- Don't mock what you own *once it exists*. Use real SQLite (temp file or `:memory:`), a real event bus, the fake LLM provider, and a fake clock.
- Exception for parallel lanes: in a wave where the implementation of another lane doesn't exist yet, build an in-memory fake from its `types.ts` interface inside your own test folder. The phase's integration task re-runs the key tests against the real implementations.
- Provider-free rule R-13 has one opt-in exception: live smoke tests guarded by `KEITH_LIVE=1`, never run in CI.

## Logging

- Use the injected `Logger` only. `console.*` is allowed only in CLI output code (`core/src/cli`, `apps/*`).
- Messages are lowercase, short and constant. Variables go in fields: `log.info('turn completed', { threadId, steps, ms })`.
- Levels: `debug` (internals, request shapes), `info` (lifecycle), `warn` (recovered problems), `error` (needs attention).

## Commits and branches

- Conventional Commits with the task id: `feat(core): add delivery queue [P1-G1]`, `fix(protocol): … [P1-C1]`, `docs(adr): … [P0-04]`.
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.
- Scope = package or area: `core`, `protocol`, `sdk`, `tui`, `web`, `provider-deepseek`, `plans`, `adr`.
- Branch per task: `task/<TASK-ID>-<slug>`, e.g. `task/P1-G1-deliveries`.
- One task = one PR. PR title = main commit subject. PR body = the task's `## Outcome`.

## Docs style

- One concept per file. Start with one sentence that says what the file is for.
- Rules are numbered and checkable. Prefer tables over prose for lists of things.
- Link, don't repeat. If a fact lives in another doc, link to it.
- Mark unbuilt design with a quote line: `> Planned (phase N): …`.
- Code blocks in contracts are normative, and elsewhere illustrative.
- English, plain sentences, no marketing tone.
