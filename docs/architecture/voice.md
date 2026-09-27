# Voice

Built in phase 3: the cascade mode below, end to end, from the browser's microphone to its speaker. v1 choices: [ADR-0013](../decisions/0013-voice-v1-transport-and-providers.md). Realtime mode, Silero VAD, Opus and streaming STT are later (ADR-0013 defers them).

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

### Pipeline (`voice/`)

`createVoice(deps)` returns `{ input, output }`. Its deps are the `vad` / `stt` / `tts` provider lists, `config.voice`, the ThreadManager's `input` and `voiceActivity`, the AttachmentRegistry's `send` and `sendBinary`, a `capabilities(nodeId)` lookup (the capabilities the node declared in `hello`), ids, clock and log. Providers are looked up by the configured id on every `start` / `begin`, so they may register after `createVoice` runs.

**Input**, per `(nodeId, streamId)`:

- `start` refuses (never throws) when voice is off (logged at warn), the codec is not `pcm16`, the rate is outside 8–48 kHz, the stream id is already open on that node, or the configured VAD or STT provider is not registered.
- Chunks are decoded as PCM16LE (an odd trailing byte is dropped) and **linearly resampled to 16 kHz** when the node sends another rate, chunk by chunk. The VAD and STT always see 16 kHz. Chunks with a `sequence` lower than expected are dropped and logged at debug; a gap is logged at debug and the stream continues.
- Outside speech the pipeline keeps the last 300 ms (pre-roll), so the utterance sent to STT starts just before `speech.start`.
- `voiceActivity({ speaking: true })` is sent at the VAD's `speech.start`: the pipeline reports raw VAD start and stop. `voice.bargeInMinMs` is applied once, by the Mind, which alone knows whether a turn is running ([core.md](core.md#threads-and-turn-state), Barge-in). Short speech still goes to STT, and a non-empty transcript is still input.
- `speech.end` or `audio.end` sends the utterance to STT (`transcribe`, or `stream` when the provider only has that). A non-empty transcript becomes `ThreadManager.input({ modality: 'audio' })`. An empty one, or an STT error (logged), sends `voiceActivity({ speaking: false })` if `true` was sent.
- `voice.maxUtteranceMs` of buffered speech forces an STT run mid-speech. The activity stays on: no new `speaking: true` follows the input, because it would read as a barge-in.
- STT runs one utterance at a time per stream, so inputs keep their order. `detach(nodeId)` aborts in-flight STT, drops the node's streams without transcribing, and sends `speaking: false` where `true` was sent.

**Output**, per `begin`:

- `begin` returns null when voice is off, the node's capabilities lack `audio.out@1`, or the configured TTS provider is not registered.
- Text deltas are cut into pieces: a `.`, `!` or `?` (plus closing quotes or brackets) followed by whitespace, a newline, or a 240-character cap (cut at the last space). The pieces partition the pushed text exactly.
- Pieces go to `TtsProvider.stream` one at a time, in order. The first chunk sends `audio.start` with the TTS rate; chunks of a later piece at another rate are resampled to it. Chunks are split into kind-2 frames of at most 64 KiB, with `sequence` 0, 1, 2, … .
- `spokenChars` counts the pushed characters (`String.length` units) of the pieces whose audio was fully sent, never the queued ones. `stop()` aborts the TTS signal, sends `audio.stop` if `audio.start` was sent, and settles `done`. A TTS error is logged and ends the speech early with `audio.end`.

### Wiring (bootstrap)

With a `[voice]` section, `bootstrap()` builds `createVoice(...)` right after the attachment registry, hands `voice.input` to `createCoreServer({ voice })` and `voice.output` to `createThreadManager({ voice })` (whose `config` carries `voice`, so the Mind knows `bargeIn` / `bargeInMinMs`). The pipeline reaches the ThreadManager through a late binding, because each needs the other. `capabilities(nodeId)` comes from the capabilities each node declared in its latest `hello` (the `node.connected` event). After the plugin host has started, every `[voice]` id must name a registered provider: an unknown one stops startup with `CONFIG_INVALID`, naming the key, the id and the registered ids (e.g. `voice.stt = 'whisper' names an unknown stt provider (registered: groq)`). Without `[voice]` none of this runs and the core behaves as in phase 2.

`@keith/core` depends on the four first-party voice plugins (`@keith/vad-energy`, `@keith/voice-groq`, `@keith/voice-openai`, `@keith/voice-speaches`), so the plugin host can load them by name. `keith setup` offers them ([config.md](config.md#keith-setup)).

Config: the optional `[voice]` section ([config.md](config.md)) names the `vad`, `stt` and `tts` provider ids and sets `maxUtteranceMs`, `bargeIn` and `bargeInMinMs`. Without it, voice is off and the core behaves as in phase 2.

## Turn-taking with voice

- VAD start on the focus node → Thread `listening`.
- VAD end → STT final → normal input → `thinking`.
- A spoken input's `message.user` also goes to the node that spoke it (as for a UI click), because its transcript comes from the core's STT: that is how the speaking node shows what it heard.
- **A spoken reply stays `speaking` until playback ends.** The text streams live to every attached node as `message.delta`, but `message.completed` (and persistence) waits until the audio was sent, also on nodes without audio, so a barge-in during playback can still cut the stored text. In S-7 a text-only node therefore sees the full text before `message.completed`; nothing is lost.
- **Barge-in:** speech detected while `speaking` stops TTS playback on the node (`audio.stop` frame), cancels the remaining TTS, and starts listening. The partial assistant message keeps what was actually spoken (`meta.spokenChars`). With an energy VAD, speech must last `voice.bargeInMinMs` before it counts, so a short noise doesn't cut the reply.
- Echo: nodes must use their platform's echo cancellation (browser `getUserMedia` constraints). The core doesn't do AEC.

## Browser side (`@keith/web`, `@keith/client`)

- `@keith/client`: `createChatClient({ audio: { input, output }, onAudio })` declares `audio.in@1` / `audio.out@1` only when asked (the TUI stays `chat.text@1`). `startAudio()` / `sendAudio(streamId, sequence, pcm16)` / `endAudio(streamId)` send the node's stream; kind-2 frames and the core's `audio.start` / `audio.end` / `audio.stop` arrive as `onAudio` events. `createPlaybackQueue({ sink })` plays each stream in `sequence` order and stops at once on `audio.stop` or a new input. See [repository.md](repository.md#keithclient).
- The web app captures with `getUserMedia` (echo cancellation, noise suppression, AGC) and an AudioWorklet, downsamples to 16 kHz PCM16 in 20 ms chunks, and plays through Web Audio. It offers a mic toggle (open mic) and hold-to-talk, shows "Listening…" and "Speaking", and says in one line why voice is unavailable (no secure context, no permission, no device). Voice needs a secure context: `localhost` or HTTPS.

## Provider seams

`VadProvider`, `SttProvider` (streaming + batch), and `TtsProvider` (streaming). See [contracts/providers.md](../contracts/providers.md#voice-types). ADR-0013 picks the v1 adapters: `@keith/vad-energy` (VAD), `@keith/voice-groq` (cloud STT), `@keith/voice-openai` (cloud TTS) and `@keith/voice-speaches` (local STT + TTS), the last three built on the SDK's `createOpenAICompatibleStt` / `createOpenAICompatibleTts`. STT in v1 is batch per utterance. Silero VAD, Opus and streaming STT are follow-ups.
