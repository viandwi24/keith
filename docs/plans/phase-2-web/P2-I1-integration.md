---
id: P2-I1
title: "Integration and S-8 end to end in a real browser"
phase: 2
wave: 4
lane: I
status: review
owner: agent-P2-I1
depends: [P2-C1, P2-E1]
owns:
  - tests/e2e/**
  - packages/core/**
  - packages/client/**
  - packages/sdk/**
  - packages/protocol/src/**
  - plugins/web/**
  - plugins/tool-weather/**
  - apps/tui/**
  - scripts/**
  - package.json
  - .github/**
reads:
  - docs/concept/scenarios.md
  - docs/architecture/ui.md
  - docs/plans/phase-2-web.md
updates:
  - docs/architecture/ui.md
  - docs/architecture/overview.md
scenarios: [S-8]
---

# P2-I1: Integration and S-8 end to end

## Goal

S-8 plays out for real: Keith runs with the TUI only, then `@keith/web` is enabled, and a browser shows the same Thread with the weather card rendered, while nothing in the Mind or tool plugins changed.

## Scope

**In:**
- `keith setup` offers to enable `@keith/web` and `@keith/tool-weather`; bootstrap/config wiring as needed.
- `tests/e2e/s8-web.test.ts` with Playwright (Chromium is preinstalled at `/opt/pw-browsers`; read the current Playwright docs for Bun): boot the core with the fake LLM scripted to call `weather.current` (fake `fetch` for the weather plugin), open the built web app, log in, see history from a TUI-driven turn, see the card render, click "Refresh" and see the updated card, and confirm the TUI protocol client received the same text (I-7) and the `fallbackText`.
- CI: build the web app and run the Playwright test.
- Fix integration bugs in owned paths; list every fix with its lane. Contract semantics may not change (blocker + ADR).
- Human run: the coordinator (or the user) runs Keith with the web app against a real model; notes go in Outcome.

**Out:** new features.

## Acceptance criteria

- [x] S-8 e2e passes locally and in CI, 5 runs in a row. (Local: 5/5. CI runs it 5 times in a row; not yet observed on GitHub, since this branch is not pushed.)
- [x] Every fix listed in Outcome.
- [x] No `> Planned (phase 2)` markers left in docs/architecture.
- [x] `bun run check` passes.

## Outcome

S-8 now runs end to end in a real browser. `tests/e2e/s8-web.test.ts` boots the real core with `@keith/web` loaded by package name from config, as `keith start` loads it, plus the real `@keith/tool-weather` with a fake Open-Meteo `fetch` and the scripted fake LLM. A `chat.text@1`-only protocol node plays the TUI and drives a turn in which the model calls `weather.current`. Chromium (Playwright library API) then opens the built app, signs in, and shows the same thread from history: the question, the same reply text (I-7) and the weather card. It clicks **Refresh**, which goes `ui.action` → `onAction` with no model call, and an updated card appears. The test also checks four things. The TUI node got the same `message.completed` text and never a `ui.render`. The browser's `ui.render.fallbackText` equals `uiBlockToText` of the block the TUI got. Empty tool-step rows are hidden. The page has no JS errors.

### Integration fixes (by lane)

| # | Lane | Fix |
|---|---|---|
| 1 | I (bootstrap) | `createThreadManager` now gets `tools` and `services`. Without them every Refresh click turned into the input "(clicked: Refresh)" instead of reaching `onAction` (I checked this: the S-8 test fails without the fix). |
| 2 | I (bootstrap) | `createCoreServer` now gets `filesDir: paths.filesDir`. `/v1/files` answered 404 in a real Keith before this. Covered by `packages/core/test/integration.test.ts`. |
| 3 | I (core deps) | `@keith/core` now depends on `@keith/web` and `@keith/tool-weather` (`bun add @keith/web@workspace:* @keith/tool-weather@workspace:*` in `packages/core`). Under the isolated linker, the plugin host's `import('<id>')` could not resolve them otherwise. Covered by a test that loads both by name. |
| 4 | I (setup) | `keith setup` asks whether to enable `@keith/web` and `@keith/tool-weather` (default yes). They go into `plugins.enabled` but not `required`, and each gets a `[plugins."<id>"]` section with commented hints. When the web app is enabled, setup prints the build command and the URL. On an existing config, it prints how to add whichever is missing. |
| 5 | A (client) / TUI | `isHiddenEntry` moved from the web app into `@keith/client`, and the web app re-exports it. The TUI now uses it too (`entryViews`), so it no longer shows empty "Keith" rows for the tool steps in `thread.opened` history. A TUI message with blocks but no text shows the blocks' fallback text. |
| 6 | C (web app) | Verified, no change needed: `/v1/files/<id>` images are fetched with `Authorization: Bearer` and shown from object URLs (`hooks/use-image-src.ts`, `lib/images.ts`), and empty assistant rows are already skipped. |
| 7 | I (CI) | CI installs Chromium (`bunx playwright install --with-deps chromium`, per playwright.dev/docs/ci), builds the web app (`bun run --cwd plugins/web build`), runs `bun run check`, then runs the S-8 test 5 times in a row. |

### Tests added

- `packages/core/test/integration.test.ts`: the real core with both plugins loaded by name. Checks that `weather.current` is offered to the model; that the static mount of a temp `dist` serves `/`, assets and the SPA fallback for client routes; that `/v1/health` and an unknown `/v1/*` path still answer as the API with JSON; that a missing dist serves the placeholder page while the core keeps running; and that `/v1/files` upload/download works through bootstrap.
- `tests/e2e/s8-web.test.ts` and `tests/e2e/browser.ts`. The test builds the app into a temp dir in a subprocess (Bun.build inside `bun test` from the repo root cannot resolve workspace deps). Playwright is a root devDependency, because `tests/e2e` is not a workspace package. The browser launcher uses Playwright's own Chromium when it is installed (CI), and otherwise falls back to `/opt/pw-browsers/chromium` or `KEITH_E2E_CHROMIUM`, because Playwright 1.63 expects chromium-1243 while the dev container has chromium-1194.
- The harness `e2eConfig` takes `enabled` and `extra` (plugin sections).
- New tests for `isHiddenEntry` (client), TUI `entryViews` and fallback, and the setup questions (`cli.test.ts`, existing answer scripts updated).

Results: `bun run check` passes (903 pass, 3 skip, 0 fail). `tests/e2e/s8-web.test.ts` passed 5 runs in a row locally (about 1.7 s each).

### Docs

- `docs/architecture/ui.md`: ADR-0012 is no longer marked proposed. Added the build command and static serving, `isHiddenEntry` shared through `@keith/client`, a new section on nodes without `ui.render@1` (TUI), and a new section on enabling the web app (S-8).
- `docs/architecture/overview.md`: the `keith setup` row mentions the optional plugins.
- No `> Planned (phase 2)` markers remain in `docs/architecture`.

### For the coordinator (outside `owns`/`updates`)

- `docs/architecture/nodes.md` (Unknown-type row, around line 67) still says "`ui.action` answers this way until phase 2". `ui.action` is handled now (see `ui.md#interactivity`), so that clause should go.
- `docs/architecture/config.md#keith-setup` still says setup "enables only that plugin". It should now say that it also offers `@keith/web` and `@keith/tool-weather` (enabled, not required), and that it prints hints for an existing config.

### Human run (not done here: coordinator or user)

1. `bun install`, then `bun run --cwd plugins/web build`.
2. Use a fresh `KEITH_HOME`: `KEITH_HOME=/tmp/keith-s8 bun packages/core/src/cli/main.ts setup`. Pick the provider, answer **n** to both optional plugins first (terminal only), and create the owner.
3. Export the API key, then run `keith start` and `bun run --cwd apps/tui start` (or `keith-tui`), and ask "What's the weather in Surabaya?". Expected: no weather tool yet, and a plain answer.
4. Stop Keith and add `"@keith/web", "@keith/tool-weather"` to `plugins.enabled`. Running `setup` again prints exactly this hint. Start Keith again and ask the weather question in the TUI. Expected: the text answer, from real Open-Meteo data.
5. Open `http://127.0.0.1:4824/` and sign in. Expected: the same thread, with the weather card under the reply. Click Refresh: an updated card appears in the browser, and its text appears in the TUI.
6. Record the model used, any rough edges, and screenshots here.

