---
id: P1-D1
title: OpenAI-compatible helper, OpenRouter and DeepSeek providers
phase: 1
wave: 1
lane: D
status: todo
owner: null
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

- [ ] Fixture tests: text deltas concatenate to the expected text, a tool call is emitted once with parsed args, and `finish` comes last exactly once.
- [ ] 401 → `ProviderError('auth', retryable: false)`. 429 → `rate_limited`, `retryable: true`.
- [ ] Abort mid-stream ends with `ProviderError('aborted')` and the fetch is aborted.
- [ ] Each plugin loads with `createFakePluginContext` and registers exactly one LLM provider with the right id.
- [ ] An opt-in live smoke test (`KEITH_LIVE=1 bun test live`) streams a short reply from each vendor. Skipped by default and in CI.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
