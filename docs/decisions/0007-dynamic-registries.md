# 0007. Dynamic registries: definitions in code, instances as data

Status: Accepted (2026-10-26)

## Context

Keith will be extended by plugins. Things that grow (model providers, models, connectors, worker
types, node capabilities) must not be hard-coded in the core or in a client. The owner must be
able to add a provider connection, enter its credentials and extra fields (base URL, headers,
API key) and pick models, the way `examples/team` does.

## Decision

- Every growing thing has a registry. Code (core or a plugin) registers a **definition** with a
  zod settings schema; the user creates **instances** (data) through a form generated from that
  schema (`formSpec` of `eharness/providers`). Clients render forms from the schema; they never
  know provider-specific fields.
- Model providers use `eharness/providers` as is: `createProviderManager`, provider profiles
  (connections) in a `ProfileStore`, models from `listModels` plus the public catalogs, and model
  references `profile:model`. Agents get their model by reference, chosen per role.
- **OpenRouter is the first and default provider** (`openRouterProvider` with
  `@openrouter/ai-sdk-provider`). `OPENROUTER_API_KEY` in the environment becomes a read-only
  connection. The first three providers are OpenRouter, OpenAI (`openAIProvider`) and DeepSeek
  (a local `defineProvider` over `@ai-sdk/deepseek`).
- Secrets are sealed at rest: `sealedProfileStore` with `webCryptoVault` (AES-256-GCM),
  key `KEITH_SECRET_KEY` (dev: `data/secret.key`, git-ignored). The API returns redacted
  profiles only.
- One table (`config_profiles`, keyed by `kind` + `id`) holds provider connections now and other
  kinds (connectors, channels) later.
- Plugins register definitions through `@keith/host`; the core never imports a plugin.

## Consequences

- Adding a provider is one definition, no client change.
- `eharness/providers` is Draft: profile shapes may change on upgrade; the SQLite adapter is
  guarded by `profileStoreConformance`.
- Losing `KEITH_SECRET_KEY` makes stored credentials unreadable; the owner re-enters them.
