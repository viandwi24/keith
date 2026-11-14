# P20 — TUI polish round after hand testing

Nov 9, 2026 · status: **done Nov 9, 2026** (verified by tests and PTY text frames; not by eye on a real terminal)

Owner feedback from trying the TUI by hand, in order. Decision record: `docs/decisions/0019-home-is-the-shell.md`.

## What changed

| Area | Change | Spec |
| --- | --- | --- |
| Start with the core down | Home on the stored core, signed out, error line only (no `keith-core start` tip); the bare Sign in screen only when no core was ever stored | tui.md "Every start signs in" (4), tui-design 5.16 |
| Old saved login notice | One compact filled box, one flowing sentence, own width (`legacyNoticeWidth`, 60) apart from the panel (`loginPanelWidth`, 46) | tui-login.md |
| Sign-in panel | 46 wide; no echoed identifier, no version line, no blank rows between box, tabs, fields; `remember for 30 days  (ctrl+r)` on one line | tui-login.md, tui-design 5.16 |
| Toast | `ToastProvider`/`ToastStack` in `packages/ui`; top-right from row 2; 5 s; fade; `signed in as ...` and the forgotten-login notice are toasts | tui-design 5.20 |
| Sign out | A `FramePanel` over Home (`LogoutScreen` `panel` mode); after `y`, Home signed out with its sign-in panel | tui.md (Sign out) |
| Wide chat | Two columns, sidebar the full height, prompt and legend the left column's width | tui-design 5.1 |
| Orb flight | Chat to Home and back starts/ends on the sidebar orb in wide mode (`chatOrbBox`), on the header corner in small mode | tui-design (motion) |
| Home menu | Two levels: People & access, Apps (views, Plugins, Reviews), Models & budget, System; Logout directly under Help; `enter`/`→` open, `←`/`esc` back | tui.md, tui-design |

## Not verified

- Everything above by eye on a real terminal: the fades, the box fills, the right-edge toast placement, the sidebar below the prompt row on tall terminals, the menu on the narrowest width (the `[←] back` legend entry), the orb flight geometry in wide mode.
- The toast on a very short terminal (its 3 rows could reach the legend).
- `bun run smoke` was not rerun after these changes; `bun run check` passed (before the Home menu commit, whose touched tests passed on their own).

## Owner to run

`bun run manual:tui`: stop and start `manual:core` (disconnected Home, no tip line), sign in (toast), `/logout` and `y` (panel, then Home signed out), `space` menu levels, widen the terminal and `ctrl+b` the sidebar, go chat to Home and back and watch where the orb starts.
