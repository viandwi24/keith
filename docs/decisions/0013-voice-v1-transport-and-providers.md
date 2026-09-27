# ADR-0013: Voice v1 uses PCM16 on the wire, an energy VAD, and OpenAI-compatible STT/TTS adapters

- **Status:** proposed
- **Date:** 2026-09-27
- **Rules/invariants affected:** ADR-0007 (fills in the voice adapters), R-6

## Context

Phase 3 must ship one local and one cloud adapter each for STT and TTS, plus a VAD ([voice.md](../architecture/voice.md), ADR-0007). The core runs on Bun. `onnxruntime-node` (the usual way to run Silero VAD or in-process Kokoro) has had repeated crashes under Bun (oven-sh/bun#18079, #30431) and ships very large native binaries. Browsers' `MediaRecorder` produces WebM/MP4 containers, not raw Opus packets. WebCodecs `AudioEncoder` gives raw Opus, but Safari only has it from version 26. Decoding Opus in the core would need a WASM decoder, and decoding containers would also need a demuxer. The candidate STT services (Groq, speaches) and TTS services (OpenAI, Kokoro-FastAPI, speaches) all speak the OpenAI audio API.

## Decision

- **Wire format v1:** nodes send **PCM16LE mono, 16 kHz** in binary frames (kind 1). An AudioWorklet in the browser resamples and packs 20 ms chunks. The core sends **PCM16LE mono** at the TTS provider's rate (24 kHz for the v1 adapters) as kind-2 frames, and announces codec and rate in a core → node `audio.start`. The codec enum is `'pcm16' | 'opus'`. `'opus'` is reserved: the v1 core refuses it with `INVALID_FRAME`. Opus comes later, behind the same frames, when bandwidth matters.
- **VAD:** `@keith/vad-energy`, a pure-TypeScript RMS VAD with hysteresis and hangover, and no dependencies. Silero v5 is the planned second implementation. It needs a spike that proves an ONNX runtime is stable under Bun first.
- **STT and TTS:** two helpers in `@keith/sdk`, `createOpenAICompatibleStt` (`POST /audio/transcriptions`, batch; the utterance is wrapped as WAV) and `createOpenAICompatibleTts` (`POST /audio/speech`, `response_format: "pcm"`, streamed body). They mirror `createOpenAICompatibleLlm`, with injectable `fetch` and recorded fixtures.
- **Adapters (plugins):**
  - Cloud STT: `@keith/voice-groq` (Groq, `whisper-large-v3-turbo`).
  - Cloud TTS: `@keith/voice-openai` (OpenAI, `gpt-4o-mini-tts`).
  - Local STT + TTS: `@keith/voice-speaches` (one self-hosted [speaches](https://speaches.ai/) container: faster-whisper for STT, Kokoro for TTS).
- STT in v1 is **batch per utterance**, segmented by the VAD. Streaming STT (Deepgram) and WebSocket TTS (ElevenLabs) wait for a later ADR.
- Voice is off unless the config has a `[voice]` section naming `vad`, `stt` and `tts` provider ids.

## Consequences

- There are no native dependencies and no codec code in the core, and every adapter test runs offline against canned responses.
- About 256 kbit/s upstream per speaking node. That is fine on a LAN or tailnet, but wasteful over mobile data. Opus is the follow-up.
- An energy VAD is weaker in noisy rooms. Barge-in may fire on loud noise, so the core requires a minimum speech duration before it treats speech as a barge-in (`voice.bargeInMinMs`).
- Local voice needs one Docker container (speaches). Cloud voice needs `GROQ_API_KEY` and `OPENAI_API_KEY`. Setup documents both.
- Follow-ups: Opus via WebCodecs + a WASM decoder; a Silero VAD; streaming STT.
