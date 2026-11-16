# Decisions (ADR)

One file per decision: `NNNN-short-title.md`, numbered in order, never renumbered. A decision
that changes is superseded by a new ADR; the old one gets `Status: Superseded by NNNN`.

Format:

```markdown
# NNNN. Title

Status: Accepted (YYYY-MM-DD)

## Context
What forces the decision.

## Decision
What we do.

## Consequences
What gets easier, what gets harder, and when to revisit.
```

Index:

- [0001](0001-branch-license-visibility.md) Branch, license, visibility
- [0002](0002-separate-repo-on-eharness-090.md) Separate repo on eharness 0.9.0
- [0003](0003-plugin-layers-and-api-contract.md) Plugin layers and API contract
- [0004](0004-neurological-naming.md) Neurological naming
- [0005](0005-bun-workspaces-without-turborepo.md) Bun workspaces without Turborepo
- [0006](0006-bun-first-tooling.md) Bun-first tooling
- [0007](0007-dynamic-registries.md) Dynamic registries
- [0008](0008-admin-socket-and-identity.md) Admin socket, credentials and device login
- [0009](0009-people-roles-and-step-up.md) People, roles, capabilities and step-up
- [0010](0010-manage-in-the-tui.md) Manage Keith from the terminal UI
- [0011](0011-generic-gaps-go-upstream.md) Generic eharness gaps go upstream
- [0012](0012-generic-packages-live-in-keith-until-moved.md) Generic packages live in Keith until they move
- [0013](0013-sign-in-inside-the-tui.md) Sign in inside the terminal UI
- [0014](0014-auth-adapters-and-sessions.md) Authentication adapters, policy as data and real sessions
- [0015](0015-acl-and-visibility.md) ACL and visibility: mode bits plus entries
- [0016](0016-keith-plugin-layer.md) The Keith plugin layer: one operations registry
- [0017](0017-guest-mode.md) Guest mode: anonymous, incognito, owner-paid
- [0018](0018-plugin-tui-views-rendered-on-the-server.md) Plugin terminal views are rendered on the server
- [0019](0019-home-is-the-shell.md) Home is the shell: panels and toasts, never bare screens
- [0020](0020-one-keith-many-conversations.md) One Keith, many conversations: four layers of awareness
- [0021](0021-workspaces-per-owner-and-sandbox.md) Workspaces belong to someone, and the core never executes code
- [0022](0022-delegation-is-not-succession.md) Delegation is not succession
- [0023](0023-nodes-are-the-body-plugins-are-the-mind.md) Nodes are the body, plugins are the mind
- [0024](0024-protocols-and-proactive-behaviour.md) Protocols: one engine for proactive behaviour (hypothalamus)
- [0025](0025-presence-and-ecosystem-context.md) Presence and ecosystem context (parietal)
- [0026](0026-shared-rooms-group-call-mode.md) Shared rooms: group call mode (corpus callosum)
- [0027](0027-flow-review-decisions-locked.md) Flow review 2026-11-09: every open decision locked
- [0028](0028-reminders-keep-their-own-scheduler.md) Reminders keep their own scheduler; protocols do not absorb them
- [0029](0029-persona-and-answer-modes.md) Persona and answer modes: who Keith is, and how it speaks (prefrontal)
- [0030](0030-context-reset-and-manual-compaction.md) Context reset and manual compaction: a fresh front context on request (built in P34)
- [0031](0031-memory-dreaming.md) Memory dreaming: an offline consolidation pass of one person's memory (built in P35)
- [0032](0032-activity-logs-and-session-kinds.md) Activity logs: every model call is recorded per session, and a session has a registered kind (built in P36)
- [0033](0033-client-context.md) Client context: the front agent knows which client the person uses, from where and when (the environment a client reports, the network the core derives, always on: the per-person switch was removed Nov 12, 2026)
- [0034](0034-reach-and-address.md) Reach and address: presence-aware delivery with a hold and return digest, persona addressing, persona and style set in conversation (built in P37)
- [0035](0035-web-client.md) Web client: `apps/web` is a built-in SvelteKit SPA served by the core at `/app`, signed in with an HttpOnly cookie (P38)
- [0036](0036-conversational-consent.md) Conversational consent: risk × clean/tainted decides between running with undo, asking in conversation and a trusted-device confirmation (P39)
- [0037](0037-workspace-modes-desktops-windows.md) Workspace: ambient, workspace and overview modes; one versioned workspace per person in the core; Keith drives it with manners in code (proposed, P40)
- [0038](0038-extension-points-and-plugin-window-apps.md) Extension points: a plugin opens a point, others contribute; the plugin `web` and sandboxed plugin window apps (proposed, P40)
- [0039](0039-effect-based-consent.md) Effect-based consent: consent reads what a call can do (none, local, behavior, egress, destructive) and where its targets came from; amends ADR-0036 (P41)
- [0040](0040-gpu-window-apps-and-live-layers.md) GPU window apps, library mounts and live data layers: the maps globe (CesiumJS), `gpu`/`media`/`live` window flags, plugin config from the environment, an MCP endpoint (proposed)
