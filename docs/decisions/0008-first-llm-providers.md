# ADR-0008: First LLM providers: OpenRouter and DeepSeek

- **Status:** accepted
- **Date:** 2026-09-25

## Context

We need a first provider set that is cheap, broad and reliable for development, and that validates the adapter seam with two real implementations.

## Decision

- Ship `@keith/provider-openrouter` (breadth: one key, many models) and `@keith/provider-deepseek` (low cost, direct).
- Both are OpenAI-compatible, so the SDK ships `createOpenAICompatibleLlm`, and each plugin is a thin configuration of it.
- Model ids live only in config, mapped to roles (`foreground`, `background`, `utility`).
- Adapter tests use recorded SSE fixtures and never hit the network (R-13).

## Consequences

- Adding any OpenAI-compatible provider (Groq, LM Studio, Ollama's OpenAI endpoint) is a ~30-line plugin.
- Vendor-specific features (DeepSeek thinking mode, OpenRouter routing options) go through `mapRequest` / `mapChunk` hooks, not core changes.
