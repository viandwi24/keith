# Provider interfaces v1

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
```

### Adapter obligations

1. Exactly one `finish` event, always last.
2. Tool-call arguments are assembled across stream chunks, JSON-parsed, and emitted as a single `tool.call`. Unparseable args produce `tool.call` with `args: { __raw: string }`, and the core returns a validation error to the model.
3. Abort: when `signal` aborts, stop reading, close the HTTP request, and end the iterator by throwing `ProviderError('aborted')`.
4. Errors are thrown as `ProviderError` with `code: 'auth' | 'rate_limited' | 'bad_request' | 'unavailable' | 'timeout' | 'aborted' | 'unknown'` and `retryable: boolean`.
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

`AudioChunk`, `AudioInput`, `SttOptions`, `TtsOptions`, `RealtimeOptions` and `RealtimeEvent` are finalized by the phase-3 contract task (additive). The shapes above are fixed.
