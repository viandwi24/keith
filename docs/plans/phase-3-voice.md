# Phase 3: Voice (overview)

> Task files are in [phase-3-voice/](phase-3-voice/README.md). This overview is kept for history.

**Goal:** speak to Keith from the browser and hear it answer. Switching device or modality mid-conversation just works (S-7). See [voice.md](../architecture/voice.md).

## Lanes (sketch)

| Lane | Work |
|---|---|
| 0 (contract) | Binary frame schema, `audio.start/end/stop`, finalize the voice provider types (additive) |
| A | Core voice pipeline: per-thread cascade (VAD → STT → turn → TTS), `listening` state, barge-in, `meta.spokenChars` |
| B | STT adapters: one local (e.g. whisper.cpp server) and one cloud (e.g. Groq or Deepgram). ADR for the choice |
| C | TTS adapters: one local (e.g. Piper or Kokoro) and one cloud (e.g. ElevenLabs or OpenAI). ADR for the choice |
| D | VAD adapter (e.g. Silero via onnx) |
| E | Web: mic capture (Opus, echo cancellation), playback queue, push-to-talk + VAD UI, `audio.in@1`/`audio.out@1` |
| I | Integration + S-7 e2e with synthetic audio fixtures |
