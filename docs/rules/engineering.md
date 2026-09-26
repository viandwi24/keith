# Engineering rules

Hard rules. Each one is phrased so a reviewer (human or agent) can check it. Breaking a rule needs an ADR that names the rule ID.

## Structure

- **R-1 Dependency direction.** `@keith/protocol` ← `@keith/sdk` ← `@keith/core`. `plugins/*` import only `@keith/sdk` and `@keith/protocol`. `apps/*` import only `@keith/protocol` (and `@keith/client` from phase 2). Nothing imports `@keith/core` except `tests/e2e`. `@keith/client` imports only `@keith/protocol`. The browser side of a client-app plugin (`plugins/<name>/app/**`) is a Node and follows the app rule; plugin server code never imports its own `app/` ([ADR-0011](../decisions/0011-client-app-browser-side.md)). Enforced by `scripts/check-deps.ts`.
- **R-2 No plugin-to-plugin imports.** Plugins communicate through services and events. The one exception is `import type` from another plugin's `/service` type entry.
- **R-3 Core folders talk through interfaces.** Inside `@keith/core`, a folder imports another folder only through its `types.ts` or its `index.ts`, never deep files. `bootstrap.ts` is the only file that constructs implementations from several folders.
- **R-4 Storage isolation.** Only `core/src/storage` imports `bun:sqlite`, Drizzle or SQL.
- **R-5 Provider isolation.** Only provider plugins (and the SDK's OpenAI-compatible helper) talk to model vendor APIs. No vendor SDK in core.
- **R-6 No speculative abstraction.** No new package, interface-with-one-implementation, adapter layer or plugin kind without a second real consumer. Exceptions are listed in [ADR-0007](../decisions/0007-adapters-only-with-two-implementations.md).
- **R-7 Metaphors are not modules.** Brain and anatomy names (cortex, hypothalamus, CEN, DMN…) never appear as folder, package or type names.

## Behavior

- **R-8 Concept invariants hold.** Code must not violate I-1…I-13 in [model.md](../concept/model.md). Tests that cover an invariant name it in the test title (`"I-4: subject memory hidden from other participant"`).
- **R-9 Validate at every boundary.** Wire frames (both directions), HTTP bodies, config, plugin config, tool input, UI blocks, and JSON columns are parsed with zod. Internal calls between typed modules are not re-validated.
- **R-10 Cancellation.** Every function that does I/O or calls a model accepts an `AbortSignal` and honors it.
- **R-11 Errors.** Throw `KeithError(code, message, { cause })` with codes from a central list. No thrown strings. No silently swallowed errors: every `catch` logs, rethrows, or converts into a documented result. Tool and provider errors never crash a turn.
- **R-12 No hidden global state.** Clock, ID generation, config and logger are injected (constructor parameters or `ctx`). Module-level singletons are banned except constants.
- **R-13 Determinism in tests.** Tests never hit the network or a real model. Use the fake provider in `@keith/sdk/testing`, a fake clock, and a temp `KEITH_HOME`. The only exception is opt-in live smoke tests that skip unless `KEITH_LIVE=1` and never run in CI.
- **R-14 Security defaults.** Bind to `127.0.0.1` by default. Never log secrets (the logger redacts). Hash tokens at rest. Tools check `minTier` in the core (never trust the model to self-restrict). Sandboxed HTML is never same-origin.

## Types and code

- **R-15 TypeScript strict.** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No `any` (use `unknown` and narrow). No non-null `!` except in tests. No `@ts-ignore`. `@ts-expect-error` only with a reason comment.
- **R-16 Docs match code.** A change to behavior described in `docs/architecture` or `docs/contracts` updates that doc in the same commit. Unbuilt designs are marked `> Planned (phase N)`. A reviewer rejects a PR where they disagree.
- **R-17 English only.** Code, identifiers, comments, docs, commit messages, logs and user-facing default strings.
- **R-18 Official scaffolding.** Project and package setup uses official generators (`bun init`, `bun add`, `bunx shadcn@latest add`, `cargo new`, drizzle-kit for migrations). Generated files (lockfiles, migrations, generator output) are never hand-written or hand-edited. Read the current official docs before running one.
- **R-19 One UI component system.** Client apps use one component system (web: shadcn/ui on Tailwind). No mixing component libraries.
- **R-20 Frozen contracts.** See [contracts/README.md](../contracts/README.md).
