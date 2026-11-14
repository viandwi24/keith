# 0023. Nodes are the body, plugins are the mind

Status: Accepted (2026-11-10). Extends ADR-0003 (plugin layers) and ADR-0016 (one operations registry); specs docs/specs/nodes.md, node.md, plugins.md.

## Context

Nodes already expose capabilities (`system.info`, `shell.exec`) and Keith calls them through `motor_remote`. The owner wants more kinds of nodes:
a home server with full root rights, a desktop that Keith can drive (computer use), the home's IoT and security systems. Plugins add tools, skills
and apps today, all in the core. The open question was whether each node should carry its own plugins.

## Decision

1. **The core is the mind and the authority.** Plugins are installed, enabled and reviewed only in the core. Tools, skills, apps, ACL kinds,
   protocols and every decision (approval, audit, budget) live there. There is one plugin list for the whole Keith.
2. **A node is a body part that exposes capabilities.** A capability is a typed action with a manifest entry: id (`shell.exec`,
   `desktop.screenshot`, `desktop.input`, `iot.switch`), input and output schema, risk level and whether it needs approval. A node runs
   capabilities and returns results; it never decides on its own.
3. **New capabilities come from drivers.** A plugin that needs something on a machine ships two parts: its core part (tools and logic) and a
   **node driver** (a small package that registers capabilities in the node daemon). The node owner installs the driver on that machine
   (`keith-node driver add <name>`); the node announces the driver and its capabilities in its manifest; the core plugin finds nodes by capability.
   A driver has no tools, no prompts, no storage of Keith data.
4. **Rights live on the node, approval lives in the core.** A node may run as root; what it allows is its own manifest (`--allow-shell`, driver
   options). Every risky capability still goes through the core's approval (ADR-0009, amygdala). Nodes are part of Keith's self layer
   (ADR-0020): members with `nodes.read` see them, only the owner pairs, revokes or approves risky actions.
5. **Clients are nodes for a person.** A mobile or web client may expose capabilities too (`notify`, `open.view`, `location.share`), but they belong
   to that person's ecosystem layer (ADR-0025), not to Keith's self, and only that person's turns may call them.

## Consequences

- One place to reason about permissions and audit; nodes stay simple and replaceable.
- Driver packaging and versioning is new work (P31): a manifest version per driver, the core refuses a capability whose schema it does not know.
- Computer use and IoT become drivers, not special cases in the core.
- Revisit when several cores share one body (distributed self, see the decentralisation idea in P0).
