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
                    createdAt: number; meta?: { cancelled?: boolean; proactive?: boolean } }
type TurnState  = 'idle' | 'listening' | 'thinking' | 'speaking'
```

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

`@keith/protocol` implements this as `parseNodeFrame(input)` (used by the core) and `parseCoreFrame(input)` (used by nodes). Each takes the raw text or an already-parsed value and returns `{ ok: true, frame }` or `{ ok: false, code, message, frameId? }`, where `code` is `INVALID_FRAME`, `UNKNOWN_FRAME` or `UNSUPPORTED_PROTOCOL` (→ close `4009`). `makeFrame(type, data, { id, ts, re? })` builds a typed frame.

## Node → core frames

| type | data | Phase |
|---|---|---|
| `hello` | `{ protocol: 1, client: { name, version }, capabilities: string[], nodeId?: string }`. `client` describes the software, e.g. `keith-tui`. Capabilities are well-formed `name@major` ids (at most 64); unknown ones are ignored | 1 |
| `thread.open` | `{ threadId?: string, historyLimit?: number }` (0..200, default 50) | 1 |
| `thread.close` | `{ threadId: string }` | 1 |
| `input.text` | `{ threadId: string, text: string }` (1..16 000 chars) | 1 |
| `input.cancel` | `{ threadId: string }` | 1 |
| `ui.action` | `{ threadId, messageId, blockId, actionId, value?: unknown }` | 2 |
| `audio.start` / `audio.end` | `{ threadId, streamId, codec, sampleRate }` / `{ streamId }` | 3 |
| `pong` | `{}` | 1 |

## Core → node frames

| type | data | Phase |
|---|---|---|
| `welcome` | `{ nodeId, person: PersonDto \| null, protocol: 1, server: { name, version } }` | 1 |
| `thread.opened` | `{ thread: ThreadDto, messages: MessageDto[] }` | 1 |
| `thread.state` | `{ threadId, state: TurnState }` | 1 |
| `message.user` | `{ message: MessageDto }` (user input from *another* node, or a relay) | 1 |
| `message.started` | `{ threadId, messageId, proactive: boolean }` | 1 |
| `message.delta` | `{ threadId, messageId, text }` | 1 |
| `message.completed` | `{ message: MessageDto }` | 1 |
| `tool.activity` | `{ threadId, messageId, toolCallId, name, status: 'started' \| 'completed' \| 'failed', summary?: string }` | 1 |
| `ui.render` | `{ threadId, messageId?: string, block: UiBlock, fallbackText: string }` | 2 |
| `notice` | `{ level: 'info' \| 'warn', text }` | 1 |
| `error` | `{ code, message }` (+ envelope `re`) | 1 |
| `ping` | `{}` | 1 |
| `audio.stop` | `{ streamId }` (barge-in: stop playback) | 3 |

**Proactive messages (I-11):** `message.started` with `proactive: true` can arrive at any time without any node input. Nodes must render it like any assistant message.

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

## Binary frames (phase 3)

```
byte 0      : frame kind   (1 = audio.in chunk, 2 = audio.out chunk)
bytes 1..16 : streamId     (16 raw bytes of the ULID)
bytes 17..20: sequence     (uint32 big-endian)
bytes 21..  : codec payload (Opus packet or PCM16LE)
```

## WebSocket close codes

| Code | Meaning |
|---|---|
| 4001 | No `hello` within 5 s |
| 4003 | Invalid or expired token |
| 4009 | Protocol version not supported (`hello.protocol` or envelope `v` is not 1) |
| 4010 | Heartbeat timeout |

## Error codes

`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_REQUEST` (HTTP body or query failed validation), `INVALID_FRAME`, `UNKNOWN_FRAME`, `THREAD_BUSY` (reserved), `RATE_LIMITED`, `PROVIDER_ERROR`, `INTERNAL`.

## Code map

| Export | File |
|---|---|
| `FrameEnvelope`, `makeFrame`, `FrameParseResult` | `src/envelope.ts` |
| `NodeFrame`, `parseNodeFrame`, one schema per node frame (`HelloFrame`, …) | `src/frames/node-to-core.ts` |
| `CoreFrame`, `parseCoreFrame`, one schema per core frame (`WelcomeFrame`, …) | `src/frames/core-to-node.ts` |
| `PersonDto`, `ThreadDto`, `MessageDto`, `TurnState`, `Tier`, HTTP bodies (`LoginRequest`, `MessagesQuery`, …) | `src/dto.ts` |
| `ID_PREFIXES`, `prefixedId`, `ThreadId`, `MessageId`, … | `src/ids.ts` |
| `KNOWN_CAPABILITIES`, `Capability`, `parseCapability` | `src/capabilities.ts` |
| `ErrorCode`, `HttpErrorBody`, `WS_CLOSE_CODES` | `src/errors.ts` |
| `UiBlock`, `uiBlockToText` | `src/ui/` ([ui-blocks.md](ui-blocks.md)) |

Each schema and its inferred type share a name (`PersonDto` is both).
