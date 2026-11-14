# packages/ui

Shared Ink look for every terminal front end (`apps/tui`, the `apps/core` console): theme tokens, components, glyphs, text width, markdown. The visual contract is docs/specs/tui-design.md.

- From npm only `ink` and `react`. No workspace imports, no env reads: theme and colour depth are options (`resolveTheme({ theme, depth })`); the app reads `KEITH_THEME`, `COLORFGBG`, `COLORTERM`, `TERM` and `NO_COLOR` in its own config.ts.
- Features and screens draw only through this package (Txt, Surface, Notice, Dialog, Panel, ListRow, ...): never pass a colour string, a `borderStyle` or a `backgroundColor` outside `src/`. Colours are theme tokens (`theme.ts`); in `NO_COLOR` mode (depth `none`) no colour prop is passed at all, so every state needs a glyph or text.
- `src/text-input.tsx` edits a ref, not the rendered value: keys arrive faster than renders.
- Test helpers for any Ink app are in `src/testing/` (`@keith/ui/testing`: `render` with a terminal size you choose, `show` under a theme). Run `bun test ./packages/ui/src/<file>` from the repo root.
- Server text (device labels, person, group and node names, task and guest text) is drawn only through `Txt`, `Message`, `Markdown`, `ListRow` or `Field`: they strip terminal escapes through `src/safe-text.ts` (twin of `packages/cli/src/sanitize.ts`). Never hand a server string to `ink`'s `Text` directly.
- `StyledLines` is the one component that draws colours that did not come from the theme: the runs of a plugin view, already sanitised by `@keith/client`. A feature passes it runs, never a colour of its own.
- `ToastProvider` / `ToastStack` / `useToast`: the top-right toast (tui-design 5.20). The app mounts one provider above its screens; a feature calls `useToast().push(text, { level, ms })`, never draws its own corner message.
- Every top alert, caption alert and toast wraps with `wrapLines` (`src/wrap-lines.ts`): on words, a long token cut, at most `alertLinesOf(rows)` rows (4, or 2 under 20 rows), the last row ends with `…`. Never cut one line with `truncate` (tui-design 5.2, 5.20).
