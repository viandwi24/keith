# P1 — M0 "Repo foundation"

Oct 26, 2026 · plan for milestone M0 of `P0-mvp.md` · status: **done** (Oct 26, 2026)

## Goal and limits

M0 is done when the local repo `keith` has the full monorepo skeleton (every app and package from the P0 layout, still empty) and all machine gates are installed. The evidence: `bun run check` green from a clean clone, and the `ci.yml` workflow green when run locally with `act`.

The GitHub repo `viandwi24/keith` is **not touched** in M0. All work is committed locally on `main` with no remote and no push. The first push, and the "CI green on GitHub" gate, wait for viandwi24 to clean that repo.

Not in M0: any feature logic, DB schema, routes other than `/health`, eharness adapters, oRPC, `.claude/skills/*`, `plugins/web-ui` (folder prepared only), `release.yml`.

## Decisions (Oct 26, 2026)

| Topic | Decision | Basis |
| --- | --- | --- |
| Name | The product, repo, package scope, env vars and data files use **Keith**: `@keith/*`, `KEITH_*`, `data/keith.db`, `~/.keith/`. No other product or character name is used | viandwi24 |
| Repo | Local only: commit on `main`, no remote, no push. `viandwi24/keith` (public, holds the old prototype) is left as it is | viandwi24 |
| License | MIT | viandwi24 |
| Monorepo | **Bun workspaces only, no Turborepo** (ADR-0005) | CTO, see reasoning below |
| `apps/tui` | `bun init -y` + `bun add ink react` (not create-ink-app, because its template is Ink 4 and React 18) | viandwi24, on recommendation |
| Entrypoint | `src/main.ts` in `apps/core` and `apps/node`; `src/cli.tsx` in `apps/tui`; `index.ts` only for the public API of packages and modules | viandwi24 |
| Secret scanning | Local gitleaks `pre-commit` hook + a gitleaks job in CI; GitHub push protection is enabled when the repo is pushed later | viandwi24 |
| Keith API contract | **oRPC 1.16.1, contract-first** (ADR-0003) | CTO |
| `.ref/` | The script `bun run ref:sync` clones `eharness` at the same tag as the version in the catalog | CTO |

**Why no Turborepo.** Almost everything Keith needs is already provided by Bun workspaces:

| Need | Bun 1.4.2 | What Turborepo adds |
| --- | --- | --- |
| Install, `workspace:*` links, one lockfile | `bun install` | — |
| One dependency version across the repo | `workspaces.catalog` + `catalog:` | — |
| Run a script in all packages in dependency order | `bun run --filter '*' <script>` (tried: `@k/a` runs before `@k/b`) | A task graph across root and packages |
| Run `core`, `node`, `tui` together | `bun run --filter` / `--parallel` | A TUI UI |
| Test only what is affected | `bun test --changed=<ref>` | `--affected` per package |
| Ban imports between layers | — | `turbo boundaries` (Experimental). Dependency-cruiser already enforces every P0 rule, including undeclared dependencies (`no-non-package-json`) |
| Task result cache | — | This is the only real advantage |

A cache only pays off once typecheck and tests are slow. `tsc` 7 runs natively, and this repo only holds empty packages so far. On the other hand, create-turbo brings two Next.js apps, ESLint and Prettier that are thrown away immediately, plus an agent block that is rewritten automatically into `AGENTS.md`. So one tool and one concept fewer. This decision is easy to reverse, because the `apps/*` + `packages/*` layout is identical: only `bun add -d turbo` and one `turbo.json`. The trigger to add it (recorded in ADR-0005): `bun run check` on a dev machine passes 2 minutes, or CI passes 5 minutes.

**Why oRPC.** Keith will have many equal clients (TUI, web UI, display nodes, plugins) that only talk through `packages/client`. oRPC lets the contract be written once in `packages/contracts` (`@orpc/contract` + zod); the server implements it and the client gets types directly with no codegen. Hono zod-openapi like `examples/team` ties the contract to server routes, so the client must be generated from `openapi.json`. OpenAPI for outside parties is still available through `@orpc/openapi`. oRPC is mounted on Hono at `/rpc/*`; the chat route stays `eharness/http`. The packages are installed in M1.

## Research before writing the plan

Every generator was run once in the scratchpad (not in the repo) on Oct 26, 2026 to see its real output. Environment: Bun 1.4.2, Node 26.11.1, git 2.54, Docker available, Homebrew available.

| Tool | Version used | Checked through | Finding that affects the plan |
| --- | --- | --- | --- |
| bun init | 1.4.2 | `--help`, trial at the root and in a package | `-y` creates `index.ts`, `tsconfig.json` (bundler, strict, `noUncheckedIndexedAccess`), `README.md`, a generic Bun `CLAUDE.md`, and `.gitignore` if absent. **An existing `.gitignore` is not overwritten.** At the root it also installs `@types/bun` and `typescript` 7.0.2. Inside a workspace, there is still one lockfile at the root |
| bun run / bun test | 1.4.2 | `--help`, trial | `--filter '*'` and `--workspaces` run a script per package in dependency order, and the exit code of a failing package is passed on (tried: `exit 3` → exit 3). `bun test --changed=<ref>`, `--path-ignore-patterns`, `--pass-with-no-tests` are available. A package without tests → exit 1 without that flag |
| bun pm pkg | 1.4.2 | trial | `set --json 'workspaces={…}'` can write `packages` + `catalog` |
| @biomejs/biome | 2.6.3 | `init --help`, trial | `init` writes a default `biome.json` (tabs, double quotes); changed to the eharness style |
| create-hono | 0.19.5 (hono 4.13.14) | `--help`, trial | Without `--install` it asks interactively and fails in a non-TTY shell. With `--install`, install runs from the workspace root. Result: `src/index.ts`, `tsconfig.json` with `hono/jsx`, package name `core` |
| create-ink-app | 3.0.2 | `--help`, trial | Not used: Ink 4 template, React 18, meow, ava, xo, prettier; its `npm install` fails in a Bun workspace |
| ink / react / ink-testing-library | 8.0.0 / 19.3.1 / 4.0.0 | `npm view`, `examples/coder` | `examples/coder` uses ink 8.0.0 + react 19.3.0 + ink-testing-library 4.0.0 |
| @changesets/cli | 3.0.3 | `--help`, `init --help`, trial | `init` has no flags; it asks "GitHub integration for changelogs?" and needs a TTY |
| dependency-cruiser | 18.7.0 | `--help`, trial | `--init oneshot` is non-interactive, writes `.dependency-cruiser.js` with 11 default rules (`no-circular`, `no-orphans`, `no-non-package-json`, …) |
| commitlint | @commitlint/cli + config-conventional 21.2.4 | official README | No generator; the config is `commitlint.config.js` |
| TypeScript | 7.0.2 (native `tsc`) | `npm view`, `tsc --version` | Same as eharness |
| eharness / ai / zod | 0.9.0 / 7.0.153 / 4.6.7 | `npm view`, GitHub release `eharness@0.9.0` (2026-10-26) | Peers unchanged from 0.8.0: `ai ^7.0.137`, `zod ^3.25.76 \|\| ^4.1.8`, `@ai-sdk/mcp ^2.0.73` (optional). New subpaths: `identity`, `scheduler`, `limits`, `handoff`, `channels`, `clock`, `browser`, `code` (Draft). `group`, `guard`, `openapi` are deprecated (ADR-0062), Keith does not use them. The reference CI and configs (biome, tsconfig, changesets) have no relevant changes; eharness' `ci.yml` now uses `bun test ./src`, because a word without `./` is read as a name filter |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | `npm view`, `examples/team/server` | Same as examples/team |
| @types/bun | 1.4.4 | `npm view` | |
| @orpc/* | 1.16.1 | `npm view` | Installed in M1 |
| gitleaks / gitleaks-action | v8.30.1 / v3.0.0 `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` | GitHub releases API, action README | CLI via `brew install gitleaks`. The action is free without `GITLEAKS_LICENSE` for personal accounts |
| act / actionlint | v0.2.89 / v1.7.12 | GitHub releases API | `act` runs GitHub Actions workflows in local Docker; `actionlint` validates workflow YAML. Both via `brew` |
| actions/checkout | v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1` | GitHub releases API | Pinned by SHA like eharness' CI |
| oven-sh/setup-bun | v2.2.0 `0c5077e51419868618aeaa5fe8019c62421857d6` | GitHub releases API | |

Pattern references from `.ref/eharness` (tag `eharness@0.9.0`): root `biome.json`, root `tsconfig.json` (examples extend the root tsconfig, the same pattern Keith uses), `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.changeset/config.json`, `scripts/exports-snapshot.ts`, `examples/team/server/{package.json,drizzle.config.ts}`, `examples/coder/{package.json,tsconfig.json}`.

Note on differences from the reference: `examples/team` runs migrations at boot, while P0 asks for a separate `bun run db:migrate`. Keith follows P0.

## Execution rules

- All commands run from the repo root unless stated otherwise. Versions are pinned exactly (`--exact`) per the research table.
- Generator output files **may be edited** (for example `tsconfig.json` or `biome.json` options), but must not be re-created by hand. `package.json` changes go through `bun add`, `bun remove` and `bun pm pkg set|delete`.
- One step = one Conventional Commits commit. **No `git remote add` and no `git push`** in M0.
- If a generator's output differs from what is recorded here, stop and note it in "Execution notes" before continuing.

## Prerequisites

```bash
brew install gitleaks act actionlint
```

These three tools are installed on viandwi24's machine (not repo dependencies), so approval is needed before running.

## Steps

### 0. Local git

```bash
git init -b main
git status --short      # only .gitignore and docs/; .ref/ must not appear
git add -A
git commit -m "docs: add mvp design and m0 plan"
```

### 1. Root workspace

```bash
bun init -y
rm index.ts CLAUDE.md                  # CLAUDE.md is rewritten in step 11 with @AGENTS.md
bun pm pkg set name=keith private=true license=MIT
bun pm pkg delete module
bun pm pkg set --json 'workspaces={"packages":["apps/*","packages/*","plugins/*"],"catalog":{"zod":"4.6.7","ai":"7.0.153","eharness":"0.9.0","typescript":"7.0.2","@types/bun":"1.4.4","hono":"4.13.14","ink":"8.0.0","react":"19.3.1","@types/react":"19.3.0","ink-testing-library":"4.0.0","drizzle-orm":"0.45.4","drizzle-kit":"0.31.11"}}'
bun pm pkg set --json 'engines={"bun":">=1.4.2"}'
bun pm pkg set packageManager=bun@1.4.2
```

Edits to the generator output:

- `.gitignore`: add `node_modules/`, `data/`, `.env*`, `!.env.example`, `coverage/`, `*.tsbuildinfo`, `.DS_Store` (`.ref/` is already there and is not overwritten by `bun init`).
- The root `tsconfig.json` becomes the **base** for all packages (replacing `packages/config` from P0, because one file does not need its own package): add `exactOptionalPropertyTypes`, change `lib/target` to `ES2023`, remove `jsx` and `allowJs`, `include: ["scripts"]`, `exclude: [".ref", "data", "node_modules"]`. Packages extend `../../tsconfig.json` then write their own `include`, the same as the eharness examples.

Commit: `build: init bun workspace root`

### 2. License and secret guard

- `LICENSE`: standard MIT text, `Copyright (c) 2026 viandwi24`.
- `.gitleaks.toml`: `[extend] useDefault = true`, allowlist only `.env.example` and `**/fixtures/**`.
- `.githooks/pre-commit`: `gitleaks git --staged --redact --no-banner`. If `gitleaks` is not installed, the hook fails with the message `brew install gitleaks`, instead of being silently skipped.
- `bun pm pkg set scripts.prepare="git config core.hooksPath .githooks"` so `bun install` activates the hook.
- `SECURITY.md`: how to report a vulnerability and the procedure if a secret leaks (revoke the key at the provider first, then clean the history).

Commit: `chore(repo): add mit license and secret scanning hook`

### 3. Biome

```bash
bun add -d --exact @biomejs/biome@2.6.3
bunx biome init
```

Edit `biome.json`: eharness-style format (2 spaces, `lineWidth 100`, single quotes, `semicolons: asNeeded`); `files.includes` excludes `!!.ref`, `!!data`, `!!**/drizzle`, `!.changeset/*.md`, `!scripts/exports.snapshot.json`. Rules on top of `recommended`: `suspicious/noExplicitAny`, `correctness/noUnusedImports`, `style/useImportType`, `suspicious/noConsole` (all `error`), with `overrides` that allow `console` only in `apps/*/src/platform/logger.ts` and `scripts/**`. The rule "request/response types only from contracts" cannot be expressed exactly in Biome, so it is enforced by dependency-cruiser + review.

Commit: `build: add biome`

### 4. `apps/core`

```bash
bun create hono@0.19.5 apps/core --template bun --pm bun --install
cd apps/core
rm -f .gitignore
bun pm pkg set name=@keith/core private=true
mv src/index.ts src/main.ts
bun pm pkg set scripts.dev="bun run --hot src/main.ts" scripts.start="bun src/main.ts" scripts.check-types="tsc --noEmit" scripts.test="bun test"
bun add --exact eharness@0.9.0 ai@7.0.153 zod@4.6.7 hono@4.13.14
bun add -d --exact @types/bun@1.4.4 typescript@7.0.2
bun pm pkg set dependencies.eharness=catalog: dependencies.ai=catalog: dependencies.zod=catalog: dependencies.hono=catalog: devDependencies.@types/bun=catalog: devDependencies.typescript=catalog:
cd ../..
bun install
```

Edit `apps/core/tsconfig.json`: `extends: "../../tsconfig.json"`, `include: ["src"]`, drop `hono/jsx`.

M0 code written by hand (it has no generator):

- `src/platform/config.ts`: a zod schema for `KEITH_DATA_DIR` (default `./data`), `KEITH_PORT` (default 7420), `KEITH_LOG_LEVEL`. The only place that reads `process.env`. Its test is `config.test.ts`.
- `src/main.ts`: only parses the config then `export default { port, fetch: app.fetch }`. The default `GET /` route is replaced by `GET /health` → `{ status: 'ok' }` with a test. Version + SHA follow in M1.
- `src/modules/README.md`: one paragraph of module rules.
- `.env.example` at the root with the three variables above.

Commit: `build(core): scaffold core with create-hono and add eharness`

### 5. `apps/tui`

The create-ink-app 3.0.2 template is still Ink 4 and React 18 and almost all of it would be thrown away, so the TUI uses the Bun generator and then adds Ink like `examples/coder`. This deviation from the P0 table is recorded in ADR-0005.

```bash
mkdir apps/tui && cd apps/tui && bun init -y
rm CLAUDE.md .gitignore
mkdir src && mv index.ts src/cli.tsx
bun pm pkg set name=@keith/tui scripts.start="bun src/cli.tsx" scripts.dev="bun --watch src/cli.tsx" scripts.check-types="tsc --noEmit" scripts.test="bun test"
bun pm pkg delete module peerDependencies
bun add --exact ink@8.0.0 react@19.3.1
bun add -d --exact @types/react@19.3.0 ink-testing-library@4.0.0 @types/bun@1.4.4 typescript@7.0.2
```

After that: dependencies pointed to `catalog:`, `tsconfig.json` `extends: "../../tsconfig.json"` + `jsx: react-jsx` + `include: ["src"]`, `src/cli.tsx` renders an `<App />` that only shows "KEITH", `src/app.test.tsx` uses `ink-testing-library`, an empty `src/features/` folder.

Commit: `build(tui): scaffold ink tui with bun init`

### 6. `apps/node` and `packages/*`

For each of `apps/node`, `packages/contracts`, `packages/db`, `packages/eh-ext`, `packages/host`, `packages/client`:

```bash
mkdir -p <dir> && cd <dir> && bun init -y
rm CLAUDE.md .gitignore
mkdir src && mv index.ts src/index.ts
bun pm pkg set name=@keith/<x> exports=./src/index.ts scripts.check-types="tsc --noEmit" scripts.test="bun test --pass-with-no-tests"
bun pm pkg delete module peerDependencies
bun add -d --exact @types/bun@1.4.4 typescript@7.0.2      # then → catalog:
```

The `tsconfig.json` from `bun init` is edited to `extends: "../../tsconfig.json"` + `include: ["src"]`. Packages export `.ts` directly (just-in-time). `--pass-with-no-tests` is only for empty packages and is removed as soon as the first test exists.

Extra per package:

- `packages/contracts`: `bun add --exact zod@4.6.7` → `catalog:`.
- `packages/db`: `bun add --exact drizzle-orm@0.45.4` and `bun add -d --exact drizzle-kit@0.31.11` → `catalog:`. `drizzle.config.ts` is deferred to M1 when the first schema exists.
- `apps/node`: `src/main.ts` instead of `index.ts`, no `exports`, `scripts.start="bun src/main.ts"`.
- `plugins/README.md`: one paragraph. A plugin = a big feature, may import only `@keith/host` and `@keith/contracts`; `web-ui` follows.

Commit: `build: scaffold node app and internal packages with bun init`

### 7. Changesets

```bash
bun add -d --exact @changesets/cli@3.0.3
bunx changeset init        # interactive: answer "No" for GitHub integration (nothing is published)
```

Edit `.changeset/config.json`: `baseBranch: "main"`, `access: "restricted"`, `privatePackages: { "version": true, "tag": false }`, `commit: false`. Every package `package.json` is already `private: true`.

Commit: `build: init changesets for private packages`

### 8. dependency-cruiser

```bash
bun add -d --exact dependency-cruiser@18.7.0
bunx depcruise --init oneshot
```

Edit `.dependency-cruiser.js`: extra rules in the "Files without a generator" section; options `doNotFollow: node_modules`, `exclude: ^(\.ref|data|node_modules)`, `tsConfig: { fileName: "tsconfig.json" }`, `combinedDependencies: true`. `no-orphans` gets exceptions for `main.ts`, `cli.tsx`, `*.test.ts(x)`, `scripts/*`, `*.config.*`. `no-circular` and `no-non-package-json` are raised to `error`.

Commit: `build: add dependency-cruiser boundaries`

### 9. commitlint

```bash
bun add -d --exact @commitlint/cli@21.2.4 @commitlint/config-conventional@21.2.4
```

`commitlint.config.js` is written by hand (per the commitlint docs): `extends: ['@commitlint/config-conventional']` + a `scope-enum` containing `core node tui contracts db eh-ext host client deps ci repo` and the region names (`thalamus wernicke-broca cortex motor amygdala ras hippocampus tasks nodes brain-events auth`). A local hook `.githooks/commit-msg` (`bunx commitlint --edit "$1"`), activated through `prepare` from step 2.

Commit: `build: enforce conventional commits with commitlint`

### 10. Internal scripts

Written by hand in `scripts/`, each with a test next to it:

- `check-size.ts`: `git ls-files` for `*.ts *.tsx *.js *.mjs`, excluding `bun.lock`, `**/drizzle/**`, `*.snapshot.json`, and files with an `// @generated` comment. More than 400 lines → warning; more than 800 → exit 1.
- `check-exports.ts`: an adaptation of eharness' `scripts/exports-snapshot.ts` (MIT, source noted in the first-line comment). For every workspace package that has `exports`, import its entry and compare the runtime export names with `scripts/exports.snapshot.json`; `--write` rewrites the snapshot. A public API change becomes a visible diff at review.
- `ref-sync.ts`: read the `eharness` version from `workspaces.catalog`, then `git clone --depth 1 --branch eharness@<version>` into `.ref/eharness`, or fetch + checkout that tag if the folder already exists. Refuses to run if `.ref/` is not in `.gitignore`.
- `check-size.test.ts`, `check-exports.test.ts`, `ref-sync.test.ts` (fixtures in a temp folder, no network).

Root scripts (through `bun pm pkg set`), see "Contents of `bun run check`".

Commit: `build: add check scripts and ref sync`

### 11. Documents and config without a generator

See the next table. Commits: `docs: add agents map, architecture and adr 0001-0005`, then `chore(repo): add agent hooks and github templates`.

### 12. CI (local)

Write `.github/workflows/ci.yml` and `.github/dependabot.yml`, then:

```bash
actionlint
act push -j check --container-architecture linux/amd64
gitleaks git --redact --no-banner        # the whole local history
```

Commit: `ci: add check and secrets workflow`

When the repo is pushed later (outside M0, after viandwi24 cleans `viandwi24/keith`): `git remote add origin`, push, then viandwi24 enables Secret Protection + Push protection and Dependabot alerts in Settings → Advanced Security.

## Files without a generator

| File | Outline of content |
| --- | --- |
| `AGENTS.md` | The P0 "`AGENTS.md` template", ±100 lines: map, commands (`bun install · bun run dev · bun run check · bun run db:migrate · bun run ref:sync · bunx changeset`), 8 hard rules (rule 6 = official generator after reading the docs), initial gotchas |
| `CLAUDE.md` | One line: `@AGENTS.md` |
| `apps/*/AGENTS.md`, `packages/*/AGENTS.md` | 5–15 lines: the package's purpose, who may import it, local commands |
| `docs/ARCHITECTURE.md` | Map of brain region → technical term → module folder → eharness part (from P0 "Brain events" and "Two agents"); a text diagram Thalamus → front → Cortex → Motor → node; dependency rules between layers |
| `docs/decisions/0001-branch-license-visibility.md` | Branch model A, Changesets `privatePackages`, MIT, public repo `viandwi24/keith`, local work until the old repo is cleaned |
| `docs/decisions/0002-separate-repo-on-eharness-090.md` | Separate repo, `eharness@0.9.0` exact from npm, no upstream, gaps go to `packages/eh-ext` |
| `docs/decisions/0003-plugin-layers-and-api-contract.md` | Host plugins wrap eharness plugins; chat via `eharness/http`; Keith contract is contract-first oRPC with its reasoning; layout deviations (`plugins/`, wire types outside contracts) |
| `docs/decisions/0004-neurological-naming.md` | Region names as module names, map in `ARCHITECTURE.md` |
| `docs/decisions/0005-bun-workspaces-without-turborepo.md` | Reasoning from the Decisions section, the trigger to add Turborepo, the root `tsconfig.json` replacing `packages/config`, the TUI from `bun init` not create-ink-app |
| `docs/decisions/README.md` | ADR format (Status, Context, Decision, Consequences) |
| `docs/specs/README.md`, `docs/plans/done/.gitkeep` | Per-module spec convention; the plan archive folder |
| `.dependency-cruiser.js` (extra rules) | `packages-not-apps`, `db-only-from-core`, `tui-only-client-contracts` (apps/tui only `@keith/client`, `@keith/contracts`, ink, react), `module-public-api` (`apps/core/src/modules/<a>/**` → `modules/<b>/` only through `index.ts`), `plugins-only-host-contracts`, `no-import-outside-package` (relative paths leaving the package folder) |
| `commitlint.config.js`, `.githooks/commit-msg` | See step 9 |
| `LICENSE`, `.gitleaks.toml`, `.githooks/pre-commit`, `SECURITY.md` | See step 2 |
| `scripts/*.ts` (+ tests, snapshot) | See step 10 |
| `.claude/settings.json` + `.claude/hooks/guard.ts` | PostToolUse `Edit\|Write` → `bunx biome check --write <file>`; Stop → `bun run check` must exit 0; PreToolUse `Bash` → reject `git push`, `git push --force`, `git remote add`, `rm -rf` outside `data/`, `git reset --hard`; PreToolUse `Edit\|Write` → reject `bun.lock`, `**/drizzle/**`, `scripts/exports.snapshot.json`. The `git push` ban is lifted when the repo is ready to push |
| `.github/workflows/ci.yml` | See the CI section |
| `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/{bug,feature}.yml`, `.github/CODEOWNERS` | Content from P0 "Repo standard: templates, CI, checklists"; `feature.yml` holds the problem, **who the user is**, alternatives |
| `.github/dependabot.yml` | eharness pattern: `github-actions` and `bun` weekly, dev-deps minor/patch grouped, **`eharness` fully ignored**, `ai`/`zod` majors ignored. Active only after the push |
| `.env.example` | `KEITH_DATA_DIR=./data`, `KEITH_PORT=7420`, `KEITH_LOG_LEVEL=info` |
| Root `README.md` (from `bun init`) | Replaced by 10 lines: what Keith is, `bun install && bun run check`, a link to `AGENTS.md` |

Initial gotchas for `AGENTS.md`:

- The npm package `eharness` contains only `dist`; specs and examples are in `.ref/eharness`. Not there yet? `bun run ref:sync`.
- `run_in_background` is only available in root sessions (the front session).
- `bun init` creates a `CLAUDE.md` per folder; delete it, agent rules live only in `AGENTS.md`.
- A new package without tests uses `bun test --pass-with-no-tests`; remove that flag when the first test is written.
- The `pre-commit` hook needs `gitleaks` (`brew install gitleaks`).
- `bun test` from the root must ignore `.ref/` (`--path-ignore-patterns`), otherwise thousands of eharness tests run too.

## Contents of `bun run check`

One command, the same locally and in CI. Root scripts:

| Script | Command |
| --- | --- |
| `lint` | `biome check .` |
| `check-types` | `bun run --filter '*' check-types && tsc --noEmit -p .` (packages + `scripts/`) |
| `test` | `bun test --path-ignore-patterns='.ref/**'` |
| `test:changed` | `bun test --path-ignore-patterns='.ref/**' --changed=origin/main` (for PRs, once a remote exists) |
| `depcruise` | `depcruise apps packages plugins scripts --config .dependency-cruiser.js` |
| `check-size` | `bun scripts/check-size.ts` |
| `check-exports` | `bun scripts/check-exports.ts` |
| `ref:sync` | `bun scripts/ref-sync.ts` |
| `dev` | `bun run --filter '@keith/core' --filter '@keith/node' --filter '@keith/tui' dev` |
| **`check`** | `bun run lint && bun run check-types && bun run test && bun run depcruise && bun run check-size && bun run check-exports` |

The order goes from the fastest to fail. `bun test` runs once from the root, not per package, so there is one process and one report. The per-package `test` scripts still exist for local work in one folder. Commitlint is not part of `check` because it needs a commit message; it runs in the local hook and in CI. `build` does not exist yet in M0 (no artifacts).

## `.github/workflows/ci.yml`

Based on P0, with actions pinned by SHA like eharness. In M0 this workflow is run through `act`; its content is already ready for GitHub.

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with: { bun-version-file: package.json }   # reads packageManager
      - run: bun install --frozen-lockfile
      - name: PR title (Conventional Commits)
        if: github.event_name == 'pull_request'
        env: { TITLE: "${{ github.event.pull_request.title }}" }
        run: echo "$TITLE" | bunx commitlint
      - name: Pushed commits (Conventional Commits)
        if: github.event_name == 'push' && github.event.before != '0000000000000000000000000000000000000000'
        env: { FROM: "${{ github.event.before }}", TO: "${{ github.sha }}" }
        run: bunx commitlint --from "$FROM" --to "$TO"
      - run: bun run check

  secrets:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: write   # comment findings on the PR
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # personal account: no GITLEAKS_LICENSE
```

Model A allows direct push to `main`, so pushed commits are also checked by commitlint, not only PR titles. `.ref/` does not exist in CI, and no check depends on it. In `act`, only the `check` job runs; the `secrets` job is replaced by a local `gitleaks git` because the action needs a GitHub token.

Secret layers: the `pre-commit` hook rejects before a commit is formed, the `secrets` job catches what slips through (for example commits from a machine without the hook), and GitHub push protection rejects at push time once the repo is online.

## M0 gate evidence

The plan counts as passed when all of this evidence is attached to the execution report:

1. The output of `bun run check`, exit 0, from a clean local clone (`git clone <the repo folder> <tmp>` → `bun install --frozen-lockfile` → `bun run check`).
2. `git status` stays clean in that clone after `bun install` (the lockfile does not change).
3. The output of `actionlint` with no findings and `act push -j check` green, as a replacement for GitHub CI until the repo is pushed.
4. The output of `gitleaks git` with no findings for the whole local history.
5. Proof that each gate really rejects a violation. Run on a temporary local branch, then the branch is deleted:

| Deliberate violation | Gate that must fail |
| --- | --- |
| An 801-line file in `packages/contracts/src` | `check-size` |
| `apps/tui` imports `@keith/core` | dependency-cruiser (`tui-only-client-contracts`) |
| `packages/contracts` imports `../../apps/core/src/main.ts` | dependency-cruiser (`packages-not-apps`, `no-import-outside-package`) |
| `packages/host` imports `zod` without declaring it | dependency-cruiser (`no-non-package-json`) |
| Two files import each other | `no-circular` |
| `const x: any` | Biome |
| `arr[0].foo` without a check | `tsc` (`noUncheckedIndexedAccess`) |
| A new export in `packages/contracts/src/index.ts` without `--write` | `check-exports` |
| Commit message `update stuff` | commitlint (`commit-msg` hook) |
| A file containing an AWS-format example key from the official documentation | gitleaks (`pre-commit` hook) |

The P0 gate "check green on GitHub CI" is met later, on the first push to the cleaned repo.

After it passes: the plan moves to `docs/plans/done/P1-m0-foundation.md`, and new gotchas from execution are recorded in `AGENTS.md`.

## Risks

| Risk | Handling |
| --- | --- |
| `act` is not 100% the same as the GitHub runner (different image) | Use the image `catthehacker/ubuntu:act-latest` (default medium); differences are noted in "Execution notes"; final certainty comes at the first push |
| `bun-version-file: package.json` does not read `packageManager` | Fallback `bun-version: 1.4.2` |
| Bun's isolated linker hides transitive types (eharness itself uses `linker = "hoisted"`) | Isolated by default first; if `check-types` fails because of transitive types, add `bunfig.toml` `[install] linker = "hoisted"` and note it in gotchas |
| `bunx changeset init` needs a TTY | Run in an interactive terminal; if the agent has no TTY, viandwi24 runs it himself |
| Without Turborepo's cache, `check` slows down as the repo grows | The trigger in ADR-0005 (more than 2 minutes locally or 5 minutes in CI) → add Turborepo |

## Execution notes

Executed Oct 26, 2026. Output that differed from the plan, and how it was handled:

| Step | Finding | Handling |
| --- | --- | --- |
| 1 | `bun init` at the root wrote `@types/bun: "latest"` and `peerDependencies.typescript: "^7"` | Both pointed to `catalog:` as a devDependency, `peerDependencies` removed |
| 1 | `bun pm pkg set private=true` wrote the string `"true"` | Use `bun pm pkg set --json private=true` |
| 3 | Biome 2.6 also formats Markdown, which widened the docs tables | `files.includes` uses `!**/*.md` (replacing `!.changeset/*.md`) |
| 4 | create-hono does not write `type: module` and `private` | Added through `bun pm pkg set` |
| 4 | The route in `main.ts` cannot be tested without starting the server | `src/app.ts` (`createApp`) holds the route + test; `main.ts` is only wiring |
| 7 | `changeset init` asks four things (GitHub integration, auto-commit, public/private, base branch) and needs a TTY | Run through `expect` with the default answers: No, No, Private, `main`. The result already has `access: restricted`, `commit: false`; only `privatePackages` was added |
| 8 | `depcruise --init` wrote `.dependency-cruiser.cjs` (not `.js`) because the root is `type: module` | The file name follows the generator; the `depcruise` script uses `.cjs` |
| 8 | dependency-cruiser 18.7 cannot use the `typescript@7` API yet (support is `>=2 <7`): 0 modules read | `parser: 'swc'` with `@swc/core` 1.16.20 (root devDependency). The `missing-tsc-transpiler` warning is still printed, noted in gotchas |
| 8 | The `tsConfig` option (root tsconfig `include: scripts`) and `exclude: node_modules` made npm packages unresolvable | Both removed; `doNotFollow: node_modules` is enough, Keith uses no path aliases |
| 8 | With the isolated linker, undeclared dependencies do not resolve at all, so they are caught by `not-to-unresolvable`, not `no-non-package-json` | Still fails in `check`; the evidence table below records the rule that actually rejects |
| 10 | The 456-line generated `.dependency-cruiser.cjs` triggered a `check-size` warning | Excluded in `check-size.ts` as generator output |
| 11 | Agent hook logic is safer if it is also typechecked and tested | `scripts/agent-guard.ts` (+ test) replaces `.claude/hooks/guard.ts`. Additions: block `--no-verify`; `rm -rf` allowed in `data/` and temp folders; paths that are variables are also blocked because they cannot be evaluated |
| 11 | The hook became active immediately in the running agent session (it blocked an `echo` containing the text "git push") | As expected; the test uses concatenated strings |
| 11 | One commit slipped through with a red `check` because the commit command was not chained with `&&` to `check` | Fixed in the commit `style: format agent guard and hook settings`; the Stop hook now prevents the agent from finishing with a red `check` |
| 12 | `act` looks for `/var/run/docker.sock`, while Docker on this machine goes through OrbStack | `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock act … --container-daemon-socket -` |
| Evidence 5 | The AWS example key from the official docs (`…EXAMPLE`) is in gitleaks' default allowlist, so it passed | The test uses a random AWS-format key; the hook rejects it (`leaks found: 2`) |

### Gate results

| Evidence | Result |
| --- | --- |
| 1. `bun run check` from a clean clone | Exit 0: Biome 47 files, `tsc` 8 packages + `scripts`, 19 tests passed, dependency-cruiser 39 modules with no violations, check-size and check-exports ok |
| 2. `git status` after `bun install --frozen-lockfile` | Clean |
| 3. `actionlint` / `act push -j check` | actionlint with no findings. act (`catthehacker/ubuntu:act-latest`, linux/amd64): every step of the job green — checkout, setup-bun, `bun install --frozen-lockfile` (36 s), commitlint of the pushed commits, `bun run check` (10 s, 19 tests). Only the *post* step of setup-bun (cache-save) failed: `node` is not on the container PATH during the post step, although the main step of the same action runs with `node`. This is an `act` environment issue, not the workflow; to be confirmed again on the GitHub runner at the first push |
| 4. `gitleaks git` whole history | 15 commits, `no leaks found` |

Deliberate violations (in a clean clone, branch `tmp/violations`, then deleted):

| Violation | Rejected by |
| --- | --- |
| An 801-line file | `check-size` (`801 lines (max 800)`) |
| `apps/tui` imports `@keith/db` (declared) | `tui-only-client-contracts` + `db-only-from-core` |
| `apps/tui` imports `@keith/core` | `not-to-unresolvable` (core has no `exports`) |
| `packages/contracts` → `../../../apps/core/src/app.ts` | `packages-not-apps` + `no-import-outside-package` |
| `packages/host` imports `zod` without declaring it | `not-to-unresolvable` |
| `a.ts` ↔ `b.ts` | `no-circular` |
| `const x: any` | Biome `noExplicitAny` |
| `arr[0].foo` | `tsc` TS2532 (`noUncheckedIndexedAccess`) |
| A new export without `--write` | `check-exports` (`export snapshot mismatch`) |
| Commit `update stuff` | `commit-msg` hook (commitlint) |
| A random AWS-format key | `pre-commit` hook (gitleaks) |
| Extra: module `cortex` → `motor/internal.ts` | `module-public-api` (while `cortex` → `motor/index.ts` passes) |
| Extra: plugin → `packages/db` | `plugins-only-host-contracts` + `no-import-outside-package` |

## [DECIDE]

Nothing is left. Every question was answered in the Decisions section.

## After M0 (Oct 26, 2026)

On viandwi24's direction ("Bun first"), dependency-cruiser and `@swc/core` were replaced by `scripts/check-imports.ts`, which uses Bun's built-in parser and resolver (`Bun.Transpiler.scanImports`, `Bun.resolveSync`). The principle and the audit of all tools are recorded in ADR-0006. `bun audit --audit-level=high` entered CI. All the violations above were repeated and are still rejected, plus two cases that used to slip through: type-only imports across boundaries, and dev dependencies in non-test code. `act`: every step green, including `bun audit`; the post step of setup-bun still fails because of the `act` environment.
