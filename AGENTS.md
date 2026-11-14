# AGENTS.md — keith

Keith: a personal agent harness (core node, peripheral nodes, TUI client) built on eharness.

## Map

| Need | Read |
| --- | --- |
| MVP design and milestones | docs/plans/active/P0-mvp.md |
| Architecture and brain-region names | docs/ARCHITECTURE.md |
| Contract of the module you touch | docs/specs/<module>.md |
| Module contracts (auth, providers, thalamus, …) | docs/specs/ |
| Why a decision was made | docs/decisions/ |
| Active plan | docs/plans/active/ |
| How to use Keith day to day | docs/guide.md |
| How to test Keith by hand | docs/manual-testing.md |
| How to contribute, PR flow, the gate | CONTRIBUTING.md |
| Local rules of an app or package | apps/<x>/AGENTS.md, packages/<x>/AGENTS.md |
| eharness source, specs, examples | .ref/eharness (tag eharness@0.14.1, `bun run ref:sync`) |

| Folder | What lives there |
| --- | --- |
| apps/core | Server: Hono + eharness. Brain regions in src/modules/<region>/, plumbing in src/platform/ |
| apps/node | Peripheral node daemon: pairing, heartbeat, motor executor |
| apps/tui | Ink client: src/features/<feature>/ |
| packages/contracts | Every type that crosses an app boundary (zod) |
| packages/db | Drizzle schema + migrations; only apps/core imports it |
| packages/eh-ext | Local extensions on top of eharness (public API only) |
| packages/ui | Ink theme tokens, components and glyphs shared by the TUI and the core console; rules in its AGENTS.md |
| packages/acl | Resource-level access: pure evaluator, `Membership` and `AclStore` ports, in-memory store, conformance cases (`@keith/acl/testing`); spec docs/specs/acl.md |
| packages/host | Plugin host contract |
| packages/driver-sdk | Driver SDK: `defineDriver`, the `keith-driver.json` schema, `loadDriver`; imports only `@keith/contracts` (docs/specs/node-drivers.md) |
| packages/driver-desktop | First-party `desktop` driver (macOS); scaffold until P31.3; imports only `@keith/driver-sdk` and `@keith/contracts` |
| packages/driver-sandbox | First-party `sandbox` driver (Docker or Podman); scaffold until P31.4; imports only `@keith/driver-sdk` and `@keith/contracts` |
| packages/cli | Shared CLI toolkit: prompts, command registry with `--help`, output helpers |
| packages/client | Typed client for every UI (eharness/client + Keith contract) |
| plugins/ | Big features; import only @keith/host and @keith/contracts |

## Commands

bun install · bun run link (keith-core, keith, keith-node on PATH) · bun run dev · bun run check ·
bun run smoke (real processes, fake provider: setup, start, socket, TUI, device login, node, audit, then a member: password login, isolation,
shell routed to the owner with step-up, brute-force 429, then guest mode: priced guest model, zone rule, public notes only, peek, real `keith --guest`, caps, kill switch, audit row, then backup and restore: `backup` while the core runs, restore into a fresh folder, refusal and `--force`; ~40 s, not in check) ·
bun run manual:setup|manual:core|manual:admin|manual:tui|manual:node (KEITH_HOME=.data/test, docs/manual-testing.md; reset with rm -rf .data/test) · bun run manual:clock <days> (core stopped: moves .data/test timestamps back) ·
bun run ref:sync (`-- --update` accepts a tag moved upstream) · bunx changeset ·
bun run db:migrate · bun run --filter @keith/core token:reset · bun run eval:news (real model,
needs OPENROUTER_API_KEY, costs money; `-- --scripted` is offline; reports in data/evals/) ·
keith-node join --core <url> --code <code> [--allow-shell] · keith-node run (from a checkout: bun apps/node/src/main.ts …)

`bun run check` = Biome · tsc (every package + scripts) · bun test · check-imports ·
check-size · check-exports. CI runs the same command. `bun run format` fixes formatting.

## Hard rules

1. Specs are contracts: change the code → change the spec in the same commit.
2. Shared types come only from packages/contracts.
3. A feature = a folder in modules/ or features/; import other features only through index.ts.
4. apps/tui talks to core only through packages/client.
5. Use eharness as published (0.14.1). No patches to node_modules. A gap that other apps share is
   fixed in eharness and adopted by an upgrade (ADR-0011); Keith-only glue goes to packages/eh-ext.
6. Scaffold with official generators after reading their current docs; never hand-write
   package.json, tsconfig or entrypoints that a generator creates. Change package.json with
   `bun add`, `bun remove` and `bun pm pkg set|delete`.
7. Never edit generated files or lockfiles by hand (bun.lock, **/drizzle/**,
   scripts/exports.snapshot.json — regenerate it with `bun scripts/check-exports.ts --write`).
8. Done = `bun run check` passes + evidence in the report.
9. Dependency versions live in the root `workspaces.catalog`; packages use `catalog:`.
10. Read env only in apps/*/src/platform/config.ts, through a zod schema (`KEITH_*`).
11. Bun first: use a Bun built-in (bun test, bun build, Bun.$, Bun.Glob, Bun.Transpiler,
    bun audit…) before adding a tool. A non-Bun tool needs its reason in ADR-0006.

## Conventions

- Commits: Conventional Commits, scope = app, package or brain region (commitlint.config.js).
- All repo text is English: code, UI strings, commands, docs, plans, changelogs. Keith replies in the owner's language.
- Files kebab-case; tests `<file>.test.ts` next to the code, named by feature.
- Files: warning above 400 lines, failure above 800. Split by responsibility.
- The repo is public at github.com/viandwi24/keith. Work lands on `main`; the owner pushes and reviews outside PRs. Agents never push (the agent guard blocks it).

## Gotchas

- The eharness npm package ships dist only; read docs/specs in .ref/eharness.
- run_in_background is only offered in root sessions (the front session).
- `bun init` writes a CLAUDE.md and .gitignore in every folder; delete them, rules live here.
- A new package without tests uses `bun test --pass-with-no-tests`; drop the flag with the first test.
- The pre-commit hook needs gitleaks (`brew install gitleaks`); it fails instead of skipping.
- Root `bun test` must ignore `.ref/` (`--path-ignore-patterns`) or eharness' own tests run.
- `Bun.Transpiler.scanImports` drops type-only imports; check-imports adds them by pattern.
- `Bun.Glob` does not support nested braces (`{a,{b,c}/*}`); split the pattern.
- Biome 2.6 also formats Markdown; `*.md` is excluded so doc tables stay hand-aligned.
- `bun test src` is a name filter, not a path; write `bun test ./src`.
- Never drive the TUI with `expect … sleep`: sleep stops reading the pty, the ~1 KB macOS buffer fills
  and the app blocks in `write(2)` (looks like frozen timers and sends). Use `Bun.spawn({ terminal })`
  as in `apps/tui/src/cli.pty.test.ts`.
- Ink prints only the last frame when `CI` is set (is-in-ci): PTY tests strip `CI*` from the child env.
  A key written right after a screen renders can be dropped on slow machines: use `pressUntil`.
- The activity feed sends no history: add listeners, then `feed.start()`, refetch state on resync; in
  tests wait for `core.streams() > 0` before `core.emit()`. ink-testing-library is always 100 columns:
  pass `columns` to `App`.
- eharness skips a `turn.prepare` hook that throws (W_HOOK_FAILED); never throw there, return a fallback model.
- A plain model id string as an agent's model goes to the AI Gateway over the network; use a local model object (`unconfiguredModel`) as a placeholder.
- gitleaks flags key-shaped literals even in tests; build fake keys at runtime.
- A turn failure is stored as a separate `eh.notice` message (`data-eh.notice`); UIs must render it.
- Open `agent.session(id)` always with the shared `{ lock }`, else `W_SESSION_OPTIONS_IGNORED`.
- `subagent` offers `send_message` by default: set `messageTool: false` (lead and workers).
- After delegating, `send().result.stop` is `tool-pending`; the lead continues in a `respond` turn.
  A worker report wakes the lead in a turn with `kind: 'wake'`.
- Tests set the inbox `pollMs` to ~20 ms and give scripted models enough steps (park adds a
  continuation and a wake call). To hold a scripted model, wrap `doStream`
  (`apps/core/src/testing/scripted-providers.ts`).
- `Bun.serve` needs both `fetch: core.fetch` and `websocket: core.websocket` (`/nodes/ws`).
- The person is the session principal: open a front session with `frontSessionOptions(id, lock)`
  (`platform/sessions.ts`) so hooks read `ctx.principal`; a session opened without it has none.
- The `tool.approve` hook is re-run on re-validation: decide only from the input and static tables
  (CAPABILITIES); the one live read is the node registry's shell-off check, which can only deny (`docs/specs/motor.md`).
- `Bun.spawn({ detached: true })` starts a new process group; kill trees with `process.kill(-pid)`.
- Shells started by Keith get a minimal env (Config.shellEnv / node PATH, HOME, LANG), never
  process.env.
- RFC or sample key-shaped literals (e.g. Sec-WebSocket-Key) also trip gitleaks; build them at runtime.
- The TUI approval bar takes keys only after Tab, so a chat message never answers an approval.
- `bun test ./apps/...` must run from the repo root.
- Scripts (`scripts/**`) import no workspace package (check-imports): smoke drives core with plain fetch and the real CLIs.
- Smoke reads the TUI through `Bun.stripANSI`: the cursor and the placeholder are drawn with colour codes, so the raw pty bytes never hold "type a message" in one piece. Match on stripped text.
- Smoke: a person's password may not contain their username (no `ana` in a runtime passphrase); `keith whoami` prints the display name, not the username; an owner `token create` credential is cold, so step it up with the PIN (`POST /auth/step-up`) before answering a shell approval over TCP.
