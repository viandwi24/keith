# Providers

Code: `apps/core/src/modules/providers/` (`service.ts`, `role-model.ts`, `unconfigured-model.ts`,
`router.ts`), `apps/core/src/platform/vault.ts`, `packages/contracts/src/{providers,models,contract}.ts`.
Design: ADR-0007 (dynamic registries).

## Purpose

The registry of model providers: definitions in code, connections (instances) as data, models per
connection, and one model per agent role. Clients render forms from the schema and know nothing
provider-specific.

## Service: `createProviderService(options)`

Options: `store` (a `ProfileStore`, sealed), `settings` (`SettingsRepo`), `cache?`, `env?`,
`definitions?`, `catalogs?`, `fetch?`, `warn?`. It wraps `createProviderManager` from
`eharness/providers`. Three providers are always registered, in this order: OpenRouter
(`openRouterProvider`, the default), OpenAI (`openAIProvider({ createOpenAI })`, `@ai-sdk/openai`)
and DeepSeek (`deepSeekProvider()` in `deepseek.ts`: a local `defineProvider` over
`@ai-sdk/deepseek`, because eharness 0.9.0 has no built-in; settings `apiKey` secret, `baseURL`
default `https://api.deepseek.com`, `headers`; `listModels` is `GET <baseURL>/models` with
Bearer). `definitions` are appended (plugins, tests such as `scriptedProvider`).

| Provider | Env vars (each becomes a read-only connection, `source: 'env'`) |
| --- | --- |
| `openrouter` | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` |
| `openai` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| `deepseek` | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` |

`KEITH_MODELS_DEV_URL` moves the model catalog download (prices, limits) from `https://models.dev/api.json` to
another address (a mirror; the smoke serves its own, so it never needs the network). The catalog is best effort: when it
is unreachable and nothing is cached, models have no prices and `rolePricing` reports them unpriced, so guests refuse to
enable with the usual `BAD_REQUEST` (never a crash).

`web_search` stays OpenRouter-only: with only OpenAI/DeepSeek connections it is not offered.

| Method | Behaviour |
| --- | --- |
| `ready()` | `manager.ready()`, then best-effort `loadCatalogs()` (a failed download is ignored) |
| `describe()` | Definitions with `fields` (form spec), `canListModels`, `canTest` |
| `list()` | Redacted connections |
| `put(input)` | Create (`providerId`) or edit (`id`); `settings` is a patch; `undefined` values are dropped. Returns the redacted connection |
| `remove(id)` | Delete the connection, then delete every role setting whose ref starts with `<id>:` |
| `test(id)` | `{ ok, message?, latencyMs? }` |
| `models(id, refresh?)` | Models of a connection (price per million tokens, context window, tools, reasoning) |
| `roles()` | `{ front, cortex, guest }`, each a `connection:model` ref or `null` (`guest` never has a default: `guests.md`) |
| `setRole(role, ref)` | Validates with `manager.resolve(ref)`, stores it, returns `roles()` |
| `resolveRole(role)` | The model for the next turn; throws `EH_CONFIG_INVALID` with `noModelMessage(role)` when none |
| `catalog()` | Prices and context windows for the agent `models` option |

### Model per role

Roles are `front`, `cortex` and `guest` (`ModelRoleSchema`; `PRIMARY_MODEL_ROLES` are the two setup asks for). A pick lives in `settings` under
`model.front` / `model.cortex` as `connection:model` (split on the first `:`). Without a pick, the
first enabled connection supplies a default from `PROVIDER_DEFAULTS` (checked on 26 Oct 2026;
OpenRouter in its catalog, the others in https://models.dev/api.json), else the definition's
`defaultModel`:

| Provider | `front` (fast, cheap) | `cortex` (strong) |
| --- | --- | --- |
| `openrouter` | `anthropic/claude-haiku-5.5` | `anthropic/claude-sonnet-5.5` |
| `openai` | `gpt-6-luna` ($0.1/$0.5 per M tokens) | `gpt-6.1-sol` ($2/$10, released 2026-09-29) |
| `deepseek` | `deepseek-v4-flash` ($0.15/$0.6) | `deepseek-v4-pro` ($0.66/$1.98) |

The `guest` role (P17, `guests.md`) has no default: it stays `null` until the owner picks a model.

No enabled connection, or no default: `null`.

### `roleModel(role, providers, call?)` plugin

Registers a `turn.prepare` hook that returns `{ model: await providers.resolveRole(role) }` on
every turn, so a new pick applies at the next turn with no restart or agent rebuild. If resolving
fails the hook returns `unconfiguredModel(role)` instead of throwing: eharness skips a hook that
throws (`W_HOOK_FAILED`) and the turn would hit the agent's static model.

### Router session (`providers/router-session.ts`)

The same plugin registers a `step.prepare` hook: a step whose model is an OpenRouter model (provider id `openrouter…`) gets
`providerOptions.openrouter.session_id`, the first 32 hex characters of a SHA-256 of the eharness session id. OpenRouter's
sticky routing then keeps the session on one upstream provider, so a prompt cache written on Anthropic, Bedrock or Vertex is
read on the next request (without an id, stickiness starts only after a cache hit). The value is opaque: no person id or
session id leaves the core. Other providers get nothing. Checked against `@openrouter/ai-sdk-provider` 3.1.0: the provider
copies `providerOptions.openrouter` keys into the request body.

### `resolveRoleModel(role, providers, call?)`

The model picked for `role` now, or `unconfiguredModel(role)` when none is picked or resolving
fails (it never rejects). With a `call` kind it also applies the thinking policy (see "Thinking").
`roleModel` uses it per turn; the front agent also gives it to
`compaction.model` as a function of the ctx (eharness 0.10, read once per turn), so the summary and
the memory flush run on the front role's real model, priced and sized by the agent's `models`
catalog like any turn. (Before 0.10 a static proxy model and a catalog shim did this; both are gone.)

### Thinking (`providers/thinking.ts`)

DeepSeek V4 thinks by default, and its reasoning tokens are billed as output. A call that needs no
reasoning turns it off per call: `providerOptions.deepseek.thinking = { type: 'disabled' }`, set by a
`transformParams` middleware (`withThinking`). The rule is one constant list, `NO_THINKING_CALLS`:
`dream-judge` (the dream judge, `roleModel('cortex', providers, 'dream-judge')`) and `compaction` (the
summary and the memory flush). The setting for those calls is `INFERENCE_THINKING` (`off` by default; `auto`
keeps the provider default, thinking on). It is a code constant: an owner setting `inference.thinking` is a
follow-up.

- Only a DeepSeek model is touched (its provider id starts with `deepseek`). Any other provider's model is
  returned as it is, and so is a front, worker or room call, which has no call kind and keeps the default.
- A `providerOptions.deepseek.thinking` the caller set is kept.
- The quality of a call with thinking off is not measured. `bun run eval:dreaming` (real model, owner-paid)
  compares the judge with `INFERENCE_THINKING = 'auto'` and `'off'` on the same candidates before any default changes.
- Wired: the front agent's `compaction.model` (`wernicke-broca/agent.ts`) resolves the front role with the call kind
  `compaction`, so the summary and the memory flush run with DeepSeek thinking off.

### `unconfiguredModel(role)`

A local model object (`specificationVersion: 'v4'`, id `unconfigured-<role>`) whose `doGenerate`
and `doStream` reject with `EH_CONFIG_INVALID` and the message: "No model for the <role> role yet.
Run /connect to add a provider connection, then /model to pick a model." The failure is stored as an
`eh.notice` message (see `wernicke-broca.md`). It is also the agent's static model, because a
plain model id string would go to the AI Gateway over the network.

## Tools in conversation

Decision: ADR-0034 §8. Plugin `keith-providers-model-tools` (`providers/model-tools.ts`), added to the front agent only. Both tools are the
owner's (`not-owner` for a member, `no-person` without one); a refusal is an answer `{ ok: false, reason, message }`, never a throw.

| Tool | Input | Approval | Output |
| --- | --- | --- | --- |
| `model_roles_get` | none | no (a read, `trusted`) | `{ ok: true, roles }` (`front`, `cortex`, `guest`; null when none) |
| `model_role_set` | `role` (`front`, `cortex`, `guest`), `model` (`connection:model`) | when tainted (a reversible write, see below) | `{ ok: true, role, model, roles }`, or `unknown-model` for an unknown connection or model |

`model_role_set` calls `ProviderService.setRole` (the call behind `keith-core model set` and `models.roles.set`), so validation is the same, and
writes the same audit row (`settings.model.set`, `{ role, ref }`, via `local`). The plugin has no `tool.approve` hook of its own since ADR-0036:
the tools declare `metadata` (`model_roles_get`: `risk: 'read', source: 'trusted'`; `model_role_set`: `risk: 'write', reversible: true, source: 'trusted'`) and
amygdala's consent hook decides (`amygdala.md`, "Consent"): in a clean conversation (the owner just asked, nothing outside read since) `model_role_set` runs at
once; otherwise it waits as an approval with the tier `conversation`. The tool stays in `STEP_UP_TOOLS`, so answering such an approval from a remote client
needs a step-up, and a call that runs is an elevated local owner action.

**Undo.** `ModelToolsDeps.undo` (an `UndoLog`, `platform/undo-log.ts`): after a switch whose role had a model before, the tool records how to put it back
(`setRole(role, previous)`, with its own `settings.model.set` audit row). A first pick (the role was empty) records nothing: there is no previous model to
restore. `undo_last` runs it (`amygdala.md`, "Undo"). Test: `providers/model-tools.test.ts`.

## Secrets

- `createVault(secretKey, dataDir)` (`platform/vault.ts`): `webCryptoVault` (AES-256-GCM). The key
  is `KEITH_SECRET_KEY` (32 bytes, base64; wrong size throws). Without it, a dev key is created
  once at `<dataDir>/secret.key` (mode 0600) and `devKey` is `true` so boot logs a warning.
- The store is `sealedProfileStore({ inner: sqliteProfileStore(sqlite), vault })`: secret fields
  are sealed before they reach `config_profiles.settings`.
- Redaction: `Connection.settings` carries plain values for normal fields and
  `{ set: boolean, hint?: string }` for secrets (`ConnectionSchema`). A raw key never appears in a
  response, a list, a log or the database. Editing the base URL without resending the key drops
  the stored key.
- Losing or changing the key makes stored credentials unreadable; the owner re-enters them (OWN-012). An
  unreadable row never stops `keith-core start`, `setup`, `token recover`, `auth * reset` or `doctor`: the sealed store is built with
  `onUnreadable`, which skips the row (it stays in `config_profiles` until re-entered). The tracker
  (`modules/providers/unreadable.ts`) logs one warning, writes one audit row `settings.unreadable`
  (detail `{ keys: ['provider:<id>'] }`, never a value; actor `system`, via `local` in core or `offline`) and keeps the id. `providers.list` then
  adds that connection as `{ id, enabled: false, needsReentry: true }` (`Connection.needsReentry`), and
  `doctor` shows `! provider <id> — doctor cannot read the key the core uses: run it with the same KEITH_SECRET_KEY` (a note, read only, P23.4.6; the core itself still shows `needs re-entry`). A `providers.put` (or `keith-core provider add`) with the same id
  replaces the row and clears the mark. A role pick that names the connection stays and works again after re-entry.

## oRPC procedures (`keithContract`, mounted at `/rpc`)

Capabilities (`permissions.md`): `describe`, `models`, `models.roles.get` and `models.price.list` need `settings.read`; `list` and `test` need `settings.manage`; `put`, `remove`, `models.roles.set`, `models.price.set` and `models.price.clear` need `settings.manage` and a step-up over TCP.

| Procedure | Input | Output |
| --- | --- | --- |
| `health.get` | none | `Health` |
| `providers.describe` | none | `ProviderDescription[]` |
| `providers.list` | none | `Connection[]` |
| `providers.put` | `ConnectionInput` (`id` `^[a-z0-9][a-z0-9-]*$`, `providerId`, `label`, `enabled`, `settings`) | `Connection` |
| `providers.remove` | `{ id }` | `{ ok: true }` |
| `providers.test` | `{ id }` | `TestResult` |
| `providers.models` | `{ id, refresh? }` | `Model[]` |
| `models.roles.get` | none | `ModelRoles` |
| `models.roles.set` | `{ role, ref }` (`ref` matches `^[a-z0-9][a-z0-9-]*:.+$`) | `ModelRoles` |
| `models.price.list` | none | `ModelPrice[]` (manual prices, `settings.read`) |
| `models.price.set` | `ModelPrice` `{ ref, inputPerMTokUsd, outputPerMTokUsd }` (USD per million tokens, 0 to 10000; the connection must exist) | `ModelPrice` (`settings.manage`, step-up) |
| `models.price.clear` | `{ ref }` | `{ ok: true }`, `NOT_FOUND` when the model has no manual price (`settings.manage`, step-up) |

Errors: an `EH_CONFIG_INVALID` from eharness (unknown connection or model, invalid settings)
becomes oRPC `BAD_REQUEST` with its message (`rpcError`). Any other error is a 500 whose message
does not leave the server. Input that fails the zod schema is rejected by oRPC before the handler.

## Invariants

- OpenRouter, OpenAI and DeepSeek are registered in that order; OpenRouter is the default.
- No secret in clear on the wire, in the database or in logs.
- Removing a connection never leaves a role pointing at it.
- Connections and roles are data; the core never imports a plugin to add a provider.

## Tests

`providers/router-session.test.ts` (an OpenRouter step gets a stable, opaque session id per session; other providers none), `providers/thinking.test.ts` (thinking off per call on DeepSeek for the no-thinking calls only; the caller's own option kept; `auto` and other providers untouched), `providers/service.test.ts` (OpenRouter, OpenAI, DeepSeek in order with secret key fields; DeepSeek key sealed, `/models` parsing, env connections, per-provider role defaults, `deepseek:` resolve, web search OpenRouter-only; key never returned or stored
in clear; base URL change drops the key; role defaults; pick resolved on every call and unknown
refs refused; removal clears roles), `platform/vault.test.ts` (seal, dev key file 0600, bad key
size), `e2e.test.ts` (role switch applies to the next turn, credentials never come back in clear,
no-model notice), `packages/contracts` schema tests (no raw secret in `ConnectionSchema`).
