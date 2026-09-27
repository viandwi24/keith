---
id: P3-B1
title: "OpenAI-compatible STT/TTS helpers and the Groq, OpenAI and speaches voice plugins"
phase: 3
wave: 2
lane: B
status: done
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

- [x] STT: the request is multipart with a valid WAV (the header is checked in the test), the model and the language. A 401 maps to `ProviderError('auth')` and a 429 to `rate_limited`.
- [x] TTS: chunked fixture bodies become `AudioChunk`s whose bytes, concatenated, equal the fixture. An `AsyncIterable` text input makes one request per piece, in order.
- [x] Aborting mid-stream throws `ProviderError('aborted')` and cancels the body reader.
- [x] Each plugin's `setup` registers the right provider ids, and an invalid config fails plugin validation.
- [x] `bun run check` passes.

## Notes

- Follow `createOpenAICompatibleLlm` in `packages/sdk/src/providers/` for error mapping and the injectable `fetch`.
- The speaches TTS model/voice ids (e.g. `speaches-ai/Kokoro-82M-v1.0-ONNX`, `af_heart`) change between releases. Put the defaults in config with a comment, not in code paths. Check speaches' current docs before choosing them.


## Outcome

**Built**

- `packages/sdk/src/providers/openai-audio.ts`: real bodies for `createOpenAICompatibleStt` and `createOpenAICompatibleTts`, replacing the K1 placeholders. Signatures and exported types are unchanged; the WAV writer and the default rate stay module-private, so the SDK's public surface still matches the contract.
  - STT wraps the `pcm16` utterance in a 44-byte WAV header and POSTs multipart (`model`, `file` as `audio.wav`, `response_format: json`, `language?`, `prompt?`) to `<baseUrl>/audio/transcriptions`. It trims the returned text and passes `language` through when the vendor reports one.
  - TTS POSTs `{ model, input, voice, response_format: "pcm" }` to `<baseUrl>/audio/speech` once per text piece, in order, and yields `pcm16` chunks at `sampleRate` (default 24000) as the body streams.
  - Errors reuse `providerErrorFromResponse` from the LLM helper (imported, not modified). Nothing retries and nothing logs. Every await (fetch, JSON body, body read, next text piece) is raced against the signal, so an abort always ends with `ProviderError('aborted')`. The finally block cancels the body reader and aborts the request, including when the consumer stops iterating early.
- `plugins/voice-groq` (`@keith/voice-groq`): STT `groq`. Config: `apiKey` (required), `baseUrl`, `model` (`whisper-large-v3-turbo`).
- `plugins/voice-openai` (`@keith/voice-openai`): TTS `openai`. Config: `apiKey` (required), `baseUrl`, `model` (`gpt-4o-mini-tts`), `voice` (`alloy`).
- `plugins/voice-speaches` (`@keith/voice-speaches`): STT and TTS `speaches`, no key by default. Config: `baseUrl` (`http://127.0.0.1:8000/v1`), `apiKey?`, `sttModel` (`Systran/faster-whisper-small`), `ttsModel` (`speaches-ai/Kokoro-82M-v1.0-ONNX`), `voice` (`af_heart`), `sampleRate` (24000). The ids come from speaches.ai/usage on 2026-09-27 and live only in the zod schema, with a comment.
- Each plugin was scaffolded with `bun init -y`, then trimmed to the repo's plugin shape (the generated README, CLAUDE.md, .gitignore and index.ts were removed, and tsconfig now extends the base config). Dependencies came from `bun add @keith/sdk@workspace:* zod@^4.6.5`.
- Tests: 16 SDK tests plus 18 plugin tests, all offline behind an injected `fetch`. They cover the WAV header byte by byte, the multipart fields, 401 → `auth`, 429 → `rate_limited`, 503 → `unavailable`, 404 → `bad_request`, chunk bytes concatenating to the fixture (including pieces that split samples), one request per `AsyncIterable` piece in order, abort mid-stream (throws `aborted`, cancels the reader), abort while waiting on the text source, early `break`, and plugin registration and config validation.
- `docs/architecture/providers.md`: the voice plugin table now lists namespaces and config keys, plus the helpers' behavior beyond the contract. The "Planned" note is narrowed to `@keith/vad-energy`.

**Decisions**

- Namespaces are `voice_groq`, `voice_openai` and `speaches`. `groq` and `openai` stay free for LLM plugins of the same vendors, because the host refuses duplicate namespaces. Provider ids are unchanged (`groq`, `openai`, `speaches`).
- TTS skips empty or whitespace-only text pieces, since every vendor answers 400 to an empty `input`.
- An odd byte at the end of a body read is carried into the next chunk, so every `AudioChunk` holds whole samples (contract: "always holds whole samples"). A trailing half sample at the end of a body is dropped.
- STT refuses non-`pcm16` input with `ProviderError('bad_request')` before sending a request.
- `voice-groq` has no `voice` key because it is STT only. speaches uses `sttModel` / `ttsModel` instead of a single `model`, because one plugin serves both roles.

**Deviations / follow-ups**

- Fixtures are synthetic, not recorded: there were no API keys and no network in this task. Each JSON fixture's `_fixture` field names its source doc. The `speech.pcm` fixtures are 10 ms of a 440 Hz sine at 24 kHz. Follow-up: re-record them against the real Groq, OpenAI and speaches services (P3-I2 or a human with keys).
- `replay.ts` is duplicated across the three plugins' `test/` folders, because plugins never import each other.
- P3-I1 should add the three plugins to bootstrap and setup, using `env:GROQ_API_KEY` and `env:OPENAI_API_KEY`.
