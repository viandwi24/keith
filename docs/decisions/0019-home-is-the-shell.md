# 0019. Home is the shell: panels and toasts, never bare screens

Status: Accepted (2026-11-09), implemented in P20. Extends ADR-0013 (sign in inside the terminal UI) and ADR-0014 (every start signs in). Plan: docs/plans/done/P20-tui-polish-round.md. Specs: docs/specs/tui.md, tui-design.md (5.16 Home, 5.20 Toast), tui-login.md.

## Context

Hand testing showed several states that drew a bare, full-screen page with no orb and the content stuck at the top-left: a stored core that was down, the Sign in screen after a
sign out, the Sign out confirmation. The orb and the connection mark are the identity of the app; a page without them reads as broken. Notices such as `signed in as ana` also sat
in Home's caption slot and stayed until the next event.

## Decision

1. **Home is the one shell.** Signing in, signing out, a locked socket and a core that is down are shown as a panel (a `FramePanel` over the lower orb, at most 46 cells wide) or as
   the disconnected state of Home. The only full Sign in screen left is for a client that has never stored a core (it asks for the address), and `/login` for another core.
2. **A start never lands on a bare screen.** `keith` with a stored core that does not answer opens Home on that core, signed out (the error in `danger`, no tip line); signing out
   switches to the same core with no credential and opens Home signed out.
3. **Short-lived notices are toasts.** A top-right stack, starting on row 2 (below the connection mark), 5 s by default, fading in 150 ms and out 300 ms with the same fade engine
   as the intro (no fade at 16 colours, `NO_COLOR` or reduced motion), at most 3, never taking keys. `SwitchOptions.notice` (`signed in as ...`, `unlocked`) is a success toast.
4. **Compact copy.** One line where one line says it: `remember for 30 days  (ctrl+r)` with no explanatory note; the old-login notice is a single filled box with one flowing
   sentence and its own width; the core-down message is the error alone; a panel does not echo the identifier or the version.
5. **The Home menu is two levels**: Overview, People & access, Apps (plugin views, then Plugins and Reviews), Models & budget, System, Help, Logout (no gap).
6. **The wide chat is two columns**: the session on the left (header, messages, prompt, legend), the sidebar on the right the full height. The orb flight between chat and Home
   starts and ends on the sidebar orb in wide mode and on the header corner in small mode.

## Consequences

- Fewer special pages to keep alive; every state shares the orb, the mark and the legend. Tests assert frames of Home with a panel instead of a separate screen.
- `LogoutScreen` has a `panel` mode; the `logout` screen id and `SessionScreens` remain for the `/login` path and tests.
- A toast can cover the top right of the content below it (never the mark or the legend); a very short terminal could let its 3 rows reach the legend (no guard yet).
- Revisit if a screen needs a persistent, stackable message log (toasts are not history), or if `/login` should also become a panel.
