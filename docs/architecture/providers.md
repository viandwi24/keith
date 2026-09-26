# Providers

Providers are adapters to the engines Keith thinks and speaks with. They are one of the two places where Keith deliberately abstracts before a second implementation exists, because a second one is guaranteed from day one: cloud vs cheap vs local ([ADR-0007](../decisions/0007-adapters-only-with-two-implementations.md)).

Interfaces: [contracts/providers.md](../contracts/providers.md).

## Seams

One seam per engine role. There is no umbrella "voice protocol" abstraction.

| Seam | Interface | First adapters | Phase |
|---|---|---|---|
| LLM | `LlmProvider` | **OpenRouter**, **DeepSeek** | 1 |
| Speech-to-text | `SttProvider` | decided in phase 3 (one local, one cloud) | 3 |
| Text-to-speech | `TtsProvider` | decided in phase 3 (one local, one cloud) | 3 |
| Voice activity | `VadProvider` | decided in phase 3 | 3 |
| Speech-to-speech | `RealtimeProvider` | decided in phase 8 | 8 |

## LLM

### Model refs and roles

A model is addressed as `<providerId>:<modelId>`, e.g. `deepseek:deepseek-flash` or `openrouter:~openai/gpt-sol-latest`. Everything after the first `:` is passed to the provider unchanged.

Core code never names a model. It asks for a **role**, and config maps roles to refs:

| Role | Used for | Wants |
|---|---|---|
| `foreground` | User turns, delivery and briefing turns | Quality + low latency |
| `background` | Tasks | Quality + low cost; latency matters less |
| `utility` | Summaries, classification (addressing, phase 5) | Cheapest acceptable |

```toml
[models]
foreground = "deepseek:deepseek-flash"
background = "deepseek:deepseek-flash"
utility    = "openrouter:<cheap-model-id>"   # illustrative: roles may use different providers
```

Model ids change often. Verify current ids in the provider's official docs when configuring. Don't hardcode ids in code or tests (tests use the fake provider).

### The loop belongs to Keith

Providers only **stream one completion**. They never loop over tool calls ([ADR-0004](../decisions/0004-keith-owns-the-agent-loop.md)). The turn loop in `core/src/mind` owns multi-step tool use, cancellation, deliveries and interrupts.

### OpenAI-compatible helper

OpenRouter and DeepSeek both expose OpenAI-compatible Chat Completions with streaming and tool calls, so `@keith/sdk` ships `createOpenAICompatibleLlm({ id, baseUrl, apiKey, headers?, fetch?, mapRequest?, mapChunk? })` (contract: [providers.md](../contracts/providers.md#createopenaicompatiblellm)). It handles:

- request mapping (Keith messages and tools → `chat/completions` body)
- SSE parsing and normalization into `LlmEvent`s (text deltas, reasoning deltas, streamed tool-call argument assembly, finish reason, usage)
- error mapping into `ProviderError` codes (`auth`, `rate_limited`, `bad_request`, `unavailable`, `timeout`)
- `AbortSignal` propagation

Each provider plugin is a thin configuration of this helper:

| Plugin | Base URL | Notes |
|---|---|---|
| `@keith/provider-openrouter` | `https://openrouter.ai/api/v1` | Optional headers `HTTP-Referer` and `X-OpenRouter-Title` (app attribution). Model list: `GET /models` |
| `@keith/provider-deepseek` | `https://api.deepseek.com` | Supports a "thinking" mode. Map it to `reasoning.delta` events and expose it as a per-request `reasoning` option |

Verify both against their official docs when implementing (task P1-D1). APIs evolve, and this table records what was true on 2026-09-25.

Adding another provider (Anthropic, Gemini, Ollama, LM Studio) is a new plugin. If it's OpenAI-compatible, it reuses the helper. If not, it implements `LlmProvider` directly.

## Voice (phase 3)

See [voice.md](voice.md). The core runs the voice pipeline, so provider choice is one config section, not per node.
