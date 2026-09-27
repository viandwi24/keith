# Voice

> Planned (phase 3). The wire contract, provider types, config and core interfaces exist (P3-K1); the pipeline, the server and Mind handling, the adapters and the browser side are built by the phase-3 lanes. v1 choices: [ADR-0013](../decisions/0013-voice-v1-transport-and-providers.md).

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

- WebSocket **binary frames**, with a fixed header followed by the payload, framed by JSON `audio.start` / `audio.end` frames in each direction and `audio.stop` for barge-in (defined in [contracts/protocol.md](../contracts/protocol.md#audio-phase-3)). `@keith/protocol` has `encodeAudioFrame` / `decodeAudioFrame`.
- Codec v1 (ADR-0013): **PCM16LE mono** both ways. Nodes send 16 kHz in 20 ms chunks; the core sends the TTS provider's rate (24 kHz for the v1 adapters) and announces it in its `audio.start`. `opus` is a reserved codec value that the v1 core refuses; Opus comes later behind the same frames.
- WebRTC (e.g. LiveKit) is a phase-8 option if WS latency proves inadequate. It would sit behind the same node capability.

## Core interfaces

`packages/core/src/voice/types.ts` ([core.md](core.md#voice-voicetypests-implemented-by-voice-p3-a1)):

| Interface | Called by | Does |
|---|---|---|
| `VoiceInput` (`start`, `chunk`, `end`, `detach`) | server | Per stream: PCM16 → `VadStream` → STT on `speech.end`, `audio.end` or `voice.maxUtteranceMs` → `ThreadManager.input({ modality: 'audio' })`. VAD start/end → `ThreadManager.voiceActivity`. |
| `VoiceOutput.begin` → `SpeechHandle` (`push`, `end`, `stop(): number`, `done`) | Mind, for audio-modality turns on the focus node | Text deltas → sentences → TTS → `audio.start`, kind-2 binary frames, `audio.end` to that node. `stop()` sends `audio.stop` and returns `spokenChars`. |

Config: the optional `[voice]` section ([config.md](config.md)) names the `vad`, `stt` and `tts` provider ids and sets `maxUtteranceMs`, `bargeIn` and `bargeInMinMs`. Without it, voice is off and the core behaves as in phase 2.

## Turn-taking with voice

- VAD start on the focus node → Thread `listening`.
- VAD end → STT final → normal input → `thinking`.
- **Barge-in:** speech detected while `speaking` stops TTS playback on the node (`audio.stop` frame), cancels the remaining TTS, and starts listening. The partial assistant message keeps what was actually spoken (`meta.spokenChars`). With an energy VAD, speech must last `voice.bargeInMinMs` before it counts, so a short noise doesn't cut the reply.
- Echo: nodes must use their platform's echo cancellation (browser `getUserMedia` constraints). The core doesn't do AEC.

## Provider seams

`VadProvider`, `SttProvider` (streaming + batch), and `TtsProvider` (streaming). See [contracts/providers.md](../contracts/providers.md#voice-types). ADR-0013 picks the v1 adapters: `@keith/vad-energy` (VAD), `@keith/voice-groq` (cloud STT), `@keith/voice-openai` (cloud TTS) and `@keith/voice-speaches` (local STT + TTS), the last three built on the SDK's `createOpenAICompatibleStt` / `createOpenAICompatibleTts`. STT in v1 is batch per utterance. Silero VAD, Opus and streaming STT are follow-ups.
