# Provider interfaces v1

**Frozen: v1 (2026-09-26).** Changes follow the [freeze rules](README.md#freeze-rules).

Exported from `@keith/sdk`. Rationale: [architecture/providers.md](../architecture/providers.md).

## LLM

```ts
interface LlmProvider {
  id: string                                           // 'openrouter', 'deepseek' → the prefix in model refs
  listModels?(signal?: AbortSignal): Promise<LlmModelInfo[]>
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>
}

interface LlmRequest {
  model: string                                        // part after '<providerId>:'
  system: string
  messages: LlmMessage[]
  tools?: LlmToolSpec[]
  temperature?: number
  maxOutputTokens?: number
  reasoning?: 'off' | 'low' | 'medium' | 'high'        // adapters map or ignore
}

type LlmMessage =
  | { role: 'user'; content: string; name?: string }   // name = author in group threads (phase 5)
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

interface LlmToolSpec { name: string; description: string; inputSchema: JsonSchema }   // converted from zod by the core
interface LlmToolCall { id: string; name: string; args: unknown }                      // args already JSON-parsed

type LlmEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }          // never shown to nodes by default; logged at debug
  | { type: 'tool.call'; call: LlmToolCall }           // emitted once per call, when its args are complete
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } }

interface LlmModelInfo { id: string; contextWindow?: number; supportsTools?: boolean }
type JsonSchema = { [key: string]: unknown }
```

In code, optional fields are typed `field?: T | undefined` so producers can pass through possibly-undefined values under `exactOptionalPropertyTypes`.

### Adapter obligations

1. Exactly one `finish` event, always last.
2. Tool-call arguments are assembled across stream chunks, JSON-parsed, and emitted as a single `tool.call`. Unparseable args produce `tool.call` with `args: { __raw: string }`, and the core returns a validation error to the model.
3. Abort: when `signal` aborts, stop reading, close the HTTP request, and end the iterator by throwing `ProviderError('aborted')`.
4. Errors are thrown as `ProviderError` with `code: 'auth' | 'rate_limited' | 'bad_request' | 'unavailable' | 'timeout' | 'aborted' | 'unknown'` and `retryable: boolean`. Constructor: `new ProviderError(code, message = code, { retryable?, status?, cause? })`. `retryable` defaults to true for `rate_limited`, `unavailable` and `timeout`, false otherwise. `status` is the vendor's HTTP status when there was one.
5. No retries inside the adapter. The core decides.
6. No logging of request bodies above `debug`, and never of API keys.

### `createOpenAICompatibleLlm`

```ts
function createOpenAICompatibleLlm(opts: {
  id: string
  baseUrl: string                                      // e.g. 'https://api.deepseek.com'
  apiKey: string
  headers?: Record<string, string>
  fetch?: typeof fetch                                 // injectable for tests
  mapRequest?: (body: Record<string, unknown>, req: LlmRequest) => Record<string, unknown>
  mapChunk?: (chunk: unknown) => LlmEvent[] | undefined  // override for vendor-specific chunk fields
}): LlmProvider
```

It ships with recorded SSE fixtures for both first providers so tests never hit the network.

## Voice (phase 3)

```ts
interface VadProvider {
  id: string
  create(opts: { sampleRate: number }): VadStream
}
interface VadStream { push(pcm16: Int16Array): VadEvent[]; close(): void }
type VadEvent = { type: 'speech.start'; atMs: number } | { type: 'speech.end'; atMs: number }

interface SttProvider {
  id: string
  transcribe?(audio: AudioInput, opts: SttOptions, signal: AbortSignal): Promise<{ text: string; language?: string }>
  stream?(opts: SttOptions, signal: AbortSignal): SttStream          // at least one of transcribe/stream
}
interface SttStream { push(chunk: AudioChunk): void; end(): void; events(): AsyncIterable<{ type: 'partial' | 'final'; text: string }> }

interface TtsProvider {
  id: string
  stream(text: AsyncIterable<string> | string, opts: TtsOptions, signal: AbortSignal): AsyncIterable<AudioChunk>
}

interface RealtimeProvider {                                           // phase 8
  id: string
  open(opts: RealtimeOptions, signal: AbortSignal): Promise<RealtimeSession>
}
interface RealtimeSession {
  sendAudio(chunk: AudioChunk): void
  sendText(text: string): void                                         // typed input during a voice session
  sendToolResult(callId: string, content: string): void
  events(): AsyncIterable<RealtimeEvent>                               // audio out, transcripts, tool calls, turn end
  close(): Promise<void>
}
```

### Voice types

Finalized by task P3-K1 (additive; choices in [ADR-0013](../decisions/0013-voice-v1-transport-and-providers.md)). `AudioCodec` is `'pcm16' | 'opus'` from `@keith/protocol`.

```ts
type AudioChunk = { data: Uint8Array; codec: AudioCodec; sampleRate: number }
type AudioInput = AudioChunk                           // one complete utterance for transcribe()
type SttOptions = { language?: string; prompt?: string }
type TtsOptions = { voice?: string; language?: string }
```

- `pcm16` means 16-bit signed little-endian mono samples. A `pcm16` chunk always holds whole samples (an even byte length), and `sampleRate` is in Hz.
- The core calls `transcribe` with one utterance as `pcm16` at the rate the node sent (16 000 Hz in v1). `language` and `prompt` are hints that adapters pass on or ignore.
- Every chunk of one `TtsProvider.stream()` call has the same `codec` and `sampleRate`. The v1 core accepts only `pcm16` from TTS.
- `TtsOptions.voice` overrides the adapter's configured voice for one call.
- The VAD, STT and TTS adapters follow the adapter obligations above: `ProviderError` codes, abort ending with `ProviderError('aborted')`, no retries, and no keys in logs. A `VadStream` is synchronous and never throws on audio input.

`RealtimeOptions` and `RealtimeEvent` are finalized in phase 8. Until then the SDK exports them as open object types (`RealtimeEvent` has at least `type: string`).

### OpenAI-compatible audio

Groq, OpenAI and speaches all speak the OpenAI audio API, so `@keith/sdk` ships two helpers next to `createOpenAICompatibleLlm`:

```ts
function createOpenAICompatibleStt(opts: {
  id: string                                           // the id `voice.stt` names, e.g. 'groq'
  baseUrl: string                                      // e.g. 'https://api.groq.com/openai/v1'
  apiKey?: string                                      // omitted: no authorization header (local speaches)
  model: string                                        // e.g. 'whisper-large-v3-turbo'
  headers?: Record<string, string>
  fetch?: typeof fetch                                 // injectable for tests
  mapRequest?: (form: FormData, opts: SttOptions) => FormData
}): SttProvider                                        // batch: implements transcribe only

function createOpenAICompatibleTts(opts: {
  id: string                                           // the id `voice.tts` names, e.g. 'openai'
  baseUrl: string                                      // e.g. 'https://api.openai.com/v1'
  apiKey?: string
  model: string                                        // e.g. 'gpt-4o-mini-tts'
  voice: string                                        // default voice; TtsOptions.voice overrides it
  sampleRate?: number                                  // rate of the returned pcm, default 24000
  headers?: Record<string, string>
  fetch?: typeof fetch
  mapRequest?: (body: Record<string, unknown>, text: string, opts: TtsOptions) => Record<string, unknown>
}): TtsProvider
```

- **STT:** `transcribe` wraps the `pcm16` utterance in a WAV header and POSTs `multipart/form-data` to `<baseUrl>/audio/transcriptions` with `model`, `file`, `response_format: json`, and `language` / `prompt` when set. It returns `{ text, language? }`.
- **TTS:** `stream` POSTs `{ model, input, voice, response_format: "pcm" }` to `<baseUrl>/audio/speech` once per text piece (a string is one piece; an `AsyncIterable<string>` gives one request per item, in order) and yields `pcm16` chunks at `sampleRate` as the body streams.
- Errors map to `ProviderError` codes as in `createOpenAICompatibleLlm`.
