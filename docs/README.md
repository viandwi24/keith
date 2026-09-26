# Keith documentation map

Docs are written for two readers: the humans who design Keith and the AI agents who build it. Every file covers one concept. Rules are written as sentences you can verify.

## Precedence

When two docs disagree: **concept > contracts > architecture > plans**. Report any contradiction you find. Don't resolve it silently.

## Folders

| Folder | What lives there | Changes how |
|---|---|---|
| [`concept/`](concept/) | What Keith *is*. Vocabulary and invariants. | Rarely, by the project owner, with an ADR |
| [`contracts/`](contracts/) | Frozen interfaces between parts: wire protocol, events, plugin API, provider API, UI blocks | ADR + dedicated task only |
| [`architecture/`](architecture/) | How the parts work inside. Must match the code. Unbuilt parts are marked `> Planned (phase N)` | In the same change as the code |
| [`rules/`](rules/) | Engineering rules, conventions, agent workflow | ADR for rules; PR for conventions |
| [`decisions/`](decisions/) | ADRs: one decision per file, never edited after `accepted` (supersede instead) | Append only |
| [`plans/`](plans/) | Roadmap, phases, and task files that agents execute | Agents update task status and outcome |
| [`reference/`](reference/) | Prior art and external systems worth learning from | Freely |

## Files

**Concept**
- [vision.md](concept/vision.md): why Keith exists and what "feels alive" means
- [model.md](concept/model.md): Mind, Relationship, Thread, Node, Plugin, and their invariants
- [glossary.md](concept/glossary.md): one word, one meaning
- [scenarios.md](concept/scenarios.md): canonical scenarios S-1…S-8, the acceptance targets for each phase
- [lessons.md](concept/lessons.md): what went wrong in Kehai (the predecessor) and the rule each lesson produced

**Architecture**
- [overview.md](architecture/overview.md): the whole system on one page
- [repository.md](architecture/repository.md): packages, folders, dependency direction
- [stack.md](architecture/stack.md): chosen tools and open choices
- [core.md](architecture/core.md): threads, the turn loop, scheduler, tasks, commitments, deliveries
- [plugin-system.md](architecture/plugin-system.md): plugin kinds, lifecycle, services and events
- [nodes.md](architecture/nodes.md): nodes, capabilities, auth, focus
- [providers.md](architecture/providers.md): the adapter seams for LLM and voice
- [memory.md](architecture/memory.md): memory kinds, visibility, recall
- [ui.md](architecture/ui.md): how plugins show UI without knowing which client renders it
- [storage.md](architecture/storage.md): SQLite layout
- [config.md](architecture/config.md): the `~/.keith` home and `config.toml`
- [voice.md](architecture/voice.md): voice pipeline (planned, phase 3)
- [workspace.md](architecture/workspace.md): the visual workspace (planned, phase 6)

**Contracts**
- [README.md](contracts/README.md): freeze rules
- [protocol.md](contracts/protocol.md): HTTP + WebSocket wire protocol between core and nodes
- [events.md](contracts/events.md): the internal event catalog
- [plugin-api.md](contracts/plugin-api.md): `definePlugin`, `PluginContext`, registries, tools
- [providers.md](contracts/providers.md): `LlmProvider` and the voice provider interfaces
- [ui-blocks.md](contracts/ui-blocks.md): standard UI block schema

**Rules**
- [engineering.md](rules/engineering.md): hard rules
- [conventions.md](rules/conventions.md): naming, files, tests, commits, docs style
- [agent-workflow.md](rules/agent-workflow.md): task lifecycle and parallel work

**Decisions**: [index](decisions/README.md)

**Plans**: [how plans work](plans/README.md) · [roadmap](plans/roadmap.md)

**Reference**: [prior-art.md](reference/prior-art.md)
