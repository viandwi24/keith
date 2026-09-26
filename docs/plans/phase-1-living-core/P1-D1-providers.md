---
id: P1-D1
title: OpenAI-compatible helper, OpenRouter and DeepSeek providers
phase: 1
wave: 1
lane: D
status: review
owner: agent-P1-D1
depends: [P0-04]
owns:
  - packages/sdk/src/providers/openai-compatible/**
  - packages/sdk/src/index.ts
  - plugins/provider-openrouter/**
  - plugins/provider-deepseek/**
reads:
  - docs/architecture/providers.md
  - docs/contracts/providers.md
  - docs/contracts/plugin-api.md
  - docs/decisions/0004-keith-owns-the-agent-loop.md
  - docs/decisions/0008-first-llm-providers.md
updates:
  - docs/architecture/providers.md
scenarios: [S-2]
---

# P1-D1: OpenAI-compatible helper, OpenRouter and DeepSeek providers

## Goal

Keith can think with DeepSeek or with any model on OpenRouter through the `LlmProvider` seam, and adding the next OpenAI-compatible vendor is trivial.

## Scope

**In:**
- **Read the official API docs first**: OpenRouter (quickstart, streaming, tool calling, models endpoint) and DeepSeek (chat completions, streaming, tool calls, thinking mode). Record the doc URLs and the date checked in the Outcome.
- `createOpenAICompatibleLlm` in `packages/sdk/src/providers/openai-compatible/` per [contracts/providers.md](../../contracts/providers.md): request mapping, SSE parser, streamed tool-call assembly, reasoning deltas, usage, error mapping with `retryable`, abort, and tool-name mapping (`.` ↔ `__`). Export it from `@keith/sdk`.
- `@keith/provider-openrouter`: plugin kind `provider`. Config `apiKey`, optional `appTitle`, `siteUrl`, and `baseUrl` override. Sends attribution headers. `listModels` via the models endpoint.
- `@keith/provider-deepseek`: plugin kind `provider`. Config `apiKey`, `baseUrl` override. Maps `LlmRequest.reasoning` to DeepSeek's thinking option, and its reasoning stream to `reasoning.delta`.
- **Fixtures:** SSE responses for text-only, a tool call split across chunks, parallel tool calls, reasoning, error 401 and error 429, committed under each package's `test/fixtures/` and replayed through an injected `fetch`. Record them from the real APIs if you have keys (scrub keys and ids). If you don't, build them synthetically from the official docs' examples, mark each file `synthetic` in a header comment, and create a follow-up task to re-record.

**Out:**
- Retries (core decides). Model selection logic (config + registry, A1).

## Acceptance criteria

- [x] Fixture tests: text deltas concatenate to the expected text, a tool call is emitted once with parsed args, and `finish` comes last exactly once.
- [x] 401 → `ProviderError('auth', retryable: false)`. 429 → `rate_limited`, `retryable: true`.
- [x] Abort mid-stream ends with `ProviderError('aborted')` and the fetch is aborted.
- [x] Each plugin loads with `createFakePluginContext` and registers exactly one LLM provider with the right id.
- [x] An opt-in live smoke test (`KEITH_LIVE=1 bun test live`) streams a short reply from each vendor. Skipped by default and in CI.
- [x] `bun run check` passes.

## Outcome

**Built**

- `createOpenAICompatibleLlm` in `packages/sdk/src/providers/openai-compatible/` (`provider.ts`, `request.ts`, `accumulator.ts`, `sse.ts`, `errors.ts`, `wire.ts`). It's exported from `@keith/sdk` together with `toWireToolName`/`fromWireToolName`, and it uses plain `fetch` with no vendor SDK. It covers request mapping, an SSE decoder (comments, split reads, CRLF, multi-line data), zod-validated chunks (R-9), streamed tool-call assembly (per index, emitted once each when a `finish_reason` arrives, `{}` for empty args, `{ __raw }` for bad JSON), reasoning deltas (`reasoning_content` and `reasoning`), usage (including cached tokens), finish-reason mapping with exactly one `finish` last, error mapping to `ProviderError` (status and OpenRouter `error_type`, mid-stream error chunks), abort (an internal controller aborts the fetch and cancels the reader, then `ProviderError('aborted')`), and generic `listModels` via `GET /models`. There are 28 unit tests next to the code.
- `@keith/provider-openrouter`: config `apiKey`, `appTitle` (default `Keith`), `siteUrl?` and `baseUrl?`. It sends the attribution headers `X-OpenRouter-Title` and `HTTP-Referer`, maps `reasoning` to `reasoning.effort` (`off` → `none`), and supports `listModels`.
- `@keith/provider-deepseek`: config `apiKey` and `baseUrl?`. It maps `reasoning` to `thinking` + `reasoning_effort`, streams `reasoning_content` as `reasoning.delta`, and supports `listModels`.
- Fixtures under each plugin's `test/fixtures/`: text, tool call split across chunks, parallel tool calls, reasoning, errors 401 and 429, and models, plus a mid-stream error for OpenRouter. They're replayed through an injected `fetch` in 37-byte pieces. Opt-in live smoke tests are in `plugins/*/test/live.test.ts` (`KEITH_LIVE=1` plus API key and model env vars).
- `docs/architecture/providers.md` now describes the helper's behavior, both plugins, and the DeepSeek limitation.

**Docs checked (2026-09-26)**

- OpenRouter: https://openrouter.ai/docs/quickstart.md, https://openrouter.ai/docs/api_reference/streaming, https://openrouter.ai/docs/guides/features/tool-calling, https://openrouter.ai/docs/guides/best-practices/reasoning-tokens, https://openrouter.ai/docs/api_reference/errors-and-debugging, https://openrouter.ai/docs/app-attribution, https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
- DeepSeek: https://api-docs.deepseek.com/ (first call), https://api-docs.deepseek.com/api/create-chat-completion, https://api-docs.deepseek.com/guides/thinking_mode, https://api-docs.deepseek.com/guides/tool_calls, https://api-docs.deepseek.com/quick_start/error_codes, https://api-docs.deepseek.com/api/list-models

**Decisions and deviations**

- **Fixtures are synthetic.** No API keys were available, so each fixture was built from the official docs' examples and says `synthetic` in its header: an SSE comment for `.sse` files, a `_fixture` field for `.json` files.
- **DeepSeek thinking with tools is disabled.** DeepSeek enables thinking mode by default. In thinking mode, every request that carries `tools` must replay each earlier assistant message's `reasoning_content`, or DeepSeek returns 400. `LlmMessage` (frozen contract) has no field for it, so the adapter sends `thinking: { type: 'disabled' }` whenever `tools` is non-empty, and `reasoning` only takes effect on tool-less requests. The contract lets adapters map or ignore `reasoning`, so this needs no ADR now.
- The helper also implements `listModels` for any vendor, since both first vendors expose `GET /models`. The contract only requires it for OpenRouter.
- The helper adds `stream_options.include_usage` to every request. Both vendors accept it, and some other OpenAI-compatible servers need it to report usage.
- HTTP 402 (no credits) and 403 map to `auth` (not retryable, a human must act). OpenRouter's content-policy `error_type`s map to `bad_request`.
- A body that ends with neither a finish reason nor `[DONE]` throws `unavailable`. `[DONE]` without a finish reason ends with `finish: 'other'`.
- `Retry-After` is not surfaced because `ProviderError` has no field for it.
- Dependency added: `zod@^4.6.5` in both plugin packages (`bun add zod`), the same version as `@keith/sdk`.

**Follow-ups (for the coordinator to create)**

1. **Re-record provider fixtures from the live APIs** (owns `plugins/provider-openrouter/test/fixtures/**` and `plugins/provider-deepseek/test/fixtures/**`). Record each scenario with real keys, scrub keys and ids, drop the `synthetic` headers, and keep the tests green.
2. **Contract proposal: an optional `reasoning` field on assistant `LlmMessage`s**, stored by the core and replayed by adapters (additive). The DeepSeek adapter could then keep thinking on with tools. This needs an ADR, a contract task and a core task.
3. Possibly add `retryAfterMs` on `ProviderError` (additive contract) if the core's retry policy wants it.
4. OpenRouter rejects `reasoning.effort: 'none'` for models whose reasoning is mandatory. If that bites, the adapter could consult `listModels` metadata.
