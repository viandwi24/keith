# Wire protocol v1

**Frozen: v1 (2026-09-26).** Changes follow the [freeze rules](README.md#freeze-rules).

The protocol between the core and every Node. Implemented as zod schemas in `@keith/protocol`. This document is normative, and the schema test parses every ` ```json frame` example below.

## Transport

- One port (default `4824`). HTTP under `/v1/`, WebSocket at `/v1/ws`.
- **Text WS frames** are JSON envelopes (below). **Binary WS frames** carry audio (phase 3).
- All HTTP bodies are JSON with `content-type: application/json`, except `/v1/files` (phase 2).

## HTTP endpoints

| Method + path | Auth | Request | Response | Phase |
|---|---|---|---|---|
| `GET /v1/health` | none | — | `{ ok: true, version, protocol: 1 }` | 1 |
| `POST /v1/auth/login` | none | `{ username, password }` | `{ token, person: PersonDto, expiresAt }` | 1 |
| `POST /v1/auth/logout` | bearer | — | `{ ok: true }` | 1 |
| `GET /v1/me` | bearer | — | `{ person: PersonDto }` | 1 |
| `GET /v1/threads` | bearer | — | `{ threads: ThreadDto[] }` | 1 |
| `GET /v1/threads/:id/messages?before=<msgId>&limit=<n≤200>` | bearer | — | `{ messages: MessageDto[], hasMore }` | 1 |
| `POST /v1/files` · `GET /v1/files/:id` | bearer | multipart | `{ file: FileDto }` | 2 |

- `messages`: `limit` is 1..200 and defaults to 50. The page holds the `limit` messages just before `before` (or the latest ones when `before` is omitted), **oldest first**. `hasMore` is true when older messages exist.
- `FileDto` and the files endpoints are specified under [Files](#files) (additive, phase 2, task P2-K1).

Errors: HTTP status + `{ error: { code, message } }`. Codes are listed at the end of this document. A request body or query that fails validation gets `400` with `INVALID_REQUEST`.

## DTOs

```ts
type PersonDto  = { id: string; name: string; tier: 'owner' | 'member' | 'guest' }
type ThreadDto  = { id: string; kind: 'direct' | 'group'; title: string;
                    participants: PersonDto[]; state: TurnState; updatedAt: number }
type MessageDto = { id: string; threadId: string; role: 'user' | 'assistant';
                    authorPersonId: string | null;          // null = the Mind
                    modality: 'text' | 'audio'; content: string;
                    ui?: UiBlock[];                         // blocks attached to this message
                    createdAt: number;
                    meta?: { cancelled?: boolean; proactive?: boolean;
                             spokenChars?: number } }             // phase 3, see below
type TurnState  = 'idle' | 'listening' | 'thinking' | 'speaking'
```

`meta.spokenChars` (phase 3, additive, task P3-K1): set on an assistant reply that was spoken and cut by barge-in. It is the number of characters whose audio was fully sent, and `content` holds exactly that prefix. It comes with `cancelled: true`.

`tool` role messages are internal and never sent to nodes. Tool activity reaches nodes as `tool.activity` frames.

Every id in a DTO or frame payload is a prefixed ULID (`thr_…`, `msg_…`, `per_…`, `nod_…`; see [conventions](../rules/conventions.md#identifiers)) and is validated as one: the prefix, then 26 Crockford base32 characters. Timestamps (`ts`, `createdAt`, `updatedAt`, `expiresAt`) are integer milliseconds since the Unix epoch.

## Files

Phase 2, additive (task P2-K1).

```ts
type FileDto = { id: string /* fil_… */; name: string; mime: string; size: number; createdAt: number }
```

- `POST /v1/files`: `multipart/form-data` with one part named `file`, at most `FILE_MAX_BYTES` (10 MiB). Response `{ file: FileDto }`. Too large or missing part → `400 INVALID_REQUEST`.
- `GET /v1/files/:id`: the bytes, with `content-type` = the stored `mime`. `404 NOT_FOUND` when the file doesn't exist or the person may not read it (the core defines who may, see [storage.md](../architecture/storage.md)).
- UI blocks reference files by the core-relative URL `/v1/files/<id>` (`fileUrl(id)` in `@keith/protocol`).

## Envelope

```ts
type Frame = {
  v: 1                 // envelope version
  type: string         // frame type, below
  id: string           // sender-generated, unique per connection (ULID recommended)
  ts: number           // sender clock, ms since epoch
  re?: string          // id of the frame this responds to
  data: object         // per-type payload
}
```

- `id` and `re` are 1..64 characters.
- Unknown `type` → the receiver replies `error { code: 'UNKNOWN_FRAME' }` and keeps the connection. An invalid payload for a known type → `error { code: 'INVALID_FRAME' }`. Both replies set `re` to the rejected frame's `id` when it could be read.
- Envelope `v` other than 1, or `hello.protocol` other than 1 → the core closes with `4009`.
- **Unknown fields are ignored** (dropped on parse), in the envelope and in `data`. This keeps additive changes (a new optional field) compatible in both directions.

`@keith/protocol` implements this as `parseNodeFrame(input)` (used by the core) and `parseCoreFrame(input)` (used by nodes). Each takes the raw text or an already-parsed value and returns `{ ok: true, frame }` or `{ ok: false, code, message, frameId? }`, where `code` is `INVALID_FRAME`, `UNKNOWN_FRAME` or `UNSUPPORTED_PROTOCOL` (→ close `4009`). `makeFrame(type, data, { id, ts, re? })` builds a typed frame. `audio.start` and `audio.end` exist in both directions with their own payloads, so `makeCoreFrame` and `makeNodeFrame` (same arguments) build a frame of one direction; `makeFrame` returns the union of both for those two types.

## Node → core frames

| type | data | Phase |
|---|---|---|
| `hello` | `{ protocol: 1, client: { name, version }, capabilities: string[], nodeId?: string }`. `client` describes the software, e.g. `keith-tui`. Capabilities are well-formed `name@major` ids (at most 64); unknown ones are ignored | 1 |
| `thread.open` | `{ threadId?: string, historyLimit?: number }` (0..200, default 50) | 1 |
| `thread.close` | `{ threadId: string }` | 1 |
| `input.text` | `{ threadId: string, text: string }` (1..16 000 chars) | 1 |
| `input.cancel` | `{ threadId: string }` | 1 |
| `ui.action` | `{ threadId, messageId, blockId, actionId, value?: unknown }` | 2 |
| `audio.start` / `audio.end` | `{ threadId, streamId, codec: AudioCodec, sampleRate }` / `{ streamId }`. The node starts / stops sending audio for a thread it has open. Chunks are binary frames of kind 1 | 3 |
| `pong` | `{}` | 1 |

## Core → node frames

| type | data | Phase |
|---|---|---|
| `welcome` | `{ nodeId, person: PersonDto \| null, protocol: 1, server: { name, version } }` | 1 |
| `thread.opened` | `{ thread: ThreadDto, messages: MessageDto[] }` | 1 |
| `thread.state` | `{ threadId, state: TurnState }` | 1 |
| `message.user` | `{ message: MessageDto }` (a user input or a relay; which nodes get it: [Delivery rules](#delivery-rules)) | 1 |
| `message.started` | `{ threadId, messageId, proactive: boolean }` | 1 |
| `message.delta` | `{ threadId, messageId, text }` | 1 |
| `message.completed` | `{ message: MessageDto }` | 1 |
| `tool.activity` | `{ threadId, messageId, toolCallId, name, status: 'started' \| 'completed' \| 'failed', summary?: string }` | 1 |
| `ui.render` | `{ threadId, messageId?: string, block: UiBlock, fallbackText: string }` | 2 |
| `notice` | `{ level: 'info' \| 'warn', text }` | 1 |
| `error` | `{ code, message }` (+ envelope `re`) | 1 |
| `ping` | `{}` | 1 |
| `audio.start` / `audio.end` | `{ threadId, messageId, streamId, codec: AudioCodec, sampleRate }` / `{ streamId }`. The core starts / finishes speaking `messageId` on this node (the focus node only). Chunks are binary frames of kind 2 | 3 |
| `audio.stop` | `{ streamId }` (barge-in or cancel: stop playback now and drop queued chunks of the stream) | 3 |

**Proactive messages (I-11):** `message.started` with `proactive: true` can arrive at any time without any node input. Nodes must render it like any assistant message.

## Delivery rules

Additive clarifications, task P3-K2. They say which node gets which frame; no payload changes.

- **`message.user` echo.** A user input is sent as `message.user` to every node attached to the thread (it has the thread open) except the node that sent it, because that node already shows what it typed. Two inputs also go to the sender, because it has no other way to show them: a **spoken** input (`modality: 'audio'`), whose transcript comes from the core's STT, and the input the core runs for a **`ui.action` click** (e.g. `(clicked: Book)`).
- **`chat.text@1`.** Only a node that declared `chat.text@1` in `hello` may send `input.text`; any other node gets `error { FORBIDDEN }`. A node without `chat.text@1` receives no `message.user`, `message.started`, `message.delta`, `message.completed` or `tool.activity` frames. Every other frame it may receive as before (`thread.opened` and its history, `thread.state`, `notice`, `error`, `ping`; `ui.render` only with `ui.render@1`, audio only with `audio.out@1`).

### Notices

The core sends `notice` in exactly these cases. `text` is for people: a node shows it (e.g. as a status line) and never parses it.

| When | To | Level | Text (example) |
|---|---|---|---|
| Right after `welcome` | A node whose `welcome.person` is an `owner`: one notice per plugin in state `failed` | `warn` | `plugin @keith/tool-weather failed: missing apiKey` |
| Right after `welcome` (after the `warn` notices) | A node that declared `audio.in@1` while the deployment has no `[voice]` section | `info` | `voice is not configured on this Keith` |

No other `notice` is sent in v1. A node must accept `notice` at any time, since later phases may add cases.

## Examples

```json frame
{ "v": 1, "type": "hello", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V2W", "ts": 1790000000000,
  "data": { "protocol": 1, "client": { "name": "keith-tui", "version": "0.1.0" }, "capabilities": ["chat.text@1"] } }
```

```json frame
{ "v": 1, "type": "welcome", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V2X", "ts": 1790000000050, "re": "01J8ZQ3K4M5N6P7Q8R9S0T1V2W",
  "data": { "nodeId": "nod_01J8ZQ3K4M5N6P7Q8R9S0T1V2Y", "person": { "id": "per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z", "name": "Tony", "tier": "owner" },
            "protocol": 1, "server": { "name": "keith", "version": "0.1.0" } } }
```

```json frame
{ "v": 1, "type": "input.text", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V30", "ts": 1790000001000,
  "data": { "threadId": "thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31", "text": "Research venue options for the Expo, tell me when done." } }
```

```json frame
{ "v": 1, "type": "message.started", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V32", "ts": 1790000900000,
  "data": { "threadId": "thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31", "messageId": "msg_01J8ZQ3K4M5N6P7Q8R9S0T1V33", "proactive": true } }
```

```json frame
{ "v": 1, "type": "thread.state", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V34", "ts": 1790000001010,
  "data": { "threadId": "thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31", "state": "thinking" } }
```

## Audio (phase 3)

Additive, task P3-K1. Choices: [ADR-0013](../decisions/0013-voice-v1-transport-and-providers.md).

```ts
type AudioCodec = 'pcm16' | 'opus'     // pcm16 = 16-bit signed little-endian, mono
```

- A **stream** is one `audio.start` … `audio.end` (or `audio.stop`) sequence in one direction. Its `streamId` is a **bare ULID** (26 characters, no prefix), generated by the sender of `audio.start`, because the binary header carries its 16 raw bytes.
- `sampleRate` is an integer from 8 000 to 48 000 Hz. v1 nodes send `pcm16` at 16 000 Hz; the core sends `pcm16` at the TTS provider's rate (24 000 Hz for the v1 adapters). `opus` is reserved: the schemas accept it, and the v1 core refuses a node's `audio.start` with it with `INVALID_FRAME`.
- A node sends `audio.start` only with `audio.in@1`, for a thread it has open (`FORBIDDEN` otherwise). The core sends audio only to a node with `audio.out@1`, and only to the thread's focus node.
- Chunks of a stream carry `sequence` 0, 1, 2, … . Chunks of an unknown stream, or a kind-2 frame sent by a node, get `error { INVALID_FRAME }` and the connection stays open.

```json frame
{ "v": 1, "type": "audio.start", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V41", "ts": 1790000002000,
  "data": { "threadId": "thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31", "streamId": "01J8ZQ3K4M5N6P7Q8R9S0T1V50", "codec": "pcm16", "sampleRate": 16000 } }
```

```json frame
{ "v": 1, "type": "audio.start", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V42", "ts": 1790000004000,
  "data": { "threadId": "thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31", "messageId": "msg_01J8ZQ3K4M5N6P7Q8R9S0T1V43",
            "streamId": "01J8ZQ3K4M5N6P7Q8R9S0T1V51", "codec": "pcm16", "sampleRate": 24000 } }
```

```json frame
{ "v": 1, "type": "audio.stop", "id": "01J8ZQ3K4M5N6P7Q8R9S0T1V44", "ts": 1790000005000,
  "data": { "streamId": "01J8ZQ3K4M5N6P7Q8R9S0T1V51" } }
```

### Binary frames

```
byte 0      : frame kind   (1 = audio.in chunk, node → core; 2 = audio.out chunk, core → node)
bytes 1..16 : streamId     (16 raw bytes of the ULID, big-endian: its 128-bit value)
bytes 17..20: sequence     (uint32 big-endian)
bytes 21..  : codec payload (PCM16LE samples in v1; an Opus packet later)
```

A binary frame is at most 64 KiB (`AUDIO_FRAME_MAX_BYTES`), header included. Senders split bigger chunks. `encodeAudioFrame(frame)` builds one (it throws `RangeError` on a bad kind, stream id or sequence, or an oversized frame); `decodeAudioFrame(bytes)` returns `{ ok: true, frame: { kind, streamId, sequence, payload } }` or `{ ok: false, code: 'INVALID_FRAME', message }` for a short buffer, an unknown kind or an oversized frame. The decoded `payload` is a copy at byte offset 0 of its own buffer, so it can be viewed as an `Int16Array`.

## WebSocket close codes

| Code | Meaning |
|---|---|
| 4001 | No `hello` within 5 s |
| 4003 | Invalid or expired token |
| 4009 | Protocol version not supported (`hello.protocol` or envelope `v` is not 1) |
| 4010 | Heartbeat timeout |

## Error codes

| Code | Meaning |
|---|---|
| `UNAUTHORIZED` | HTTP: missing, unknown or expired bearer token, or a failed login |
| `FORBIDDEN` | The node may not do this: a frame for a thread it has not opened, a thread the person is not a participant of, `audio.start` without `audio.in@1`, `input.text` without `chat.text@1` |
| `NOT_FOUND` | Unknown (or not visible to the caller) thread, message, block, file or route |
| `INVALID_REQUEST` | An HTTP body or query failed validation |
| `INVALID_FRAME` | A known frame type with an invalid payload, a frame out of order (before `hello`, a second `hello`), or a bad audio frame or stream |
| `UNKNOWN_FRAME` | An unknown frame type |
| `THREAD_BUSY` | Reserved. Never sent in v1 |
| `RATE_LIMITED` | A turn failed because its model provider answered `rate_limited` ([providers.md](providers.md)) after the core's retries. Sent like `PROVIDER_ERROR` (clarified by task P3-K2) |
| `PROVIDER_ERROR` | A turn failed because its model provider failed for any other reason (after retries, or stalled) |
| `INTERNAL` | Anything else. The message says nothing about the cause |

An error of a running turn (`RATE_LIMITED`, `PROVIDER_ERROR`, `INTERNAL`) goes to every node attached to the thread, without `re`. An error that answers one frame goes to its sender, with `re` when the frame's `id` could be read.

## Code map

| Export | File |
|---|---|
| `FrameEnvelope`, `makeFrame`, `makeCoreFrame`, `makeNodeFrame`, `FrameParseResult` | `src/envelope.ts` |
| `NodeFrame`, `parseNodeFrame`, one schema per node frame (`HelloFrame`, …, `AudioStartFrame`, `AudioEndFrame`) | `src/frames/node-to-core.ts` |
| `CoreFrame`, `parseCoreFrame`, one schema per core frame (`WelcomeFrame`, …, `AudioOutStartFrame`, `AudioOutEndFrame`, `AudioStopFrame`) | `src/frames/core-to-node.ts` |
| `PersonDto`, `ThreadDto`, `MessageDto`, `TurnState`, `Tier`, HTTP bodies (`LoginRequest`, `MessagesQuery`, …) | `src/dto.ts` |
| `ID_PREFIXES`, `prefixedId`, `ThreadId`, `MessageId`, … | `src/ids.ts` |
| `KNOWN_CAPABILITIES`, `Capability`, `parseCapability` | `src/capabilities.ts` |
| `AudioCodec`, `AudioStreamId`, `SampleRate`, `AUDIO_FRAME_KIND`, `AudioFrame`, `encodeAudioFrame`, `decodeAudioFrame` | `src/audio.ts` |
| `ErrorCode`, `HttpErrorBody`, `WS_CLOSE_CODES` | `src/errors.ts` |
| `UiBlock`, `uiBlockToText` | `src/ui/` ([ui-blocks.md](ui-blocks.md)) |

Each schema and its inferred type share a name (`PersonDto` is both).
