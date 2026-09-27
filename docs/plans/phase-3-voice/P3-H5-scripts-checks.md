---
id: P3-H5
title: "Hardening: core.md interface sync check and check-deps tests rule"
phase: 3
wave: 6
lane: H
status: review
owner: agent-P3-H5
depends: [P3-K2]
owns:
  - scripts/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/architecture/core.md
  - docs/architecture/repository.md
updates: []
scenarios: []
---

# P3-H5: Hardening: core.md interface sync check and check-deps tests rule

## Goal

D5 and D6 from [hardening-audit.md](hardening-audit.md).

## Scope

**In:**
- `scripts/check-core-docs.ts` (+ tests): for every `### … (\`<folder>/types.ts\`)` section in core.md, the fenced `ts` block equals the exported declarations of that file (normalize whitespace; decide and document what is compared). Add it to the `check` script chain only if the root `package.json` is in owns; otherwise record the one-line change for P3-I3.
- check-deps: files under `tests/` other than `tests/e2e` may not import `@keith/core`.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [x] The sync check passes on main and fails on a fixture with a drifted block.
- [x] check-deps test for the `tests/` rule.
- [x] `bun run check` passes.

## Outcome

**Built**

- `scripts/check-core-docs.ts` (D5): for every `### … (\`<folder>/types.ts\`)` section in `docs/architecture/core.md`, the first fenced `ts` block must equal the declarations of `packages/core/src/<folder>/types.ts`. It also fails when a `types.ts` has no section, a section names a file that doesn't exist, a section has no `ts` block, or a folder has two sections. Run: `bun scripts/check-core-docs.ts [root]`.
- What is compared (documented in the script header): the file minus its leading `//` header comment and minus `import` statements (re-exports stay; JSDoc and inline comments are compared), against the whole block. Both sides are normalized the same way: JSDoc `*` line prefixes dropped, whitespace runs collapsed, whitespace next to brackets and trailing commas before a closing bracket dropped. So wrapping and indentation never count; any change to a name, type, member, modifier or comment wording does. A later `ts` block in the same section is prose and is ignored.
- `scripts/check-core-docs.test.ts`: parser, normalization, drift cases (changed type, new member, changed comment, missing section/file/block), a fixture repo that fails when drifted and passes in sync, and a test that the real `core.md` matches the real `types.ts` files. It passes on main as-is (no drift today).
- check-deps (D6): new area `tests` for files under `tests/` outside `tests/e2e`. They may import any workspace package except `@keith/core` (any subpath, static, type-only or dynamic), and relative imports from `tests/` may not leave `tests/` (so `../packages/core/src/...` is flagged too; top-level `tests/*.ts` files now have `tests` as their root). `tests/e2e` is unchanged. Tests added in `scripts/check-deps.test.ts`.

**Wiring (not done here, root `package.json` is not in owns)**

Because `scripts/check-core-docs.test.ts` checks the real repo, the sync check already runs inside `bun test` and so inside `bun run check`. For a named step with its own output, P3-I3 should make this one-line change to the root `package.json`:

- add `"core-docs": "bun scripts/check-core-docs.ts"` to `scripts`, and change `check` to `bun run typecheck && bun run lint && bun run deps && bun run core-docs && bun run plans --lint && bun test`.

Also for I3's doc pass: `repository.md` "Dependency direction" could say "Nothing imports `@keith/core` except `tests/e2e` (checked, R-1)", and AGENTS.md's command table could list `core-docs` once wired.

**Deviations:** none. **Follow-ups:** the two I3 items above.
