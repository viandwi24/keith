# apps/tui

Ink terminal client, the `keith` command (`home` by default, `chat`, `manage`, `login`, `logout`, `whoami`). Entry `src/cli.tsx` (a `@keith/cli` program built in `src/commands.tsx`), root component `src/app.tsx`. Settings live in `keith-core`, never here; fixed texts are in `src/messages.ts`; `src/login-view.ts` is the text of the script path of `keith login` (signing in itself is the `features/login` screen, ADR-0013). How it looks: `docs/specs/tui-design.md` (the visual contract); what it does: `docs/specs/tui.md`.

- Talks to the core only through `@keith/client`; types from `@keith/contracts`.
- From npm only `ink`, `react` and the chat stack: `@ai-sdk/react` (`useChat`), `ai`,
  `eharness/client(/react)`. Tests and `src/testing/` may also use `ink-testing-library`.
- One folder per screen area in `src/features/` (home, chat, brain, tasks, nodes, approvals, identity, budget, stepup, manage). `manage/` has one subfolder per section (overview, people, devices, nodes, providers, access, budget, audit); each section hook turns the core's answers into rows and actions that call the same `client.rpc.*` procedures as `keith-core`: add no server logic. Pure state lives in `manage-state.ts`, `dialog-state.ts` and `<section>-state.ts` (tested); secrets use hidden `Field`s and are cleared on submit.
- Features draw only through `@keith/ui` (rules in `packages/ui/AGENTS.md`): no colour string, `borderStyle` or `backgroundColor` outside it.
- The env is read only in `src/platform/config.ts` (`KEITH_THEME`, `COLORFGBG`, `COLORTERM`, `TERM`, `NO_COLOR`, `KEITH_CELL_ASPECT`) and passed to `@keith/ui` as options.
- The orb's cell aspect: `cli.tsx` asks the terminal once before Ink starts (`platform/cell-size.ts`: `ESC[16t`, `ESC[14t`, 150 ms, no bytes left for Ink), then `KEITH_CELL_ASPECT`, then 0.46; it travels as the `cellAspect` prop. Tests of the compact chat layout pass `header: false` to `setupApp`.
- Test with the fake core (`src/testing/fake-core.ts`; admin procedures in `fake-admin.ts`, keys in `manage-helpers.ts`): `bun test ./apps/tui/src/<file>` from the repo root, one file at a time.
  Render through `render` from `@keith/ui/testing` / `setupApp` (a terminal size you choose; `ink-testing-library` fixes 100 columns).
  The PTY test (`cli.pty.test.ts`) rebuilds the screen from the output with `testing/vt-screen.ts`: Ink redraws only what changed.
- Terminal input: `platform/terminal-input.ts` wraps `stdin.read` in front of Ink (wheel events, Kitty reply; never an extra `data` listener) and `cli.tsx` switches mouse reporting on and off on every way out; `esc` stops a running turn (chat and Home), idle chat goes Home, `ctrl+g` goes Home at any time; the newline hint comes from `kittyKeys`; a legend never lists `pgup`/`pgdn`.
- Home's orb size depends only on the terminal and the cell aspect: what Home says goes into the 2-row caption slot (`home-caption.ts`), dialogs and the menu are overlays.
