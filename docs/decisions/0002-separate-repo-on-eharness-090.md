# 0002. Separate repo on eharness 0.9.0

Status: Accepted (2026-10-26); the "no upstream PRs" rule is superseded by 0011 (Amended by ADR-0011 §1, upstream contribution); the workarounds it kept for eharness 0.9 are gone since 0.11.0 (P11)

## Context

eharness ADR-0062 says products are built on released versions, outside the eharness repo.
Keith is such a product (Ring 3), like `examples/team`.

## Decision

- Keith lives in its own repo and depends on `eharness` from npm (0.9.0 at the start, 0.12.0 since P11 step 7, 0.13.0 since Nov 13, 2026, 0.14.0 since Nov 14, 2026, 0.14.1 the same day), pinned exactly in the
  workspace catalog.
- No patches to `node_modules` and no upstream PRs during the MVP. Gaps are filled in
  `packages/eh-ext` using only the public eharness API, shaped like eharness modules.
- The eharness source is read from `.ref/eharness` (git-ignored), synced to the pinned tag by
  `bun run ref:sync`.
- From 0.9.0 Keith uses the pairing helpers of `eharness/identity`; scheduler, limits and the
  other new Draft modules wait until a milestone needs them.

## Consequences

- Upgrades are deliberate, one commit each; Dependabot ignores `eharness`.
- Draft modules (`http`, `client`, `activity`, `identity`) may change in a minor release.
- Once data is stored, never downgrade below 0.9: it stores `media-ref` parts 0.8 cannot read.
