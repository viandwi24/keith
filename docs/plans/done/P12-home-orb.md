# P12 — Home screen with the voice orb

Nov 8, 2026 · status: **done Nov 8, 2026** · prototype: `apps/orb-lab` (a throwaway lab, deleted at M5)

`keith` opens on a Home screen: a large animated orb, the brain trace, Keith's last words as a
subtitle, and two keys (`enter` chat, `space` menu). The chat stays as it is. The orb lab proved the
look; this plan moves it into the real TUI and fills in what the lab never had (auth, approvals,
connection states, roles, themes, sizes).

## Decisions (made, with reasons)

| Question | Decision | Why |
| --- | --- | --- |
| Where does it live | Pure parts and Ink components in `packages/ui` (`orb/`); the screen in `apps/tui/src/features/home/` | Rule: features draw only through `@keith/ui`; the core console can reuse the orb later |
| Landing screen | `keith` (no args) opens Home; `keith chat` still opens the chat directly; `keith manage` unchanged | Nothing that works today moves |
| Chat to Home | `esc` while the chat is idle returns Home; `ctrl+g` goes Home at any time and the turn keeps running (D4: `esc` stops a turn in the chat and on Home, nothing else) | `esc` already means "back" on every other screen; leaving the chat must never lose an answer |
| Orb states | Real, not simulated: `idle` connected and quiet · `listening` the chat draft is non-empty · `thinking` a turn runs and no text streams yet · `speaking` assistant text streams · `alert` offline, core down, logged out | Maps 1:1 to state the TUI already has; `listening` reuses the lab's green for "you are typing" |
| Brain trace | Fed by the real brain events (`brainEventOf` in the same `onRecord` that feeds `useBrain`); the lab's random simulation is deleted | One source of truth |
| Subtitle | The streaming text of the front session's assistant turn, 2 lines max, typed out; cleared when the turn ends | ChatView stays mounted while hidden, so the app can lift the text |
| Menu | `space` opens the HUD list: the manage sections the role may read (`visibleSections`), plus Tasks, Brain trace, Help. `enter` toggles a read-only live summary box; `→` opens the full screen at that section | Manage sections are interactive forms: the HUD stays a summary and never duplicates them |
| Auth | Logged out or core down: the orb turns `alert`, a framed `Sign in` panel replaces the subtitle (core address, what to run, `enter` starts `keith login`'s flow), the chat key is disabled | Same facts as `LoggedOutBlock`, shown where the user lands |
| Approvals, step-up | Their existing dialogs render on Home, bottom-centre, above the key legend; keys behave as in the chat (`tab` focuses the approval) | A risky action must never wait behind an unread screen |
| Header facts | Right of the title row: `● live` connection, `core 0.1.0`, front model, spend (the same `Fact`s as the status line) | The lab had a bare title; the real app already shows these |
| Frame style | btop frames from the lab (`╭─ label ─╮`, hotkey letter in the accent), colours from theme tokens | Matches the design the owner approved |
| Colour depth / themes | truecolor: smooth; 256 or 16: quantised; `none` (`NO_COLOR`): no animation, a static `●` plus the status word; light theme fades toward the background, not black | `packages/ui` rules: every state needs text when colour is off |
| Reduced load | One timer at 12 fps for the orb, stopped when Home is not on screen; the lab's 30 fps is too heavy for Ink's reconciler | the owner's laptop overheats; measure before raising |
| Sizes | The TUI's own minimum (60 columns, `layout.ts`); Home hides the brain frame below 80 columns and the subtitle below 14 rows | One min size for the app |
| The lab | Deleted at M5 once Home has parity | No duplicate renderers |

## Milestones (one commit each, in order)

1. **M1, pure model in `packages/ui/src/orb/`** (no Ink): `orb.ts` (particles, modes, easing),
   `raster.ts` (braille), `brain-trace.ts` (EKG samples and region list), `frame-text.ts` (btop
   frames), colour helpers (depth quantising, fade toward background). Port the lab code with its
   tests; colours come in as a palette argument, never hard-coded. Update
   `scripts/exports.snapshot.json` with `bun scripts/check-exports.ts --write`.
2. **M2, Ink components in `packages/ui`**: `OrbCanvas`, `BrainFrame`, `FramePanel`, `KeyLegend`,
   `Subtitle`, `useFrameClock` (fps cap, pause); tests with `@keith/ui/testing`; spec section
   `tui-design.md` 5.16 (Home) and the shared-components list.
3. **M3, `features/home/` in the TUI**: `HomeScreen`, state mapping (orb mode, subtitle, trace), the
   auth panel, header facts, approvals and step-up, the menu; `app.tsx` routing (`Screen` gets
   `home`), `esc` rules, `commands.tsx` (`keith` lands on Home), hints, layout rules; tests with the
   fake core.
4. **M4, docs**: `docs/specs/tui.md`, `tui-design.md`, `docs/manual-testing.md` (a Home scenario),
   changeset, PTY test that opens Home, presses `space`, `esc`, `enter`.
5. **M5, cleanup and proof**: delete `apps/orb-lab`, `bun run check` once, `bun run smoke` once, a
   screen capture from a real terminal.

6. **M6, the chat looks like the lab's chat.** The owner found the real chat unlike the approved
   prototype. Decisions:
   - **`ChatHeader`** (`packages/ui`, plain props: `mode`, `trace`, `width`, `running`, `clock`, `cellAspect`,
     `right`) is the top 7 rows of the chat from 80 columns and 20 rows: the mini orb (14 x 7, live, mode
     colours) on the left; right of it a title row `✳ KEITH  <mode>` with the connection status at the far
     end, the brain graph (4 braille rows, at most 36 cells), the two-column region list and the trail of
     recent regions (`BrainFrame` with `bare`). It replaces the status line and the sidebar's Brain panel
     (no brain info twice); the sidebar keeps Tasks and Nodes. Below 80 columns or 20 rows the compact layout
     stays (status line, strip, Brain panel). Only the chat screen has the header; other screens keep the
     status line.
   - **Header facts shrink to the connection** (`● online`, `○ offline`, `○ logged out`, `◌ connecting`,
     `◐ reconnecting`), on Home, the chat header and the compact status line. Core version, front model and
     spend moved to the Home menu (Overview, Providers, Budget; a `!` after `Budget` over 80 % of the limit).
   - **The input** starts with the pulsing mode-coloured glyph (`PulseGlyph`, wall-clock driven, so the
     title and the prompt show the same one). The hints are the footer's content drawn as the rule above
     the input (`FooterRow rule`): one source, and the footer row is gone while the header shows.
   - **Flight**: `enter` on Home and `esc` in the chat move the orb between its Home box and the header box:
     4 frames 75 ms apart (300 ms, 13 fps) of the orb alone, eased; the timer exists only while it flies and
     no key is held (the screens underneath stay live). Cheapest honest version: the chrome appears at the
     end, it does not morph. Skipped without colour or below the header size.
   - **Home gaps**: the orb cap goes from 32 to 48 rows (the lab fills the height; 48 is a cost bound);
     margins and the legend already matched the lab (one margin row top and bottom, a blank between
     subtitle and legend, key dim, label bold). The alert panel (core down, logged out) is a `FramePanel`
     as wide as the subtitle column, with notices as muted lines under it.
   - **Cell aspect**: asked once from the terminal before Ink starts (`ESC[16t`, `ESC[14t` fallback),
     else `KEITH_CELL_ASPECT`, else 0.46; `[` `]` (Home) and `ctrl+o` `ctrl+p` adjust it for the session.

## Out of scope

Voice input and output, new core procedures. (The mouse wheel came with D4: scrolling only, see tui-design 6.3.) The core console (`keith-core`) keeping its own
screens; it may adopt the orb later through `@keith/ui`.

## Risks

- **Ink cost.** A 100×40 braille grid as styled `<Text>` rows redraws every frame. M2 measures
  frames per second and CPU in a PTY run before M3 builds on it; the fallback is a lower fps or a
  smaller orb, not skipping Ink.
- **Cursor and alt screen.** The app already renders with `alternateScreen` and incremental
  rendering; the orb rows must be plain strings so the diff stays small.
- **Key ownership.** Home, the chat and the dialogs all listen to keys; `focus` flags decide who
  owns them (the chat's `focus` prop is the model).

## Gate evidence

Nov 8, 2026, on the real working tree at 100245f (clean except `scripts/manual.ts`, which adds `--watch` to the
`manual:*` commands and is not part of this plan):

- `bun run check`: exit 0. Biome, tsc on every package, `bun test` (1596 pass, 13 skip, 0 fail across 1609 tests),
  check-imports, check-entry, check-size (warnings only, the longest being `app.tsx` at 631 lines) and check-exports ok.
- `bun run smoke`: `SMOKE PASS (15 steps ok, 8300 ms)`, including the TUI over the local socket.
- Commits: 1a023d3 (orb, btop frames, one look for every screen), 79409dd (Home screen, restyled screens), and
  100245f (a stray brace in `home-state.ts` that stopped the TUI from starting, and the three legend tests that still
  asserted the order before the legend became menu, chat, ask, stop).
- Not verified: the frame rate and CPU of the orb on the owner's laptop over a long session (the plan caps it at 12 fps
  and stops the timer when Home is not on screen; no measurement is recorded here), and a real-terminal capture of M5.

