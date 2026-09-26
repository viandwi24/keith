# Repository layout

Bun workspace monorepo. Package count is kept low on purpose. A new package needs a second real consumer (R-6).

```
keith/
├─ AGENTS.md · CLAUDE.md · README.md
├─ package.json              # workspaces: packages/*, plugins/*, apps/*
├─ biome.json · tsconfig.base.json
├─ scripts/                  # repo tooling (e.g. plans board)
├─ docs/
├─ tests/e2e/                # cross-package end-to-end tests (core + fake provider + protocol client)
├─ packages/
│  ├─ protocol/              # @keith/protocol: wire contract (zod schemas + inferred types)
│  ├─ sdk/                   # @keith/sdk: plugin-facing API and helpers
│  └─ core/                  # @keith/core: the core process and the `keith` CLI
├─ plugins/
│  ├─ provider-openrouter/   # @keith/provider-openrouter
│  ├─ provider-deepseek/     # @keith/provider-deepseek
│  ├─ web/                   # @keith/web (phase 2): client-app plugin (src/ = server side, app/ = browser app, a Node)
│  └─ tool-weather/          # @keith/tool-weather (phase 2): reference tool plugin with UI
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

### `@keith/core`
The running process. Internal folders:

| Folder | Owns |
|---|---|
| `src/cli/` | `keith start`, `keith setup`, `keith migrate` |
| `src/shared/` | Logger, clock and prefixed-ULID generator implementations |
| `src/config/` | Loading and validating `~/.keith/config.toml` |
| `src/plugins/` | Plugin host, registry implementations (services, tools, skills, agents, providers) |
| `src/events/` | Event bus implementation |
| `src/server/` | Bun HTTP + WS, auth, handshake, frame routing, http/ws registries |
| `src/storage/` | Drizzle schema, migrations, repositories |
| `src/mind/` | ThreadManager, turn loop, context builder, focus, turn state |
| `src/scheduler/` | Lanes, Tasks, Commitments, Deliveries |
| `src/memory/` | Memory write/recall, visibility filter, awareness digest |
| `src/builtins/` | Built-in tools: `task.*`, `memory.*`, `skill.load` |
| `src/bootstrap.ts` | Wires everything together. Owned by integration tasks only |

Core folders talk through TypeScript interfaces declared in [core.md](core.md#internal-interfaces). This lets lanes build in parallel against the interface before the implementation exists.

## Dependency direction

```
@keith/protocol  ◄──  @keith/sdk  ◄──  @keith/core
       ▲                   ▲
       │                   └──── plugins/*
       └──── apps/*, plugins/*/app, @keith/client
```

- `plugins/*` import only `@keith/sdk` and `@keith/protocol`.
- `apps/*` and the browser side of client-app plugins (`plugins/*/app/**`) import only `@keith/protocol` and `@keith/client` ([ADR-0011](../decisions/0011-client-app-browser-side.md)).
- `@keith/client` imports only `@keith/protocol`.
- Nothing imports `@keith/core` except `tests/e2e`.
- Plugins never import each other.

Enforced by a dependency-check script in `bun run check` (task P0-01).

## Planned packages (do not create early)

| Package | Created when | Second consumer |
|---|---|---|
| `@keith/client` | Phase 2 | TUI + web browser app both need a WS client |
| JSON Schema export of protocol | Phase 7 | Rust system node |
