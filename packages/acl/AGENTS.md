# packages/acl

Resource-level access (ADR-0015, docs/specs/acl.md): the pure evaluator, the `Membership` and `AclStore` ports, an in-memory store and the
conformance cases (`@keith/acl/testing`).

- Imports only `@keith/contracts`. No I/O, no clock in `check`: it is pure and deterministic.
- The SQLite adapter lives in `packages/db` and must pass the same cases (`src/testing/cases.ts`).
- Groups are looked up at check time through `Membership`; never copy them into an actor.
- A denied read and a missing resource are the same answer (`AclError('NOT_FOUND')`), never a different message.
