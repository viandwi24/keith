# Architecture Decision Records

One decision per file. Accepted ADRs are never edited except for their status line. A new ADR supersedes an old one (`status: superseded by ADR-NNNN`).

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-one-mind-relationships-threads.md) | One Mind, many Relationships and Threads | accepted |
| [0002](0002-plugins-run-in-core-nodes-do-not.md) | A plugin runs in the core; everything else is a node | accepted |
| [0003](0003-modality-per-message-and-focus.md) | Modality per message; focus instead of takeover | accepted |
| [0004](0004-keith-owns-the-agent-loop.md) | Keith owns the agent loop; providers stream one completion | accepted |
| [0005](0005-services-for-requests-events-for-facts.md) | Services for requests, events for facts | accepted |
| [0006](0006-sqlite-only-storage.md) | SQLite only, no storage adapter layer | accepted |
| [0007](0007-adapters-only-with-two-implementations.md) | Adapters only where a second implementation exists | accepted |
| [0008](0008-first-llm-providers.md) | First LLM providers: OpenRouter and DeepSeek | accepted |
| [0009](0009-rust-only-out-of-process.md) | Rust only for out-of-process nodes | accepted |
| [0010](0010-tui-framework.md) | OpenTUI (core API, no React) for the TUI node | accepted |

## Writing an ADR

Copy the template below to `NNNN-<slug>.md` (the next free number). Agents create ADRs with `status: proposed`. Only the coordinator sets `accepted` and updates this index, so agents never edit this file.

**Reserved numbers:** `0011` for P2-K1 (browser side of client-app plugins), `0012` for P2-C1 (web bundler). Other agents start at `0013`. If two agents collide on a number, the coordinator renumbers the later one.

```markdown
# ADR-NNNN: <decision as a short statement>

- **Status:** proposed | accepted | superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Rules/invariants affected:** R-x, I-y (if any)

## Context
What forces are at play. Two to six sentences.

## Decision
What we do. Bullet points, checkable.

## Consequences
What gets easier, what gets harder, what follow-up work exists.
```
