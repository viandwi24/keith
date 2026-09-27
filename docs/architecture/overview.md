# Architecture overview

```
┌──────────────────────────────── core process (Bun) ─────────────────────────────────┐
│                                                                                      │
│   Mind                                                                               │
│   ├─ ThreadManager ── turn loop ── context builder ── LLM (via provider registry)     │
│   ├─ Scheduler (lanes: foreground > delivery > background)                           │
│   ├─ Tasks · Commitments · Deliveries · Reminders                                    │
│   └─ Memory (episodic messages + semantic memories, visibility-filtered)             │
│      └─ memory jobs: reflection (idle threads) · thread summaries (utility model)    │
│                                                                                      │
│   Plugin host ── registries: services · events · tools · skills · agents ·           │
│                               providers · http · ws                                  │
│                                                                                      │
│   Server: one port (default 4824) ── HTTP /v1/*  +  WebSocket /v1/ws                 │
│                                                                                      │
│   Storage: one SQLite file + one data folder under ~/.keith                          │
└───────────────────────────────▲──────────────────────────▲──────────────────────────┘
                                │ public protocol           │ public protocol
                 ┌──────────────┴───────┐       ┌───────────┴─────────────┐
                 │ apps/tui (Node)      │       │ browser (Node), served   │
                 │ chat.text@1          │       │ by plugins/web           │
                 └──────────────────────┘       │ chat.text, ui.render,    │
                                                │ audio.in/out             │
                                                └──────────────────────────┘
                 Planned: nodes/system (Rust, headless: fs, screen, mic, notify)
```

## The parts

| Part | Responsibility | Doc |
|---|---|---|
| **Mind** | Threads, turns, context, scheduling, tasks, commitments, deliveries, reminders (phase 4: `reminder.*` tools, fired on the scheduler tick as `reminder` deliveries) | [core.md](core.md) |
| **Memory** | Episodic history, semantic memories, visibility, recall. Phase 4 memory jobs in the `background` lane on the `utility` model: reflection turns idle threads into inferred memories and card notes; thread summaries fold rows that left the window into `threads.summary` | [memory.md](memory.md) |
| **Plugin host** | Loads plugins from config, runs `setup`/`start`/`stop`, owns the registries | [plugin-system.md](plugin-system.md) |
| **Providers** | Adapter seams for LLM (now) and voice (phase 3) | [providers.md](providers.md) |
| **Server** | HTTP + WS on one port, auth, node handshake, frame routing | [nodes.md](nodes.md), [protocol](../contracts/protocol.md) |
| **Storage** | SQLite via Drizzle, data folder | [storage.md](storage.md) |
| **Config** | `~/.keith/config.toml`, env-var secrets | [config.md](config.md) |
| **UI** | UI blocks from tools, rendered by capable nodes | [ui.md](ui.md) |

## Commands, startup and shutdown

The `keith` command is the `bin` of `@keith/core` (`packages/core/src/cli/main.ts`; in the repo, `bun run dev` runs `keith start` in watch mode). `KEITH_HOME` defaults to `~/.keith`.

| Command | What it does |
|---|---|
| `keith setup` | Creates `KEITH_HOME`, `config.toml`, `persona.md`, the database and the owner Person, offers to enable the web app (`@keith/web`) and the weather tool (`@keith/tool-weather`), and offers voice (none / cloud / local / mixed) (see [config.md](config.md#keith-setup), [ui.md](ui.md#enabling-the-web-app-s-8)) |
| `keith start [--port N] [--host H]` | Runs `bootstrap()` and serves until SIGINT/SIGTERM. Refuses (exit 1) while another Keith holds the home's lock (I-1, [config.md](config.md#logs-and-lock)) |
| `keith migrate` | Applies pending database migrations (`keith start` does this too) |
| `keith backup [--out <dir>]` / `keith restore <dir> [--force]` | A consistent copy of the home while Keith runs, and restoring one into a home ([config.md](config.md#keith-backup-and-keith-restore)) |
| `keith --version` | Prints the version |

`bootstrap({ home, flags, env?, plugins?, clock?, log? })` in `core/src/bootstrap.ts` takes the `KEITH_HOME` lock, builds everything in the order of [core.md](core.md#construction-order-bootstrap) and returns a running `Keith` (`url`, `port`, `stop()`, …). Without `log` it logs JSON lines to stdout and to `logs/keith.log`. Tests pass `plugins` (the SDK's fake LLM plugin), a fake clock, their own `log` and `flags: { port: 0 }`. If any step fails, what was already built is torn down again (the lock is released) and the error is rethrown.

**Graceful shutdown** (`keith.stop()`, on the first SIGINT or SIGTERM; a second signal exits at once):

1. `core.stop_requested`, then `presence.flushPresence()` (last-seen times of everyone still here).
2. The server stops listening and closes every socket.
3. The ThreadManager stops (no new turns or holds), then `cancelAll()` cancels every running turn and waits for it. Its partial text is persisted with `meta.cancelled = true`.
4. Presence is disposed, the memory jobs stop (running reflection and summary passes are aborted and write nothing), the scheduler stops (running tasks are aborted but keep their stored status, so the next start recovers them), memory unsubscribes, plugins stop in reverse order, the event bus drains, and the database closes.
5. The log file closes, and the home lock is released last.

## Life of a text turn

1. The TUI sends `input.text` over WS.
2. The server validates the frame with `@keith/protocol`, resolves the Person from the connection, and hands it to `ThreadManager.input()`.
3. The Thread persists the user message, broadcasts `message.user` to other attached nodes, sets focus, and moves to `thinking`.
4. The turn job enters the **foreground** lane of the scheduler.
5. The context builder assembles persona + relationship card + visible memories + awareness digest + recent messages + skill index + permitted tools.
6. The turn loop streams from the `foreground` model. Text deltas become `message.delta` frames (state `speaking`). Tool calls run and loop back, up to `maxSteps`.
7. The assistant message is persisted, the state returns to `idle`, and pending deliveries are flushed.

## Life of a promise

1. During a turn the model calls `task.start({ goal, notify: "when-done", promise })` (optionally with an `agent`; the default is `general`).
2. The core creates a `Task` (background lane) and a `Commitment` linked to the Thread.
3. The Task runs its own LLM loop with the Agent's prompt and tools on the `background` model.
4. On completion the Commitment is fulfilled and a `Delivery` is queued for the Thread.
5. When the Thread is `idle`, the Mind runs a short proactive turn that phrases the result. Nodes receive unsolicited `message.*` frames (I-11). If the person is away, the Delivery waits until they are present again, and on arrival it is folded into the briefing ([core.md](core.md#presence-and-arrival)).

## Where each concern does *not* live

- Voice pipeline: in the core, not in nodes (except wake word). See [voice.md](voice.md).
- UI rendering: in client apps, never in tool plugins. See [ui.md](ui.md).
- Provider SDKs: only inside provider adapters.
