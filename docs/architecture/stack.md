# Stack

Status legend: **decided** = use it. **open** = the named task decides it and records an ADR.

| Concern | Choice | Status | Notes |
|---|---|---|---|
| Runtime + package manager | Bun | decided | Workspaces, `bun test`, `Bun.serve` for HTTP + WS, `bun:sqlite`, built-in TOML parsing |
| Language | TypeScript, `strict` | decided | No `any`. See [engineering.md](../rules/engineering.md) |
| Schemas / validation | zod | decided | Protocol, config, tool input, plugin config. Check the current major version and API in the official docs at scaffold time |
| Lint + format | Biome | decided | One tool, no ESLint/Prettier |
| Tests | `bun test` | decided | Colocated `*.test.ts`; e2e in `tests/e2e/` |
| Database | SQLite via `bun:sqlite` | decided | [ADR-0006](../decisions/0006-sqlite-only-storage.md) |
| Query builder + migrations | Drizzle ORM (bun-sqlite driver) + drizzle-kit | decided | Only inside `core/src/storage` |
| Full-text search | SQLite FTS5 | decided | Memory recall v1 |
| Vector search | `sqlite-vec` | open, phase 4 | Only if FTS recall proves insufficient |
| IDs | Prefixed ULIDs (`thr_…`, `msg_…`) | decided | See [conventions.md](../rules/conventions.md#identifiers) |
| Password hashing | Argon2id via `Bun.password` | decided | No extra dependency |
| Auth tokens | Opaque random tokens, SHA-256 hashed in DB | decided | No JWT needed: core is the only verifier |
| LLM providers | Own adapter interface. OpenRouter + DeepSeek via an OpenAI-compatible helper | decided | [ADR-0004](../decisions/0004-keith-owns-the-agent-loop.md), [ADR-0008](../decisions/0008-first-llm-providers.md) |
| TUI framework | Ink (React for terminals) or OpenTUI | open, task P1-F1 | Pick for Bun compatibility and streaming-text rendering |
| Web UI | React + Tailwind + shadcn/ui | decided (phase 2) | One component system only |
| Web bundler | Bun's HTML bundler or Vite | open, phase 2 | Output must be static assets served by the web plugin |
| Voice transport (browser) | WebSocket binary frames first. WebRTC later if latency needs it | decided (phase 3) | [voice.md](voice.md) |
| System node | Rust | decided (phase 7) | Out of process only. [ADR-0009](../decisions/0009-rust-only-out-of-process.md) |
| Tool ecosystem bridge | MCP client (tools from MCP servers → tool registry) | decided (phase 8) | Untrusted third-party code runs out of process via MCP |

## Rules for adding a dependency

1. Prefer Bun built-ins over packages.
2. Add with `bun add` in the package that uses it, never at the root unless it is dev tooling.
3. Read the dependency's current official docs first. Record the major version you targeted in the task `## Outcome`.
4. A dependency that crosses a package boundary (appears in public types) needs a note in this file.
