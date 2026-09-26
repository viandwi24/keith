# ADR-0011: The browser side of a client-app plugin follows the app rules

- **Status:** accepted
- **Date:** 2026-09-26
- **Rules/invariants affected:** R-1, R-2, I-8

## Context

`@keith/web` is one package with two halves: server code that runs in the core (a `client-app` plugin) and a browser app that is a Node ([plugin-system.md](../architecture/plugin-system.md): "its browser side is a Node"). R-1 says plugins import only `@keith/sdk` and `@keith/protocol`, and apps import only `@keith/protocol` and `@keith/client`. The browser half needs `@keith/client` (its second consumer, the reason the package exists), which R-1 read literally forbids inside `plugins/`. The phase-2 overview puts the browser app in `plugins/web/app/`.

## Decision

- Code under `plugins/<name>/app/**` is a Node, not plugin code. It follows the app rule: it may import `@keith/protocol` and `@keith/client`, never `@keith/sdk`, `@keith/core` or another plugin.
- Plugin server code (`plugins/<name>/src/**`) may not import its own `app/`. The only link between the halves is the built static output that the plugin serves.
- `@keith/client` may import only `@keith/protocol`.
- R-1 in engineering.md gets one sentence saying this, and `scripts/check-deps.ts` enforces it (task P2-K1). Accepted by the owner, who confirmed the concept: `@keith/web` is a plugin that extends the core's HTTP server and WebSocket, and it ships its own browser UI.

## Consequences

- One installable package per client app, as the concept model wants (the plugin ships its own UI).
- check-deps gets two more areas (`client`, plugin `app/`), with tests.
- Other client-app plugins (Telegram, phase 8) have no `app/` and are unaffected.
