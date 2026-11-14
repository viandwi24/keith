# P2 — M1 "End-to-end chat"

Oct 26, 2026 · plan for milestone M1 of `P0-mvp.md` · status: **done** (Oct 26, 2026)

## Goal and limits

M1 is done when the owner can open the TUI, create an OpenRouter connection with their API key, pick a model, then chat with Keith with streaming, and the history survives a core restart. All of it through the path the web UI will use later: TUI → `@keith/client` → core HTTP.

In M1:

- SQLite adapters for eharness: messages, state, lock, inbox, connection profiles, catalog cache. Each is proven with the eharness conformance suite.
- Provider registry (ADR-0007): OpenRouter as the default, connections with sealed credentials, the model list, and a model per role.
- The front agent (`front`, Wernicke–Broca) without delegation. Its only tool is `datetime` from `eharness/clock`.
- Thalamus: one Hono app that mounts the `eharness/http` chat at `/sessions/*`, Keith's oRPC at `/rpc/*`, and `/health`.
- The owner token (Auth).
- `@keith/client`, then the TUI: login, streaming chat, connection list, connection form, and model picking.

Not in M1: Cortex and delegation, task board, brain events, brain panel (M2); nodes and approval (M3); memory (M4); MCP connectors; the full plugin loader.

## Decisions (CTO, Oct 26, 2026)

| Topic | Decision | Reason |
| --- | --- | --- |
| Where the SQLite adapters live | `packages/db/src/eh/*`, not `eh-ext` | The adapters need the tables, and only the core may use `@keith/db`. P0 is already updated |
| Adapter source | Adapted from `examples/team/server/src/infra/eh/{storage,profile-store}.ts` (MIT, source noted on the first line) | Already tested multi-instance in team; trimmed to the ports used |
| Migrations | `bunx drizzle-kit generate` makes the SQL; `bun run db:migrate` runs it through the `drizzle-orm/bun-sqlite` migrator. The core refuses to boot if the schema is not up to date, with the message "run bun run db:migrate" | P0: migrations do not run automatically at boot. Bun cannot make migrations from a schema (ADR-0006) |
| Model per role | The settings `model.front` and `model.cortex` hold `profile:model`. The `roleModel` plugin sets the model through the `turn.prepare` hook every turn | Change the model without re-creating the agent; follows ADR-0007 |
| Default models | `front`: `anthropic/claude-haiku-5.5`, `cortex`: `anthropic/claude-sonnet-5.5` (checked in the OpenRouter catalog, Oct 26, 2026) | The front layer is fast and cheap, Cortex is strong (P0 "Two agents") |
| Secret key | `KEITH_SECRET_KEY` (32 bytes base64). If empty, the core creates `data/secret.key` (mode 0600) once, and warns that this is dev mode | Team pattern (`TEAM_SECRET_KEY`) |
| Owner token | Created at first boot if no owner exists, printed once to the terminal, only the SHA-256 hash is stored. `bun run --filter @keith/core token:reset` makes a new token | P0 "Client SDK" |
| Chat in Ink | `createChatSession` + `createReactBindings` from `eharness/client(/react)` with `useChat` from `@ai-sdk/react` in Ink. This is the spike P0 set | The same path for the web UI. Fallback if it fails in Ink: read the stream with `readUIMessageStream` (`ai`) in `@keith/client` like `examples/coder` |
| Version + SHA in `/health` | Version from the root `package.json`; SHA from `KEITH_BUILD_SHA`, if empty `git rev-parse --short HEAD` through `Bun.$` at boot | Bun first |
| Connection form | The core sends the provider definition's `formSpec`; the TUI renders generic fields (`string`, `password`, `keyvalue`, `enum`, `boolean`) | The client does not know provider-specific fields (ADR-0007) |

## Versions (checked Oct 26, 2026)

| Package | Version | Used in | Notes |
| --- | --- | --- | --- |
| `@openrouter/ai-sdk-provider` | 3.1.0 | core | Peers `ai ^7`, `zod ^4.1.8`; same as the examples |
| `@orpc/contract`, `@orpc/server`, `@orpc/client` | 1.16.1 | contracts, core, client | `@orpc/server/fetch` for the Web API handler in Hono |
| `@ai-sdk/react` | 4.0.157 | tui | Depends on `ai` 7.0.153 (same as the catalog) |
| `eharness` | 0.9.0 | core, db, client | `eharness/providers`, `http`, `client`, `clock`, `testing` |
| `drizzle-orm` / `drizzle-kit` | 0.45.4 / 0.31.11 | db | Already there from M0 |

All go into `workspaces.catalog`, then packages use `catalog:`.

## Steps

Each step ends with a green `bun run check` and one Conventional Commits commit. The module spec is written in the same commit as its code (hard rule 1).

### 1. Dependencies

```bash
bun pm pkg set workspaces.catalog.@openrouter/ai-sdk-provider=3.1.0 workspaces.catalog.@orpc/contract=1.16.1 workspaces.catalog.@orpc/server=1.16.1 workspaces.catalog.@orpc/client=1.16.1 workspaces.catalog.@ai-sdk/react=4.0.157
# per package: bun add --exact <package>@<version>, then bun pm pkg set dependencies.<package>=catalog:
```

`packages/contracts`: `@orpc/contract`. `packages/db`: `eharness`, `ai`. `apps/core`: `@openrouter/ai-sdk-provider`, `@orpc/server`, `@keith/contracts`, `@keith/db`. `packages/client`: `eharness`, `ai`, `@orpc/client`, `@keith/contracts`. `apps/tui`: `@ai-sdk/react`, `eharness`, `@keith/client`, `@keith/contracts`. Workspace packages are added as `workspace:*`.

### 2. `packages/contracts`

- `src/health.ts`: `HealthSchema` (`status`, `version`, `sha`, `boot`).
- `src/providers.ts`: `FormFieldSchema`, `ProviderDescriptionSchema`, `ConnectionSchema` (the redacted profile: secrets are only `{ set, hint? }`), `ConnectionInputSchema`, `ModelSchema`, `TestResultSchema`.
- `src/settings.ts`: `ModelRoleSchema` (`front | cortex`), `ModelRefSchema` (`profile:model`).
- `src/contract.ts`: the oRPC contract `keithContract`:
  - `health.get`
  - `providers.describe` (definitions + forms), `providers.list`, `providers.put`, `providers.remove`, `providers.test`, `providers.models`
  - `models.roles.get`, `models.roles.set`
- Test: the schema rejects a raw secret in `ConnectionSchema`. The export snapshot is updated with `--write` as part of the commit.

### 3. `packages/db`

- `src/schema.ts` (Drizzle): `eh_messages`, `eh_states`, `eh_locks`, `eh_inbox_items`, `config_profiles`, `catalog_cache`, `settings`, `people`, `client_tokens`. Columns follow team except for team-specific product parts.
- `drizzle.config.ts` (Drizzle docs for `bun:sqlite`), then `bunx drizzle-kit generate` makes `drizzle/0000_*.sql` (a generated file, guarded by the hook).
- `src/connection.ts`: `openDatabase(file)` (WAL, `busy_timeout = 5000`, `foreign_keys = ON`) and `assertMigrated()`.
- `src/migrate.ts` + root script `db:migrate`.
- `src/eh/storage.ts`: `sqliteMessages`, `sqliteState`, `sqliteLock`, `sqliteInbox`.
- `src/eh/profile-store.ts`: `sqliteProfileStore`.
- `src/eh/catalog-cache.ts`: `sqliteCatalogCache`.
- `src/repos/settings.ts`, `src/repos/tokens.ts`.
- Tests (`:memory:` + migrations): `messageAdapterConformance`, `stateAdapterConformance`, `lockConformance`, `inboxAdapterConformance`, `profileStoreConformance` from `eharness/testing`, plus repo tests.

### 4. `apps/core`

`src/platform/`:

- `config.ts`: add `KEITH_SECRET_KEY`, `KEITH_BUILD_SHA`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (passed to the provider as `env`). The DB file = `<dataDir>/keith.db`.
- `vault.ts`: `webCryptoVault` from the env key or `data/secret.key`.
- `db.ts`: opens the DB and `assertMigrated()`.
- `logger.ts`: the only user of `console`.

Modules (`src/modules/<name>/index.ts` as the public API):

| Module | Content |
| --- | --- |
| `auth` | `ensureOwner()` (first token), `verifyToken(header)`, `authorize` for `eharness/http` and the oRPC middleware |
| `providers` | `createProviderService({ store: sealedProfileStore(sqliteProfileStore, vault), cache, env })` on top of `createProviderManager` with the definition `openRouterProvider({ createOpenRouter })`; a definition registry (`registerProvider(def)`, used by plugins later); the implementation of the `providers.*` and `models.roles.*` router; the eharness plugin `roleModel(role)` (`turn.prepare` → `manager.resolve(ref)`) |
| `wernicke-broca` | `createFrontAgent({ storage, providers })`: `defineHarnessAgent` with Keith's persona instructions, `clock()`, `roleModel('front')`, `models: manager.catalog()`. Session `front:owner` |
| `thalamus` | `createApp()`: Hono, `GET /health`, `/sessions/*` → `createHarnessHttp(front, { authorize })`, `/rpc/*` → oRPC handler with the owner context |

`main.ts` only wires: config → db → vault → owner → providers.ready() → agent → app → `Bun.serve`. Script `token:reset`.

### 5. `packages/client`

`createKeithClient({ baseUrl, token })` returns:

- `harness`: `createHarnessClient` with the `Authorization: Bearer` header.
- `rpc`: a typed oRPC client from `keithContract`, through `RPCLink` with `fetch`.
- `chat(sessionId = 'front:owner')`: `createChatSession`.

`src/config.ts` reads and writes `~/.keith/client.json` (mode 0600). Its test uses a fake oRPC and HTTP server in the same process (`Bun.serve` port 0).

### 6. `apps/tui`

- `src/cli.tsx`: the command `login <token> [--core URL]` (saves the config), otherwise opens the app.
- `src/features/chat/`: message list (stream per token, simple markdown), input, `Esc` stops.
- `src/features/connections/`: `/providers` lists connections; `/connect` picks a provider → a form from `formSpec` (`password` masked) → `providers.put` → `providers.test`.
- `src/features/models/`: `/model` picks the `front` and `cortex` models from `providers.models`.
- `ink-testing-library` tests with a fake `@keith/client`: stream rendering, a form from a sample spec, a secret field never shown.

### 7. Documents

- `docs/specs/`: `auth.md`, `providers.md`, `thalamus.md` (routes and errors), `wernicke-broca.md`, `db.md` (tables and migrations).
- `AGENTS.md`: add the commands `db:migrate`, `token:reset`, and new gotchas from execution.

## M1 gate (evidence)

| Evidence | How |
| --- | --- |
| The SQLite adapters are correct | The eharness conformance suite is green for every port in `packages/db` |
| End-to-end chat | `apps/core/src/e2e.test.ts`: the core in the same process (`Bun.serve` port 0, a file DB in a temp folder) with the `scriptedProvider` from `eharness/testing` registered as a definition. `@keith/client` (a core devDependency) sends "hello", the stream carries the scripted text, and the messages are stored |
| Survives a restart | The same test closes the core then opens a new core on the same DB file; `messages('front:owner')` returns the earlier conversation |
| Auth | No token or a wrong token → 401 on `/sessions/*` and `/rpc/*`; `/health` is open |
| Secrets do not leak | `providers.put` of OpenRouter with a test key: the response, `providers.list` and the logs do not contain the key; the `settings` column in the DB holds only a sealed blob; editing `baseURL` without a key removes the key |
| Model per role | `models.roles.set('front', 'scripted:a')` then chat uses model `a`; switch to `scripted:b` without a restart → the next turn uses `b` |
| TUI | Ink tests: streaming chat, a connection form from `formSpec`, a masked secret field |
| Migrations | The core on an empty DB refuses to boot with the message `bun run db:migrate`; after migrating, boot works |
| `bun run check` + `act` | Green |

A manual demo with real OpenRouter: viandwi24 types his own API key in the TUI (the agent holds no real key). The result is recorded as extra evidence.

## Risks

| Risk | Handling |
| --- | --- |
| `useChat` from `@ai-sdk/react` does not run in Ink (depends on DOM or SWR behavior) | Spike at the start of step 6; fallback `readUIMessageStream` in `@keith/client` |
| `eharness/http`, `client`, `providers` are still Draft | Pin 0.9.0; conformance + e2e catch changes on upgrade |
| The team adapters contain team-specific features (instruction marks, budget ledger) | Trimmed; the conformance suite decides whether it is enough |
| The dev key `data/secret.key` is lost | Credentials must be re-entered; a warning in the log at boot and in `SECURITY.md` |
| A file passes 800 lines (the team adapter is 698 lines) | Split per port from the start |

## Execution notes

Executed Oct 26, 2026. The last part (TUI terminal bugs and documentation) was done by a Sonnet 5.5 subagent, then reviewed and committed by the orchestrating session.

| Step | Finding | Handling |
| --- | --- | --- |
| 1 | `bun pm pkg set dependencies.x=catalog:` is enough; `bun add` per package is not needed | All new dependencies go through the catalog |
| 3 | Table names follow team: `eh_state`, `eh_inbox`, plus `eh_inbox_keys` (the plan wrote `eh_states`, `eh_inbox_items`) | Noted in `docs/specs/db.md` |
| 3 | `migrate.ts` in `packages/db` read env, violating hard rule 10 | The `db:migrate` script moved to `apps/core/src/migrate.ts` (uses `loadConfig`); the root `db:migrate` calls it |
| 3 | check-imports flagged `drizzle.config.ts` for using a devDependency | `*.config.ts` files count as dev code |
| 4 | `lock` is a per-session option, not an agent option | Wired through the `session` hook in `createHarnessHttp` |
| 4 | eharness skips a `turn.prepare` hook that throws (`W_HOOK_FAILED`) then uses the default model; a model string would be sent to the AI Gateway over the network | `unconfiguredModel`: a local model that always fails with a clear message; the turn ends with an `eh.notice` with no network call |
| 4 | gitleaks blocked the commit because of a fake key in a test | Test keys are generated at runtime |
| 4 | A boot error showed as a stack trace | `main.ts` prints it as one log line |
| 5 | The client needs `@orpc/contract` for types | Added as a dependency |
| 6 | The P0 spike succeeded: `useChat` (`@ai-sdk/react`) + `createReactBindings` run in Ink; the fallback `readUIMessageStream` is only used in `client.reply()` | As planned |
| 6 | The TUI allowlist in P0 (only ink, react) conflicts with the P2 chat stack | The allowlist covers `@ai-sdk/react`, `ai`, `eharness/client(/react)`; eharness core stays banned |
| 6 | Fast typing or paste lost letters | `TextInput` edits the latest value through a ref |
| 6 | A send error from the chat session was not shown | `notify` wired; the message shows in the chat |
| 6 | The TUI looked frozen when tested with `expect … sleep` | Not an app bug: `sleep` does not read the pty, the macOS ±1 KB buffer fills, and the process stalls in `write(2)` (749/749 samples). PTY tests now use `Bun.spawn({ terminal })` |
| 6 | In CI (act, emulated Linux amd64) 4 TUI tests failed | An Enter sent before `useInput` is active is lost → `pressUntil`; Ink prints only the final frame when `CI` is set → `CI*` env stripped in PTY tests |
| 7 | Function names in code differ from the plan (`verifyAuthorization`, `roleModel(role, providers)`, `createCore`) | Specs were written to follow the code |

### M1 gate evidence

| Evidence | Result |
| --- | --- |
| The SQLite adapters are correct | eharness conformance green: MessageAdapter, StateAdapter, InboxAdapter (pending, retry, dead-letter, stats, dedupe), ProfileStore, SessionLock: 63 tests in `packages/db` |
| End-to-end chat | `apps/core/src/e2e.test.ts` (9 tests): the real core through `@keith/client`, the answer streams (more than one snapshot), the text equals the script |
| Survives a restart | A new core on the same DB file returns all four messages and the model choice; the first token is not printed again |
| Auth | Wrong token: 401 on `/rpc` and `/sessions`; another person's session: 404; `/health` is open |
| Secrets do not leak | The `put` response, `list` and the DB column do not contain the key; the DB holds only `~sealed`; changing `baseURL` without a key is rejected |
| Model per role | Switching `scripted:a` → `scripted:b` applies on the next turn without a restart |
| No model | The turn ends with an `eh.notice` "No model … (/connect) … (/model)", with no network call |
| Migrations | An empty DB is refused with the message `bun run db:migrate`; after migrating, the core boots |
| TUI | 7 Ink tests (chat, `/help`, `/connect` with a masked secret, redacted `/providers`, `/model` with a filter) + 2 real PTY tests (send a message, history with a notice) |
| Real processes | `db:migrate` → `main.ts` → `/health` (`0.0.0`, commit SHA) → rpc → TUI login (`client.json` mode 0600) → chat and `/connect` in a pty |
| `bun run check` from a clean clone | Exit 0, 130 tests, 12 seconds; lockfile unchanged |
| `act push -j check` | Every step green including `bun run check` (130/0) and `bun audit`; the post step of setup-bun failed because of the act environment |
| `gitleaks git` | No leaks |

Not yet proven: the demo with real OpenRouter. That waits for viandwi24 to type his own API key in the TUI (`/connect`).

## [DECIDE]

None. The default models and the registry design are already decided (ADR-0007). If you want a different model as the default, just say so before execution.
