# Voice

> Planned (phase 3). This doc fixes the shape now so that phases 1–2 don't make choices that block it.

## Principles

1. **Modality is per message** (I-6). A voice utterance becomes a `user` message with `modality: 'audio'` and its transcript as `content`. The Thread doesn't change mode.
2. **The pipeline runs in the core**, not in nodes. Nodes only capture and play raw audio. Provider choice (cloud, cheap, local) is one config section for the whole deployment.
3. **Exception: wake word** runs on the node (offline, instant, private). A node with a wake word sends audio only after it fires.
4. **The reply follows the input's modality.** Spoken input gets a spoken reply (on the focus node) *and* text on every attached node. Typed input gets text only.

## Two modes

| Mode | Pipeline | When |
|---|---|---|
| **Cascade** (default) | node mic → VAD → STT → turn loop (normal LLM) → TTS → focus node speaker | Always available; mix-and-match providers |
| **Realtime** (phase 8, optional) | node mic ↔ speech-to-speech session (e.g. Gemini Live, OpenAI Realtime) | Lowest latency, one vendor |

In realtime mode the Mind still sees text: the session's input and output transcripts are persisted as messages, and tool calls go through the same tool registry. `RealtimeSession` must accept `sendText()` as well as audio, so a typed message during a live voice session is injected into the same session.

## Audio transport

- WebSocket **binary frames**, with a fixed header followed by the payload (defined in [contracts/protocol.md](../contracts/protocol.md#binary-frames-phase-3)).
- Codec: Opus in, Opus out preferred. PCM16 as a fallback capability (`audio.in@1` metadata declares codecs and sample rates).
- WebRTC (e.g. LiveKit) is a phase-8 option if WS latency proves inadequate. It would sit behind the same node capability.

## Turn-taking with voice

- VAD start on the focus node → Thread `listening`.
- VAD end → STT final → normal input → `thinking`.
- **Barge-in:** speech detected while `speaking` stops TTS playback on the node (`audio.stop` frame), cancels the remaining TTS, and starts listening. The partial assistant message keeps what was actually spoken (`meta.spokenChars`).
- Echo: nodes must use their platform's echo cancellation (browser `getUserMedia` constraints). The core doesn't do AEC.

## Provider seams

`VadProvider`, `SttProvider` (streaming + batch), and `TtsProvider` (streaming). See [contracts/providers.md](../contracts/providers.md). Phase 3 picks one local and one cloud adapter for STT and TTS and records the choice in an ADR. Candidates to evaluate: whisper.cpp / faster-whisper, Groq Whisper, Deepgram (STT); Piper, Kokoro, ElevenLabs, OpenAI TTS (TTS); Silero (VAD).
