# ADR-0002: A plugin runs in the core; everything else is a node

- **Status:** accepted
- **Date:** 2026-09-25

## Context

Kehai blurred plugins, clients and nodes. The web client was special (own port, configless API override), and tool plugins wanted to depend on it to show UI.

## Decision

- **A plugin is code that must run inside the core process.** Anything that only consumes the public protocol is a **Node**.
- The TUI is a Node, not a plugin. The web UI is a `client-app` **plugin** (it serves assets and may add routes), and its browser side is a Node that uses the same public `/v1` protocol as the TUI (I-8).
- The core serves everything on **one port** (default 4824). The web plugin mounts static assets at `/`. The core API is `/v1`.
- Tool plugins show UI with UI blocks owned by the core schema (I-9). They never depend on a client app.

## Consequences

- Keith runs CLI-only and the web is an optional install, like a desktop environment on a Linux server.
- Same origin removes the `apiUrl` override and CORS setup.
- The web plugin's server side must stay thin. Features the TUI could also use go into `/v1`, not plugin routes.
