# Contracts

Contracts are the interfaces between independently built parts. Freezing them is what lets tasks run in parallel. An agent building the TUI and an agent building the WS server never need to talk to each other, because both build against [protocol.md](protocol.md).

| Contract | Code home | Consumers |
|---|---|---|
| [protocol.md](protocol.md) | `packages/protocol` | core server, every node |
| [events.md](events.md) | `packages/sdk` (types) + `packages/core/src/events` | core, plugins |
| [plugin-api.md](plugin-api.md) | `packages/sdk` | core plugin host, every plugin |
| [providers.md](providers.md) | `packages/sdk` | core, provider plugins |
| [ui-blocks.md](ui-blocks.md) | `packages/protocol` | tool plugins, client apps |

## Freeze rules

1. The contracts are **drafted and frozen in phase 0** (tasks P0-02, P0-03). After the freeze they are `v1`.
2. After the freeze, a change needs: an ADR explaining why, a dedicated task that updates the doc *and* the code *and* the schema tests, and a bump when the change is breaking (`protocol` field in `welcome`, `capability@N`).
3. **Additive changes** (a new optional field, a new frame type, a new event) still need a task, but no ADR if they are marked additive in the task.
4. The doc and the code must agree. `packages/protocol` has a test that parses every example in `protocol.md` and `ui-blocks.md` (examples are fenced ` ```json frame` / ` ```json block` code blocks). An example that doesn't parse fails CI.
5. Agents implementing against a contract **never** change it as a side effect. If the contract is wrong or incomplete, record a blocker in the task.
