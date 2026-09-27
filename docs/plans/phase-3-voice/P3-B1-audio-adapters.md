---
id: P3-B1
title: "OpenAI-compatible STT/TTS helpers and the Groq, OpenAI and speaches voice plugins"
phase: 3
wave: 2
lane: B
status: in-progress
owner: agent-P3-B1
depends: [P3-K1]
owns:
  - packages/sdk/src/providers/openai-audio*
  - plugins/voice-groq/**
  - plugins/voice-openai/**
  - plugins/voice-speaches/**
reads:
  - docs/contracts/providers.md
  - docs/architecture/providers.md
  - docs/contracts/plugin-api.md
  - docs/decisions/0013-voice-v1-transport-and-providers.md
  - docs/plans/phase-1-living-core/P1-D1-providers.md
updates:
  - docs/architecture/providers.md
scenarios: [S-7]
---

# P3-B1: Audio helpers and voice provider plugins

## Goal

Implement the two helpers P3-K1 declared: `createOpenAICompatibleStt` and `createOpenAICompatibleTts`. Also ship the three adapter plugins ADR-0013 names: cloud STT (Groq), cloud TTS (OpenAI), and local STT + TTS (speaches). Tests never hit the network.

## Scope

**In:**
- `packages/sdk/src/providers/openai-audio.ts` (+ tests), replacing the K1 placeholders:
  - **STT:** `transcribe(audio)` wraps PCM16 in a WAV header and POSTs multipart to `<baseUrl>/audio/transcriptions` (`model`, `file`, optional `language` and `prompt`, `response_format: json`). Returns `{ text, language? }`.
  - **TTS:** `stream(text)` accepts a string or an `AsyncIterable<string>`, POSTs each text piece to `<baseUrl>/audio/speech` with `response_format: "pcm"`, and yields `AudioChunk`s (`pcm16`, 24000 Hz by default) as the body streams.
  - Both map errors to `ProviderError` codes like the LLM helper does, honor `signal` (ending with `ProviderError('aborted')`), never retry, and never log keys.
- **Plugins** (`bun init` and `bun add` inside each; `kind: 'provider'`; each has a zod config with `apiKey` as `env:` / `baseUrl` / `model` / `voice`):
  - `plugins/voice-groq`: registers an `SttProvider` with id `groq` (default base `https://api.groq.com/openai/v1`, model `whisper-large-v3-turbo`).
  - `plugins/voice-openai`: registers a `TtsProvider` with id `openai` (default model `gpt-4o-mini-tts`, a default voice).
  - `plugins/voice-speaches`: registers an `SttProvider` and a `TtsProvider`, both with id `speaches` (default base `http://127.0.0.1:8000/v1`, no key).
- Recorded fixtures: a JSON transcription response, and a small PCM body delivered in several chunks.

**Out:** VAD (P3-D1), the core pipeline (P3-A1), `keith setup` questions (P3-I1), streaming STT, ElevenLabs.

## Acceptance criteria

- [ ] STT: the request is multipart with a valid WAV (the header is checked in the test), the model and the language. A 401 maps to `ProviderError('auth')` and a 429 to `rate_limited`.
- [ ] TTS: chunked fixture bodies become `AudioChunk`s whose bytes, concatenated, equal the fixture. An `AsyncIterable` text input makes one request per piece, in order.
- [ ] Aborting mid-stream throws `ProviderError('aborted')` and cancels the body reader.
- [ ] Each plugin's `setup` registers the right provider ids, and an invalid config fails plugin validation.
- [ ] `bun run check` passes.

## Notes

- Follow `createOpenAICompatibleLlm` in `packages/sdk/src/providers/` for error mapping and the injectable `fetch`.
- The speaches TTS model/voice ids (e.g. `speaches-ai/Kokoro-82M-v1.0-ONNX`, `af_heart`) change between releases. Put the defaults in config with a comment, not in code paths. Check speaches' current docs before choosing them.

## Outcome

_Filled by the agent when finishing._
