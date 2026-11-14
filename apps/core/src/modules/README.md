# Modules

One folder per brain region or feature (`thalamus`, `cortex`, `amygdala`, `nodes`, …), each a
vertical slice: routes, service, storage and tests together. A module exposes its public API only
through `index.ts`; other modules import `modules/<name>/index.ts` and never its internal files
(enforced by check-imports rule `module-public-api`). Shared plumbing lives in `src/platform/`.
