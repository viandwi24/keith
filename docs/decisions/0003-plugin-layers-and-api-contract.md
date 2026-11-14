# 0003. Plugin layers and the Keith API contract

Status: Accepted (2026-10-26)

## Context

Keith will have several equal clients (TUI, web UI, display nodes, plugins) that talk only
through `packages/client`, and it grows by plugins rather than by a bigger core.

## Decision

- Two plugin layers: a Keith host plugin (`packages/host`) registers routes, WebSocket channels,
  static assets and capabilities, and may wrap eharness plugins.
- Chat uses `eharness/http` as is (`/sessions/*`). Its wire types come from eharness, an accepted
  exception to "types only from contracts".
- Every other Keith API is oRPC 1.16.1, contract-first: the contract lives in
  `packages/contracts` (`@orpc/contract` + zod), the core implements it under `/rpc/*` in Hono,
  and `packages/client` gets types without codegen. OpenAPI for outsiders comes from
  `@orpc/openapi`. Installed in M1.
- Layout deviations from the repo standard default: the `plugins/` folder and eharness wire types
  outside `contracts`.

## Consequences

- One contract change updates server and client types at once.
- Hono zod-openapi (as in `examples/team`) was rejected: it binds the contract to server routes
  and needs a generated client.
