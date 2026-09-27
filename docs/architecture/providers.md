# Providers

Providers are adapters to the engines Keith thinks and speaks with. They are one of the two places where Keith deliberately abstracts before a second implementation exists, because a second one is guaranteed from day one: cloud vs cheap vs local ([ADR-0007](../decisions/0007-adapters-only-with-two-implementations.md)).

Interfaces: [contracts/providers.md](../contracts/providers.md).

## Seams

One seam per engine role. There is no umbrella "voice protocol" abstraction.

| Seam | Interface | First adapters | Phase |
|---|---|---|---|
| LLM | `LlmProvider` | **OpenRouter**, **DeepSeek** | 1 |
| Speech-to-text | `SttProvider` | **Groq** (cloud), **speaches** (local), [ADR-0013](../decisions/0013-voice-v1-transport-and-providers.md) | 3 |
| Text-to-speech | `TtsProvider` | **OpenAI** (cloud), **speaches** (local), ADR-0013 | 3 |
| Voice activity | `VadProvider` | **energy** (pure TypeScript), ADR-0013 | 3 |
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

OpenRouter and DeepSeek both expose OpenAI-compatible Chat Completions with streaming and tool calls, so `@keith/sdk` ships `createOpenAICompatibleLlm({ id, baseUrl, apiKey, headers?, fetch?, mapRequest?, mapChunk? })` (contract: [providers.md](../contracts/providers.md#createopenaicompatiblellm); code: `packages/sdk/src/providers/openai-compatible/`). It uses plain `fetch`, no vendor SDK. It handles:

- **Request mapping.** `POST <baseUrl>/chat/completions` with `stream: true` and `stream_options.include_usage`. `system` becomes a leading system message (omitted when empty), `maxOutputTokens` becomes `max_tokens`, assistant tool calls go back as `tool_calls` with JSON-string arguments (`{ __raw }` args are sent back verbatim), and a user `name` is reduced to `[a-zA-Z0-9_-]{1,64}` or dropped. `reasoning` is not mapped by the helper: each plugin maps it in `mapRequest`.
- **Tool names.** Keith names contain dots, which some vendors reject, so they go on the wire as `.` → `__` and come back as `__` → `.` (`toWireToolName` / `fromWireToolName`). This is reversible because Keith names never contain a double underscore.
- **SSE parsing.** Comment lines (OpenRouter's `: OPENROUTER PROCESSING` keep-alive) are skipped, events may be split across network reads, and `data: [DONE]` ends the stream. Every chunk is validated with a loose zod schema (R-9).
- **Normalization into `LlmEvent`s.** `delta.content` → `text.delta`; `delta.reasoning_content` (DeepSeek) or `delta.reasoning` (OpenRouter) → `reasoning.delta` (OpenRouter's parallel `reasoning_details` are ignored so text isn't doubled). Tool-call deltas are assembled per `index` (a new `id` at a reused index starts a new call) and emitted once each, in index order, when the vendor sends a `finish_reason`. Empty arguments parse as `{}`, and unparseable ones as `{ __raw }`. The one `finish` is emitted after `[DONE]` (or the end of the body), with the last `finish_reason` and `usage` seen. OpenRouter repeats `finish_reason` on its final usage chunk, and that doesn't produce a second `finish`. `usage` maps `prompt_tokens`, `completion_tokens` and `prompt_tokens_details.cached_tokens` (or DeepSeek's `prompt_cache_hit_tokens`). Unknown finish reasons map to `other`.
- **`mapChunk`.** It gets each parsed chunk first. Returning events replaces the default mapping of that chunk, and returning `undefined` keeps the default. A `finish` it returns only sets the reason and usage, so there is still exactly one `finish`, last.
- **Errors.** Everything thrown is a `ProviderError`:

  | Cause | Code |
  |---|---|
  | HTTP 401, 402 (no credits), 403 | `auth` |
  | HTTP 408, 504, 524 | `timeout` |
  | HTTP 429 | `rate_limited` |
  | other 4xx | `bad_request` |
  | 5xx, network failure, body ends with neither a finish reason nor `[DONE]` | `unavailable` |
  | malformed chunk | `unknown` |
  | the caller's signal aborted | `aborted` |

  OpenRouter's `error.metadata.error_type` takes precedence over the status when present (e.g. `content_policy_violation` → `bad_request`). A mid-stream `error` chunk (OpenRouter sends these with HTTP 200) is thrown with the code from its `error.code`. Messages carry the vendor's message, clipped, and never the key. `Retry-After` isn't surfaced: the contract has no field for it.
- **Abort.** The request runs on an internal `AbortController` linked to the caller's signal. On abort, or when the consumer stops iterating, the HTTP request is aborted and the body reader cancelled. An abort ends the iterator with `ProviderError('aborted')`.
- **`listModels`.** `GET <baseUrl>/models`: `id`, `contextWindow` from `context_length` (OpenRouter) or `context_window` (DeepSeek), and `supportsTools` from OpenRouter's `supported_parameters`.

Each provider plugin is a thin configuration of this helper:

| Plugin | Base URL | Config | Notes |
|---|---|---|---|
| `@keith/provider-openrouter` | `https://openrouter.ai/api/v1` | `apiKey`, `appTitle` (default `Keith`), `siteUrl?`, `baseUrl?` | Attribution headers: `X-OpenRouter-Title` from `appTitle`, `HTTP-Referer` from `siteUrl` (OpenRouter needs the referer to create an app page). `reasoning` → `reasoning: { effort }`, with `off` → `effort: 'none'`. Model list: `GET /models` |
| `@keith/provider-deepseek` | `https://api.deepseek.com` | `apiKey`, `baseUrl?` | Thinking mode is **on by default** at DeepSeek. `reasoning: 'off'` → `thinking: { type: 'disabled' }`; `low` → `thinking` enabled with `reasoning_effort: 'low'`; `medium`/`high` → `reasoning_effort: 'high'`; unset leaves DeepSeek's default. `reasoning_content` streams as `reasoning.delta`. Model list: `GET /models` |

**Known limitation (DeepSeek thinking and tools).** In thinking mode, a request that carries `tools` must send back the `reasoning_content` of every earlier assistant message, or DeepSeek returns 400. `LlmMessage` has no field for it, so the DeepSeek adapter sends `thinking: { type: 'disabled' }` on every request that carries tools. Reasoning with tools needs an additive contract change (an optional reasoning field on assistant messages that the core stores and replays). That's a follow-up to P1-D1.

Verified against the official docs on 2026-09-26: OpenRouter [streaming](https://openrouter.ai/docs/api_reference/streaming), [tool calling](https://openrouter.ai/docs/guides/features/tool-calling), [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [errors](https://openrouter.ai/docs/api_reference/errors-and-debugging), [app attribution](https://openrouter.ai/docs/app-attribution) and [models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties); DeepSeek [chat completion](https://api-docs.deepseek.com/api/create-chat-completion), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), [tool calls](https://api-docs.deepseek.com/guides/tool_calls), [error codes](https://api-docs.deepseek.com/quick_start/error_codes) and [list models](https://api-docs.deepseek.com/api/list-models). APIs evolve, so re-check them when these adapters change.

Tests replay SSE fixtures from each plugin's `test/fixtures/` through an injected `fetch`. The current fixtures are **synthetic**: they were built from the docs' examples, and each file says so in its header. Re-recording them from the live APIs is a follow-up. `KEITH_LIVE=1 bun test live` runs an opt-in smoke test per vendor. It needs `OPENROUTER_API_KEY` + `KEITH_LIVE_OPENROUTER_MODEL` and `DEEPSEEK_API_KEY` + `KEITH_LIVE_DEEPSEEK_MODEL`, and it's skipped otherwise.

Adding another provider (Anthropic, Gemini, Ollama, LM Studio) is a new plugin. If it's OpenAI-compatible, it reuses the helper. If not, it implements `LlmProvider` directly.

## Voice (phase 3)

See [voice.md](voice.md). The core runs the voice pipeline, so provider choice is one config section (`[voice]`, naming a `vad`, `stt` and `tts` provider id), not per node.

The Groq, OpenAI and speaches services all speak the OpenAI audio API, so `@keith/sdk` has `createOpenAICompatibleStt` and `createOpenAICompatibleTts` (contract: [providers.md](../contracts/providers.md#openai-compatible-audio); code: `packages/sdk/src/providers/openai-audio.ts`). Each voice plugin is a thin configuration of them, like the LLM plugins:

| Plugin | Namespace | Registers | Default base URL | Config (`[plugins."<id>"]`) |
|---|---|---|---|---|
| `@keith/voice-groq` | `voice_groq` | STT `groq` | `https://api.groq.com/openai/v1` | `apiKey` (required), `baseUrl`, `model` (`whisper-large-v3-turbo`) |
| `@keith/voice-openai` | `voice_openai` | TTS `openai` | `https://api.openai.com/v1` | `apiKey` (required), `baseUrl`, `model` (`gpt-4o-mini-tts`), `voice` (`alloy`) |
| `@keith/voice-speaches` | `speaches` | STT and TTS `speaches` | `http://127.0.0.1:8000/v1` | `apiKey` (optional), `baseUrl`, `sttModel`, `ttsModel`, `voice`, `sampleRate` (24000) |
| `@keith/vad-energy` | `vad_energy` | VAD `energy` | none (in process) | all optional: `frameMs` (20), `startDb` (12), `endDb` (8), `minSpeechMs` (120), `hangoverMs` (500), `floorMinDb` (-70), `floorRiseMs` (1500), `floorFallMs` (150) |

The Groq and OpenAI plugins use `voice_*` namespaces so that `groq` and `openai` stay free for LLM plugins of the same vendors. speaches' model and voice ids change between releases, so their defaults (`Systran/faster-whisper-small`, `speaches-ai/Kokoro-82M-v1.0-ONNX`, `af_heart`) live only in the plugin's config schema.

How the helpers behave, beyond the contract:

- **STT** sends the utterance as `audio.wav` (a 44-byte PCM WAV header at the chunk's `sampleRate`) and trims the returned text. Audio that isn't `pcm16` is refused with `ProviderError('bad_request')` before any request.
- **TTS** skips empty or whitespace-only text pieces (every vendor rejects an empty `input`). When a body read ends mid-sample, the odd byte is carried to the next chunk, so every `AudioChunk` holds whole samples; a trailing half sample at the end of a body is dropped.
- Both omit the `authorization` header when no `apiKey` is set, and race every await (request, body read, next text piece) against the call's `signal`, so an abort ends with `ProviderError('aborted')` even if the vendor or the text source stalls. Aborting or leaving the TTS iterator early cancels the body reader and closes the request.

