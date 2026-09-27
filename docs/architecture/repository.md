# Repository layout

Bun workspace monorepo. Package count is kept low on purpose. A new package needs a second real consumer (R-6).

```
keith/
├─ AGENTS.md · CLAUDE.md · README.md
├─ package.json              # workspaces: packages/*, plugins/*, apps/*
├─ biome.json · tsconfig.base.json
├─ scripts/                  # repo tooling: plans board, check-deps, check-core-docs
├─ docs/
├─ tests/e2e/                # cross-package end-to-end tests (core + fake provider + protocol client, Playwright)
├─ packages/
│  ├─ protocol/              # @keith/protocol: wire contract (zod schemas + inferred types)
│  ├─ sdk/                   # @keith/sdk: plugin-facing API and helpers
│  ├─ client/                # @keith/client: protocol client for TS nodes (TUI, web browser app)
│  └─ core/                  # @keith/core: the core process and the `keith` CLI (src/, test/, drizzle/ migrations)
├─ plugins/
│  ├─ provider-openrouter/   # @keith/provider-openrouter
│  ├─ provider-deepseek/     # @keith/provider-deepseek
│  ├─ web/                   # @keith/web (phase 2): client-app plugin (src/ = server side, app/ = browser app, a Node)
│  ├─ tool-weather/          # @keith/tool-weather (phase 2): reference tool plugin with UI
│  ├─ vad-energy/            # @keith/vad-energy (phase 3): energy VAD
│  ├─ voice-groq/            # @keith/voice-groq (phase 3): cloud STT
│  ├─ voice-openai/          # @keith/voice-openai (phase 3): cloud TTS
│  └─ voice-speaches/        # @keith/voice-speaches (phase 3): local STT + TTS
├─ apps/
│  └─ tui/                   # @keith/tui: terminal node
└─ nodes/                    # (phase 7) Rust, out-of-process nodes
   └─ system/
```

## Packages

### `@keith/protocol`
The wire contract between core and every node: frame envelope, frame schemas, HTTP DTOs, capability ids, UI block schema. **Dependencies: `zod` only.** Used by core, SDK, every client and every node implementation in TS. Rust nodes mirror it (generated JSON Schema, planned).

### `@keith/sdk`
Everything a plugin author touches: `definePlugin`, `defineTool`, `defineSkill`, `defineAgent`, `PluginContext` and registry interfaces, provider interfaces (`LlmProvider`, …), the `createOpenAICompatibleLlm` helper, and `@keith/sdk/testing` (a scripted fake LLM provider and a fake `PluginContext`). **Dependencies: `@keith/protocol`, `zod`.**

### `@keith/client`
The protocol client every TypeScript Node is built on: the TUI now, the web browser app (`plugins/web/app/`) next. **Dependencies: `@keith/protocol` only** ([ADR-0011](../decisions/0011-client-app-browser-side.md)). It runs in Bun and in browsers: standard `fetch` and `WebSocket`, no `bun:*` / `node:*` imports (a test checks both). Rendering and storage stay in each app.

| Module | Public API |
|---|---|
| `http.ts` | `normalizeBaseUrl`, `wsUrl`, `login`, `logout`, `getMe`, `listThreads`, `listMessages(…, { before, limit })` (history paging). `fetch` is injectable. Errors are `ClientError { code }` (`LOGIN_FAILED`, `UNAUTHORIZED`, `NOT_FOUND`, `HTTP_ERROR`, `NETWORK`, `INVALID_RESPONSE`, `INVALID_URL`, `ABORTED`) |
| `session.ts` | `StoredSession` (url, token, person, expiresAt, nodeId), `SessionStore` (injected storage: the TUI's `tui.json`, the browser's `localStorage`), `parseStoredSession`, `memorySessionStore`, `webStorageSessionStore(localStorage)`, and `createAuth({ baseUrl, store })` with `restore`, `login`, `logout`, `rememberNodeId`, `expire` |
| `chat.ts` | `createChatClient({ baseUrl, token, nodeId, client, capabilities, audio, onState, onNodeId, onAudio, … })`: `hello` (default `chat.text@1`; a UI node adds `ui.render@1`; `clientCapabilities` adds `audio.in@1` / `audio.out@1` only from the `audio: { input, output }` option), `thread.open` of the main thread, `ping` → `pong`, reconnect with exponential backoff (500 ms → 15 s) that reopens the same thread. Methods: `start`, `send`, `cancel`, `sendUiAction`, `loadOlder`, `startAudio()` (`audio.start`, PCM16 16 kHz, new bare-ULID stream id), `sendAudio(streamId, sequence, pcm16)` (a kind-1 binary frame), `endAudio(streamId)`, `reconnect(token?)` (after 4003 and a new login), `close`. `onAudio` gets `start`, `chunk`, `end`, `stop` (from the core's audio frames) and `flush` (a new user input) |
| `audio.ts` | `AudioEvent`, `newStreamId`, `pcm16ToBytes` / `pcm16FromBytes` / `pcm16ToFloat32`, and `createPlaybackQueue({ sink })`: a platform-free queue behind a `PlaybackSink` that plays each stream in `sequence` order and stops at once on `stop` / `flush` (the web app's sink is Web Audio) |
| `state.ts` | `ChatState` and the pure reducer (`applyFrame`, `applyLocal`): connection status, person, thread, turn state, entries (messages with streaming text, the proactive mark and their `ui` blocks; tool activity; notices; floating UI blocks) and `history { hasMore, loading }` |
| `labels.ts` | `turnLabel`, `connectionLabel` for status bars |

`@keith/client/testing` (Bun only, for tests): `startFakeCore`, a stand-in core on `Bun.serve` built on the protocol schemas (HTTP API, WS handshake, streamed replies, tool activity, proactive messages, `ui.render`, history, audio frames both ways), and `waitUntil`.

### `@keith/core`
The running process. Internal folders:

| Folder | Owns |
|---|---|
| `src/cli/` | `keith start`, `keith setup`, `keith migrate`, `keith backup` (`cli/backup.ts`) and `keith restore` (`cli/restore.ts`) |
| `src/shared/` | Logger, rotating log file, `KEITH_HOME` lock, clock and prefixed-ULID generator implementations |
| `src/config/` | Loading and validating `~/.keith/config.toml` |
| `src/plugins/` | Plugin host, registry implementations (services, tools, skills, agents, providers) |
| `src/events/` | Event bus implementation |
| `src/server/` | Bun HTTP + WS, auth, handshake, frame routing, http/ws registries |
| `src/storage/` | Drizzle schema, migration runner, repositories, `backupDatabase` (`storage/backup.ts`). The generated SQL migrations live in `packages/core/drizzle/` (drizzle-kit, [storage.md](storage.md)) |
| `src/mind/` | ThreadManager, turn loop, context builder, focus, turn state |
| `src/scheduler/` | Lanes, Tasks, Commitments, Deliveries, Reminders (`scheduler/reminders.ts`, phase 4) |
| `src/memory/` | Memory write/recall, visibility filter, awareness digest. Phase 4 memory jobs: `memory/reflect/` (reflection) and `memory/summary/` (thread summaries) |
| `src/voice/` | Phase 3: the voice pipeline (VAD → STT → Mind, TTS → focus node) and `checkVoiceProviders` ([voice.md](voice.md)) |
| `src/builtins/` | Built-in tools: `task.*`, `memory.*`, `skill.load`, `reminder.*` (phase 4), and the default skills in `builtins/skills/` (`morning_briefing`) |
| `src/bootstrap.ts` | Wires everything together. Owned by integration tasks only |

Core folders talk through TypeScript interfaces declared in [core.md](core.md#internal-interfaces). This lets lanes build in parallel against the interface before the implementation exists. `bun run core-docs` (`scripts/check-core-docs.ts`, part of `bun run check`) fails when an interface block in core.md differs from its `types.ts`.

**Runtime plugin dependencies.** `@keith/core` lists the first-party plugins as `dependencies` (`@keith/provider-deepseek`, `@keith/provider-openrouter`, `@keith/web`, `@keith/tool-weather`, `@keith/vad-energy`, `@keith/voice-groq`, `@keith/voice-openai`, `@keith/voice-speaches`), so the plugin host's `import()` of a configured name resolves under Bun's isolated linker ([config.md](config.md)). The core's code never imports them; only the plugin host loads them by name at run time.

## Dependency direction

```
@keith/protocol  ◄──  @keith/sdk  ◄──  @keith/core
       ▲                   ▲
       │                   └──── plugins/*
       └──── apps/*, plugins/*/app, @keith/client
```

- `plugins/*` import only `@keith/sdk` and `@keith/protocol` (R-1).
- `apps/*` and the browser side of client-app plugins (`plugins/*/app/**`) import only `@keith/protocol` and `@keith/client` ([ADR-0011](../decisions/0011-client-app-browser-side.md)).
- `@keith/client` imports only `@keith/protocol`.
- Nothing imports `@keith/core` except its own tests and `tests/e2e`. Other files under `tests/` may not import it either, not even by relative path (R-1).
- Plugins never import each other (R-2). The one exception: `import type` from another plugin's `/service` type entry (the service's request and result types).
- Only `packages/core/src/storage` imports `bun:sqlite` or Drizzle (R-4).
- Only provider plugins import model-vendor SDKs (`openai`, `@ai-sdk/*`, …) (R-5).

All of these are checked by `bun run deps` (`scripts/check-deps.ts`), which is part of `bun run check`.

## Planned packages (do not create early)

| Package | Created when | Second consumer |
|---|---|---|
| JSON Schema export of protocol | Phase 7 | Rust system node |
