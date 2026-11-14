# packages/contracts

Every type that crosses an app boundary: zod schemas, brain events, node protocol, oRPC contract.

- Imported by every app and plugin; imports nothing from this repo.
- Schemas end in `Schema`; types are `z.infer` of them.
- Public API changes show up in `scripts/exports.snapshot.json`.
