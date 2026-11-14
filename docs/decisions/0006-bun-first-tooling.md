# 0006. Bun first: other tools only where Bun cannot do the job

Status: Accepted (2026-10-26)

## Context

Keith runs on Bun. Bun already covers install, workspaces, version catalog, test runner,
bundler (`bun build`, `--compile`), shell scripting (`Bun.$`), file globbing (`Bun.Glob`),
an import scanner and resolver (`Bun.Transpiler`, `Bun.resolveSync`) and a vulnerability check
(`bun audit`). Every extra tool is one more thing to learn, update and debug.

## Decision

Use a Bun built-in when it does the job. Add a non-Bun tool only when Bun cannot, and record
the reason in the table below in the same commit.

| Job | Tool | Why not Bun alone |
| --- | --- | --- |
| Run, install, workspaces, catalog, test, scripts | Bun | — |
| Import boundaries and cycles | `scripts/check-imports.ts` on `Bun.Transpiler.scanImports` + `Bun.resolveSync` | — (replaced dependency-cruiser + `@swc/core`, which could not read TypeScript 7) |
| Size, export snapshot, `.ref` sync, agent hooks | `scripts/*.ts` on Bun | — |
| Vulnerability check | `bun audit` (CI, level `high`) | — |
| Build / single binary (when needed) | `bun build` / `bun build --compile` | — |
| Type checking | `tsc --noEmit` (`typescript`) | Bun strips types and runs the code without checking them. `bun init` installs `typescript` for this reason |
| Format and lint | Biome | Bun has no formatter or linter |
| Commit message rules | commitlint | Bun has no commit-message linter; commitlint is the reference for Conventional Commits and also checks ranges in CI |
| Changelogs and versions | Changesets | Bun has no release/version tool |
| Database migrations | drizzle-kit | `bun:sqlite` runs SQL but does not generate migrations from a schema |
| Secret scanning | gitleaks | Bun has no secret scanner |
| Run CI locally / lint workflows | act, actionlint (machine tools, not repo deps) | Outside Bun's scope |
| Ink component tests | ink-testing-library | `bun test` has no Ink renderer |
| Archives that keep entry modes (`backup`, `restore`, `people export`, P26.2.1) | `tar` on the system, run with `Bun.spawn` | `Bun.Archive` builds an archive from an object with no per-entry mode: every file is written 0644 and an executable loses its bit, and extraction does not restore modes either (checked on Bun 1.4.2). `tar` keeps the modes and stores a symlink as a link; `archive.ts` refuses links and `..` on extract |

## Consequences

- Fewer dependencies; behaviour of the gates is plain TypeScript in `scripts/`, tested by `bun test`.
- Own scripts must be maintained: each has unit tests and a deliberate-violation proof.
- When Bun gains a feature that a tool in the table provides, replace the tool and update this ADR.
