# TUI design

The visual contract of `keith` (apps/tui). `tui.md` says what each screen does and where its data
comes from; this file says how it looks. The implementer follows both. A change to the look changes
this file in the same commit (rule 1), and the P8 gate checks that the PTY frames match it.

Scope: the P8 client. It has chat, approvals, `/tasks`, `/nodes`, `/brain trace`, `/whoami`,
`/help`, `/quit`, `/continue`, `/retry`, signing in (the Sign in screen, 5.13) and the
logged-out state. The settings screens (`/connect`, `/providers`, `/model`, `/budget` editing,
`/pair`, node revoke) are gone. Typing one of those commands shows a notice with the `keith-core …`
command to run on the core machine.

## 1. Principles

The look is the orb-lab design the owner approved (Home, 5.16, and the chat header, 5.17), applied to every page.

1. **One accent.** Accent colour marks only the selection marker `▸`, the hotkey letter of a frame label, the prompt, the
   activity glyph of a streaming message and commands in hints. Status colours (success, warning, danger, info) appear only
   where there is a status. Everything else is `text` or `text-muted`.
2. **Frames, not fills.** Nothing is painted except the user's own chat message (section 5.3): there is no other background colour, no selection bar and no raised surface.
   Regions are separated by whitespace and by btop-style frames: rounded corners `╭╮╰╯`, the label set into the top border
   as ` label ` (spaces, no `┤├` bars), an optional tag at the right of the top border and optional tags in the bottom
   border. Every bordered block (panels, dialogs, blocks, the detail pane of a two-pane screen) draws through ONE
   implementation, `FramePanel` (5.18), so borders look identical everywhere. There is no border inside a border and no frame
   around a whole screen.
3. **Hierarchy through weight and dim, not size or caps.** Titles and the selected row are `bold`, secondary text and rows that
   are not selected are `text-muted`. Text is never ALL CAPS, never underlined for decoration, never italic for emphasis (many
   terminals render italic badly). The one letter-spaced word is the screen title `K E I T H` (5.18).
4. **One kind of motion.** The activity indicator is the pulsing `✳` (`PulseGlyph`: `· ✢ ✳ ✶ ✻ ✽`, coloured by state). It is
   shown only while something runs. Nothing blinks, scrolls by itself or animates colour apart from it and the orb. The orb can be
   made still (`keith --disable-orb`): one fixed picture whose colour still follows the state (5.16 Motion).
5. **Dense but breathing.** Every screen has one blank row at the top and one at the bottom and a 2-column left margin. One
   blank row between messages. No padding rows inside lists.
6. **Anti-slop.** No emoji, no ASCII-art logo, no gradients, no rainbow, no frame around the whole app, no exclamation marks in
   UI text, no "✨". The product name is written `keith` in prose and `K E I T H` in a screen title.
7. **Structure survives without colour.** Every state is readable in `NO_COLOR`: glyphs, words, spacing, bold and dim carry
   the meaning. Colour only reinforces it. Every status glyph is followed by a word.
8. **Text says what to do next.** Every empty, error or blocked state ends with the command or key that moves forward
   (`/login`, `keith-core model set …`, `/continue`).
9. **One legend per screen.** The keys that work now are one `[key] label` row at the bottom (5.9), preceded by a blank row and
   followed by the margin row. Dialogs, footers and screens all draw it through `KeyLegend`.

## 2. Theme tokens

Tokens are semantic. Features never name a colour: they use a token through the `packages/ui` components
(section 7).

| Token | Use | Dark | 256 | Light | 256 |
| --- | --- | --- | --- | --- | --- |
| `bg` | reference only: the terminal background the palette was tuned against; contrast and the orb's fade are measured against it. Never painted | `#16181d` | 234 | `#fafafa` | 231 |
| `border` | frames and rules | `#363b47` | 237 | `#c8ccd3` | 252 |
| `text` | body text, frame labels | `#d5d8df` | 253 | `#23272e` | 235 |
| `text-muted` | hints, metadata, rows that are not selected, timestamps, idle lamps | `#8990a0` | 245 | `#616877` | 243 |
| `accent` | `▸` selection, hotkey letters, prompt, streaming glyph, commands | `#8ab4f8` | 111 | `#2563c9` | 26 |
| `success` | `●` ok and online, `✓`, lit lamps | `#8ccf9a` | 114 | `#2c7a4b` | 29 |
| `warning` | `!`, approvals, interrupted, a focused dialog | `#e3c07c` | 180 | `#946200` | 94 |
| `danger` | `✕`, errors, failed, revoked, logged out, offline | `#ec8a8f` | 210 | `#c0363e` | 124 |
| `info` | `◐` in progress, proactive `◆`, info notices, connecting | `#7fc4d4` | 116 | `#1d7488` | 30 |
| `user-message` | the only fill: the background of the user's chat message (5.3), a slightly lighter surface than `bg` in dark and a slightly darker one in light. Not set in `16` and `none` depth | `#22252c` | 235 | `#e8eaee` | 254 |
| `assistant-message` | foreground of the assistant's text | `#d5d8df` | 253 | `#23272e` | 235 |
| `tool` | foreground of tool and task lines | `#a4abba` | 145 | `#4f5665` | 240 |
| `orb-idle` | the orb at rest | `#d4d4d4` | 252 | `#4b5563` | 240 |
| `orb-thinking` | the orb while a turn runs | `#a5b4fc` | 147 | `#4f5fd6` | 62 |
| `orb-speaking` | the orb while text streams | `#ffffff` | 231 | `#111318` | 233 |
| `region-wernicke` | the Wernicke trace and lamp | `#c4b5fd` | 183 | `#6d4fc9` | 98 |
| `region-hippocampus` | the Hippocampus trace and lamp | `#f472b6` | 205 | `#c02679` | 162 |
| `region-parietal` | the Parietal trace and lamp (presence and deliveries) | `#ffa366` | 215 | `#b35c00` | 130 |
| `region-corpus-callosum` | the Rooms trace and lamp (shared rooms, `corpus-callosum.md`) | `#5eead4` | 115 | `#0f766e` | 23 |

The `orb-*` and `region-*` tokens are used by the orb components only (5.16, 5.17). The other orb colours reuse tokens:
listening `success`, alert `danger`, regions `info` `warning` `text` `success` `danger` `text-muted`. The old tokens `surface`,
`surface-raised` and `selection` are gone; `user-message` is back as the one fill (see the rules).

Rules:

- **No background is painted, with one owner-approved exception: the user's chat message** (`user-message`, 5.3). The app uses the
  terminal's own background, so it sits well in any terminal theme. Beyond that one fill: no
  `backgroundColor`, no `Text` background and no `inverse` selection bar anywhere (the one `inverse` cell is the text cursor).
  A state that seems to need a fill gets a glyph, a word or a frame instead; no state has needed one so far.
- Contrast: `text`, `text-muted` and `accent` also stay at 4.5 against `user-message`. `text`, `text-muted` and each status colour against `bg` stay at WCAG AA (4.5) or above in both themes, and the orb
  and region colours at 3.0 (graphics). `packages/ui/src/theme.test.ts` computes it, so a change to a value keeps it.

### Colour depth

The depth is resolved once at start, in `platform/config.ts`:

| Depth | When | Tokens resolve to |
| --- | --- | --- |
| `none` | `NO_COLOR` is set and not empty ([no-color.org](https://no-color.org/)) | nothing: no `color`. `bold` and `dimColor` stay |
| `truecolor` | `COLORTERM` is `truecolor` or `24bit` | the hex values |
| `256` | `TERM` contains `256color` | `ansi256(n)` from the table |
| `16` | anything else | ANSI names: `text` → unset, `text-muted` → `gray`, `border` → `gray`, `accent` → `blue`, `success` → `green`, `warning` → `yellow`, `danger` → `red`, `info` → `cyan`, `tool` → unset |

Chalk (inside Ink) does not honour `NO_COLOR` by itself (it reads only `FORCE_COLOR`), so the theme must pass no colour props
at all in `none` mode.

Because nothing depends on a background, every depth draws the same structure (the same frames, glyphs and markers); only the
colours differ. In `none` depth the pulsing glyph is a static `✳`, the orb a static `● <mode>` and every status a glyph plus a word.

### Choosing the theme

`KEITH_THEME=dark|light|auto` (default `auto`). `auto` reads `COLORFGBG` when it is present. Its
last `;`-separated field is the background index: `7` or `15` means light, any other number means
dark. Without `COLORFGBG`, `auto` means dark.

All of `KEITH_THEME`, `COLORFGBG`, `COLORTERM`, `TERM` and `NO_COLOR` are read only in
`apps/tui/src/platform/config.ts`, through the zod schema (rule 10). `loadConfig` returns
`{ theme: 'dark' | 'light', depth: 'truecolor' | '256' | '16' | 'none' }` next to the existing
fields. `cli.tsx` passes `resolveTheme({ theme, depth })` to `<ThemeProvider>`, with
`spinner={depth !== 'none'}` (the flag that lets the `PulseGlyph` animate). Tests pass a theme directly, and `useTheme()` without a provider
returns dark, no colour, no animation, which is what the tests render.

## 3. Glyphs

There is one set. Every glyph is one cell wide (`Bun.stringWidth` = 1) and is not an emoji. The set replaces the `⏸` and `⏱`
that many terminals draw as two-cell emoji.

**Status vocabulary.** A status is a glyph, a word and a tone; colour only reinforces it.

| Glyph | Meaning | Tone |
| --- | --- | --- |
| `●` | ok, online, live, lit | `success` |
| `○` | off, idle, offline, queued (a problem state such as `○ offline` takes `danger`, the glyph stays) | `text-muted` |
| `◐` | in progress: running task, cortex with workers, reconnecting, amygdala waiting | `info` |
| `!` | warning | `warning` |
| `✕` | failure: failed, denied, revoked, error | `danger` |

**Other glyphs.**

| Glyph | Meaning |
| --- | --- |
| `✓` | done, approved, logged in |
| `■` | stopped |
| `‖` | waiting (a task waits on an approval or input) |
| `⊘` | timed out |
| `↯` | interrupted |
| `◆` | proactive message (a worker report that woke the front agent) |
| `K` | Keith's mark in a room transcript: the speaker of Keith's lines (`accent`, bold) |
| `▸` | the selected row of a list, in `accent` with a bold label (`ListRow`, `NavList`, `Field`) |
| `›` | the prompt of a chat message, a tool call, "latest event" |
| `●` | the assistant message's dot (`accent`) |
| `│` | the sides of a frame, the tool-output gutter |
| `─` | the frame's horizontal edges, the rule above the chat input |
| `╭╮╰╯` | the corners of every frame |
| `·` | separator inside a line, and the glyph that leads an info notice |
| `…` | truncation, "thinking" |
| `$` | the start of a shell command |

**Activity indicator.** The pulsing `✳` (`PulseGlyph`) cycles `· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢`, 8 steps a second, taken from the wall
clock so every one on screen shows the same glyph. It replaces the braille spinner everywhere: the streaming message's dot, the
`connecting` status, the running state of a tool line, the chat's title and prompt (where it takes the orb's mode colour).
Its colour is a state: an orb mode (`idle`, `listening`, `thinking`, `speaking`, `alert`) or a tone (`info` while connecting,
`accent` for a message that streams). Only one per item; a list of running tasks uses the static `◐`, not ten pulses. In `none`
depth and in tests (`spinner={false}` on `ThemeProvider`) it is a static `✳`, so frames are stable.

## 4. Layout

Keith runs full screen: `render(<App/>, { alternateScreen: true })`. It restores the terminal on exit and owns its own
scrolling. Mouse capture stays off, so the terminal's native text selection and copy keep working. Height comes from
`useWindowSize().rows`; width comes from `columns` (prop for tests) or `useWindowSize().columns`.

**Margins.** Every screen has one blank row at the top and one at the bottom, and a 2-column margin on the left (the
`gutter`). The title row (5.18) and the legend sit inside them. `ScreenFrame` does this for a screen; the chat and Home place
their own rows with the same numbers.

```
row 1      blank (margin)
row 2      title row: ╭─ Label ─╮        K E I T H                  ● online
row 3      blank
rows 4..   conversation (or the active screen)    ╭─ Tasks ─────╮ frames of the sidebar
           approval dialog (when one waits)       ╰─────────────╯
           blank
           legend: [enter] send    [esc] home    /help                 (1 row)
last row   blank (margin)
```

From 80 columns and 20 rows the chat's top is the 9-row header (5.17) instead of the title row; the legend is then the rule
above the input. With the sidebar the screen is two columns: the left one holds the header, the conversation, the input (its two
rules) and the legend, and the sidebar beside it runs the full height, from the title row down to the bottom margin row, with the
separator. The input, the dialog and the legend are as wide as the left column: they never run under the sidebar.

### Widths

| Columns | Layout |
| --- | --- |
| < 60 | unsupported: one muted line "keith needs at least 60 columns" and nothing else |
| 60–99 | single column. The sidebar is hidden. A one-row **activity strip** sits above the input: `◐ cortex ×2   2 tasks running   nodes 1/2`. `ctrl+b` shows the sidebar beside the conversation anyway (32 columns), which is the user's choice |
| 100–159 | sidebar 32 columns on the right (`SIDE_WIDTH`), a blank column, the `│` separator and a blank column before it |
| ≥ 160 | sidebar 40 columns. The conversation column is flexible: it takes all the room up to the fixed-width sidebar, text starting after a 2-column gutter (no prose cap) |

`layout.ts` is `layoutOf(columns, { rows, sidebar }) → Layout`: `sidebar` (0, 32 or 40), `strip`, `left` (width of the left
column: `columns - sidebar - 3 - 2`, the 3 being a blank column, the separator and a blank column), `conversation` (width of the message
rows), `prose` (width of wrapped text), `footer`, `header`, `headerVariant` (`none`, `orb` or `title`), `orbInSidebar`, `separator` (1 with a
sidebar, else 0) and `supported`.
`sidebar` in the options is the user's `ctrl+b` (`true` shows it, `false` hides it, `undefined` follows the width). The text
width of a message is `min(100, left - gutter - indent)`; the message rows are `min(left, prose + gutter + indent)` wide, so at
160 columns and more the conversation stays 104 columns wide and the rest is empty.

### Wide mode: the orb in the sidebar

| Rule | Value |
| --- | --- |
| The orb moves to the top of the sidebar when | the sidebar is shown **and** columns >= 100 (`ORB_SIDEBAR_COLUMNS`) **and** rows >= 40 (`ORB_SIDEBAR_ROWS`: at 40 rows the orb gets 9 rows, never under its smallest 8) |
| Otherwise | the orb stays in the chat header (5.17, 9 rows), exactly as before: 60-99 columns (also with `ctrl+b`), under 40 rows, or the sidebar hidden |
| Header in wide mode | `title` variant: the title row `✳ KEITH  <mode>  online` and a blank row (`CHAT_TITLE_ROWS`); no orb, no graph, no region list |
| Sidebar, top to bottom | orb (8 rows or more) · wave graph frame (7: two borders, 4 braille rows, the trail) · Brain (9) · Tasks (4 or more) · Nodes (up to 6) |
| Orb size | a canvas as wide as the sidebar (32 or 40) and `orbRowsFor` rows high, the orb round inside it and filling the column. Rows = the smaller of (a) the rows left in the column under graph (7), Brain (9), Tasks (4) and a reserve of 4 for Nodes, and (b) the rows that equal the column's width at the cell aspect (`floor(width x aspect)`, at most 20: 14 at 32 columns, 18 at 40, at aspect 0.46); under 8 rows the orb is not drawn in the sidebar. The orb takes every row the panels leave, so it fills the width as soon as the height allows |
| Graph | `BrainFrame` with the status tag, 4 graph rows, no region list (the Brain panel lists the regions; eleven regions take six list rows, so the frame body is six rows tall) |
| Fit | the column is `rows - 2` (a blank row on top, the margin row at the bottom); extra height only adds orb rows up to the column's width and Tasks. Orb rows by terminal height (cell aspect 0.46): 40 rows 8, 42 rows 10, 44 rows 12, 45 rows 13 (the full 32-column width is 14: more rows only add Tasks), 50 rows 18 at a 40-column sidebar. At 38 rows there is no room for the orb (under 8), but the layout switches at 40, so the orb is never under 8 beside the 32-column frames. `planSidebar` gives Nodes up before Tasks drops under 4 rows; when orb (8), graph, Brain, Tasks and the nodes reserve (32 rows) do not all fit, the orb is not drawn at all (it is in the header) |
| Separator | one column `│` (`G.rule`) over the full height of the sidebar column (level with the title row down to the bottom margin row, past the input and the legend), in the `border` token (the frames' colour, never bright); in `NO_COLOR` no colour prop. In every layout that shows the sidebar |
| Motion | the orb states (idle, thinking, speaking, alert) work as in the header; the orb and the graph share one clock. `--disable-orb` makes the orb still (5.16 Motion): no flight, colour only. The intro and the idle hide are Home's only: the chat never hides anything. The Home flight starts and lands on the sidebar orb (`chatOrbBox`: wide mode with the sidebar shown; it is computed for the chat layout even while Home is on view; without the sidebar, or with the orb in the header, the flight uses the header corner) |

```
                                                                                      (120x40, wide mode; the orb is 10 rows here, 14 from 44 rows)
  ✳ KEITH  idle  online                                                             │      ⣀⣤⣶⣶⣤⣀
                                                                                    │    ⢀⣾⣿⣿⣿⣿⣷⡀
  ...messages...                                                                    │    ⠈⠻⣿⣿⣿⠟⠁
                                                                                    │ ╭─ idle ─────────────────────╮
                                                                                    │ │ ⣀⣀⣤⣤⣀⣀⣠⣤⣤⣀                │
                                                                                    │ │ ⠉⠛⠿⠿⠛⠉⠙⠛⠛⠉                │
                                                                                    │ │ thalamus › broca             │
                                                                                    │ ╰──────────────────────────────╯
                                                                                    │ ╭─ Brain ──────────────────────╮
                                                                                    │ │ ● Thalamus    ○ Wernicke     │
                                                                                    │ │ ...                          │
                                                                                    │ ╰──────────────────────────────╯
                                                                                    │ ╭─ Tasks ──────────────────────╮
                                                                                    │ ╭─ Nodes ──────────────────────╮
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ✻ type a message, or /help
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  [enter] send    [shift+enter] newline    [ctrl+b] sidebar    [esc] home    /help
```

Fallback (100x35, 90 columns with `ctrl+b`, or any size under 40 rows): the 7-row header carries the orb, the facts and the graph as
in 5.17; the sidebar has Tasks and Nodes (no Brain panel) and still has the separator:

```
  ⣀⣀⣤⣤⣀⣀                                                                         │ ╭─ Tasks ──────────────────────╮
 ⢀⣴⣿⣿⣿⣿⣷⣄   ✳ KEITH  idle                                  ● online                  │ │ no tasks yet                 │
```

### Heights

- Compact header 1 row (the chat header 8, or 2 in wide mode), the legend 1 row with a blank above it, the margins 1 row each.
- Input: 1 row, growing with the draft up to 6 rows, then the draft scrolls inside it.
- Approval dialog: its own height (6 to 9 rows, borders included). It pushes the conversation up, never covers it.
- Below 20 rows the legend row is hidden (`/help` still works). Below 12 rows the sidebar is hidden, whatever the width.
- Sidebar frames share the height and sit on each other with no gap: Brain is fixed at 9 rows (borders included), Nodes takes up
  to 6 and Tasks the rest and at least 4 (`planSidebar` in `sidebar.tsx`). When Tasks would get less than 4 rows, Nodes gives
  its place up. A frame that does not fit shows `+n more /tasks` as a tag in its bottom border.

### Spacing scale

Spacing is in cells. There are only these values:

| Name | Value | Where |
| --- | --- | --- |
| `gutter` | 2 columns | left margin of every screen and of the conversation |
| `pad` | 1 column | between a frame's side and its text |
| `gap` | 1 row | between messages, above the input, above the legend |
| `indent` | 2 columns | continuation lines, tool lines under a message, list detail lines |

No component uses vertical padding inside a frame.

## 5. Components

Mockups are 100 columns wide (the sidebar layout) unless they say otherwise. In the mockups, `{a}` means accent, `{m}`
muted, `{w}` warning, `{d}` danger, `{g}` success and `{i}` info; the braces are not drawn on screen. Nothing on screen is painted:
every mockup is exactly what a `NO_COLOR` terminal shows.

### 5.1 The chat screen at 100 columns

The real screen at 100 x 30 (a plain-text dump of the app on a fake core, no colour; the long blank run is the empty rows of the
conversation). The top is the chat header (5.17), the left column the conversation, the right the sidebar frames (5.10), the two rules
around the input and the legend are the width of the left column only: the sidebar runs the full height beside them (5.9):

```
                  ✳ KEITH  idle                                                            ● online
                                                        ○ Thalamus       ○ Wernicke
      ● idle                                            ○ Broca          ○ Cortex
                                                        ○ Motor          ○ Amygdala
                                                        ○ Ras            ○ Hippocampus
                  no activity yet
  › what's using my disk on the laptop?                             ╭─ Tasks ──────────────────────╮
                                                                    │ no tasks yet                 │
  ● Let me check on laptop-e.                                       ╰──────────────────────────────╯
    › laptop-e $ df -h                                            ✓ ╭─ Nodes ──────────────────────╮
    │ /dev/disk3s1 460Gi 401Gi 41Gi 91%                             │ no nodes · keith-core pair   │
    │ l2                                                            ╰──────────────────────────────╯
    │ l3
    │ … 1 more line

    Your main volume is at 91 %. Run `du -sh ~/Library/Caches` to
    dig.

  ! Careful: context is getting long



───────────────────────────────────────────────────────────────────
  ✳ type a message, or /help
───────────────────────────────────────────────────────────────────
  [enter] send    [ctrl+j] newline    [esc] home    /help

```

The bottom of the chat is always: a bare rule, the input (it grows with its newlines), a bare rule, the one legend row, and the
margin row. Both rules are plain `text-muted` `─` lines the width of the left column, with no text in them.

Under 20 rows or 80 columns the compact layout stays: the title row of 5.2 on top, the Brain panel back in the sidebar, the
activity strip under 100 columns, and the same bottom (rule, input, rule, legend). Under 20 rows the margin row under the
legend goes first.

### 5.2 Title row and status line

Every full screen starts with the title row (`TitleRow`, 5.18): the screen's label as a corner tag on the left (`╭─ Manage ─╮`),
`✳ K E I T H` letter-spaced and centred inside the margins; the connection is the colour of the `✳` (pulsing as in 3), and the
only text is a word next to the name when the state is not online (always, in no-colour mode). While the session is stepped up
an `elevated 9:41` countdown (`text-muted`) sits alone at the right (`StatusInfo`). The compact header (under 80
columns or 20 rows in the chat, and every screen that has not adopted `ScreenFrame` yet) is the same row without the label
(`StatusLine`). The chat's own header is 5.17. The core version, the front model, the spend and the person are not here: they
are in the Home menu (5.16), in `/whoami` and in `/budget`.

| Connection | Rendering |
| --- | --- |
| first connect | `✳` in `warning`, the word `connecting` (`warning`), plus the target: `unix:~/.keith/core.sock` or the URL |
| live | `✳` in `success`, no word (the word `online` only without colour) |
| reconnecting (a drop, or a retry attempt) | `✳` in `warning`, always the text `reconnecting… (3 s)` counting down the attempt's 5 s window |
| disconnected (the window ended without a live feed) | `✳` in `danger` and always a message: `✕ disconnected: cannot reach the core (<target>, <last error>) · retrying in 12 s` (`danger`, countdown to the next attempt, ticking each second). The message is drawn under the title row (see the paragraph below), never cut. Without a last error the parenthesis is left out. The `✕` keeps it readable without colour |
| unauthorized (401) | `✳` in `danger`, the word `logged out` |
| core down | `✳` in `danger`, the word `offline` |

**Top alerts.** A down link's message is not in the title row: it is drawn on the rows under it, wrapped on words to the row's width
(`wrapLines`, `packages/ui/src/wrap-lines.ts`). The first row keeps the `✕` and the `danger` colour, the continuation rows are indented
two cells under the text. A message takes 1 to 4 rows (2 rows on a terminal under 20 rows); when it needs more, its last row ends with
`…`; a long unbroken token (a path, a URL) is cut at the width, never dropped. The alert reserves exactly the rows it uses: the title row,
the chat header (5.17) and the content below move down, and the input and the legend stay on screen.

The month's spend is `$3.21 / $20 this month` (`$3.21 this month` with no limit) in the Home menu's Budget box; from 80 % of the
limit the Budget item carries a `!` (`warning`) after its title and the box adds `! over 80% of the limit`, at 100 %
`! limit reached`. A missing front model is the `No model is set yet.` notice that tops the conversation. The node count is in the
sidebar and the activity strip.

### 5.3 User message

- A bubble: every row of the message (the `›` row and each wrapped line, the gutter included) is painted with `user-message`
  across the full width of the conversation column. The row starts with `›` in `accent`, then the text in `text`, wrapped at the
  prose width; continuation lines are indented by 2. This is the only painted element in the app. In `16` and `none` depth no
  fill is passed, so the message is just the `›` row as plain text.
- One `gap` row before and after, left unpainted.
- A long paste (more than 12 lines) shows the first 10 lines and then `… +n lines` in muted. The full text is sent.

### 5.4 Assistant message

- No background. The first line starts with `● ` in `accent`; the rest is indented by 2 (`indent`).
- The text is `assistant-message`, rendered as terminal markdown (section 6.4).
- **Streaming:** the `●` is the pulsing `✳` in `accent` (static `✳` without animation). Text appears as it arrives; there is no
  cursor block at the end. Before the first token, the message is `✳ thinking…` in `text-muted`.
- **Stopped by Esc:** the message ends with a muted line `■ stopped`.
- **Proactive** (`data-keith.proactive`): the dot is `◆` in `info`. The message body is the same as
  any assistant message. Nothing else changes, so the marker stays the only signal, as in `tui.md`.

### 5.5 Tool call and delegated task lines

Tool parts of an assistant message render under it, in order, indented by `indent`, in `tool`
colour. One line per call:

```
     › laptop-e  $ df -h                                   ✓ 0.4s
     › memory.recall  /memories/profile.md                 ✓
     ◐ research  find disk usage on laptop-e               00:42
     ‖ laptop-e  $ rm -rf ~/Library/Caches/*               waiting for approval
     ✕ laptop-e  $ du -sh /                                ✕ exit 1 · permission denied
```

- `›` marks a tool the front agent called. The name is followed by a one-line summary of the input:
  for `motor_remote`, the node and `$ <command>`; for anything else, the tool name and the first
  string value of its input, clipped to fit.
- Nothing is painted: tool lines have no fill, only `tool` colour; a failure is `✕` plus the reason in `danger`. The only
  moving part is the pulsing glyph of a running call (`PulseGlyph`, one per call).
- A delegated task (`subagent` / cortex) uses its task status glyph from section 3 instead of `›` (the static `◐`, tone `info`,
  for a running one).
  It shows the short agent name (`research` for `cortex.research`), the description and the
  elapsed `mm:ss`, which ticks while the task runs.
- The state sits at the right edge in `text-muted`: a running call shows the pulsing `✳`, a done call
  shows `✓` plus its duration, a failed call shows `✕` plus the reason in `danger`, and a call
  waiting for an approval shows `waiting for approval` in `warning`.
- Output: at most 3 lines of the (core-clipped) result, under a `│` gutter in `text-muted`, then
  `… n more lines`. Shell output is shown; JSON results are not shown, only their state.
- The line never wraps; it truncates with `…` (`wrap="truncate-end"`).

### 5.6 Notices

A notice is a glyph-led row, never a bar or a box: the glyph in its tone (bold), then the text in `text`, continuation rows
indented under the text. Notices include:

- `eh.notice` messages;
- the interrupted line;
- the session `notify` messages;
- `state.problem`;
- replies to removed commands.

Hints and commands inside a notice are rendered in `accent`.

```
  ! The previous turn was interrupted: its process stopped before it finished.      {w}

  ✕ Unexpected error (see server logs).                                             {d}

  · Models are set on the core machine: keith-core model set front <id>             {i}
```

| Level | Glyph and tone | Used for |
| --- | --- | --- |
| info | `·` in `info` | removed commands, `No interrupted turn.`, `reconnected` |
| warning | `!` in `warning` | interrupted, timeout, context thrash, cost cap, approvals failing |
| error | `✕` in `danger` | run failed, provider errors, a failed send |

Stored notices (`data-eh.notice`) stay in the transcript where they happened. The session `notify` messages and the replies to commands
render as one notice row right above the input. They replace each other and go away when the user sends the next message.
The glyph is the same at every depth, so no mode needs a prefix of its own.

**Dream line and divider.** While a memory dream runs for the person (tui.md, "Dreaming"), the transcript shows one animated line where
`thinking…` shows, in `text-muted` with the streaming glyph: `dreaming · 12 s` (the seconds count up; `dreaming · reviewing 3 notes · 12 s`
when a count is known). The input stays usable. When the run ends the line gives way to one permanent divider in the context divider's
style (a rule and a muted label): `dream finished · 3 reviewed · 2 changes waiting (/dream apply)` (staged; `· expires <date>` is added when the run's end time is known), `dream finished · 3 reviewed
· 2 changes saved (/dream undo within 7 days)` (applied), `dream failed · <reason>`, the skip sentence, `dream refused · <reason>` and
`dream rejected · …`. With nothing to change: `dream finished · 3 reviewed · nothing to change`. No toast repeats it on the chat screen.

### 5.7 Approval dialog

The dialog sits above the input, in the left column, as a `FramePanel` (5.18): the title in the top border, the `1 of N` count as
a tag at its right. It is unfocused at first (the chat input keeps the keys, as in `tui.md`): the frame is `border` colour.

Unfocused:

```
  ╭─ Approval needed ──────────────────────────────────────────────────── 1 of 2 ─╮
  │ research wants to run a shell command on laptop-e                               │
  │ $ rm -rf ~/Library/Caches/*                                                     │
  │ task  find disk usage on laptop-e                                  {m}          │
  │ tab to answer                                                      {m}          │
  ╰─────────────────────────────────────────────────────────────────────────────────╯
```

Focused (after `Tab`): the frame and the title turn `warning` and the last row is the legend. The chat input dims
(placeholder `tab to return to chat`):

```
  ╭─ Approval needed ──────────────────────────────────────────────────── 1 of 2 ─╮   {w}
  │ research wants to run a shell command on laptop-e                               │
  │ $ rm -rf ~/Library/Caches/*                                                     │
  │ task  find disk usage on laptop-e                                               │
  │ [y] allow    [n] deny    [N] reason    [a] allow for task    [tab] back         │
  ╰─────────────────────────────────────────────────────────────────────────────────╯
```

- Who asked: `<agent> wants to run a shell command on <node>`. The agent is the short agent name of the task when it is known,
  else `keith`. For a tool that is not `motor_remote` the row is `<agent> wants to call <tool>`, and the detail row is the clipped
  JSON input.
- The command row is plain text under the sentence (`Chip`: it has no paint and no border of its own). It wraps under the `$`
  and is never truncated: the person must see the whole command.
- The legend row is a `KeyLegend` (5.9) sized to the dialog's inner width (`dialogInner(width)`); in a narrow left column the
  lowest-priority pairs go, never half of one.
- `N`: the legend row becomes `reason › <input>`, with the placeholder `enter to deny, esc to cancel`.
- A failed answer adds a `danger` row `✕ Failed to answer: <message>` inside the dialog.
- The owner's view of a member's request (`extra.askedBy`) changes only the sentence: `Ana asks to run a shell command on
  laptop-e`; the command row, the task row and the legend are the same.
- A member's own request that waits for the owner is read only: the frame stays muted, the sentence and command are the
  member's own, the last row is `◐ Waiting for the owner to approve` in `warning` and there is no legend and no `tab` hint:

```
  ╭─ Approval needed ──────────────────────────────────────────────────── 1 of 1 ─╮
  │ keith wants to run a shell command on laptop-e                                  │
  │ $ rm -rf ~/Library/Caches/*                                                     │
  │ task  free some disk space                                                      │
  │ ◐ Waiting for the owner to approve                                  {w}         │
  ╰─────────────────────────────────────────────────────────────────────────────────╯
```

The frame is the same at every colour depth.

**One legend while a dialog has the keys.** The dialog's own last row is the one place its keys are listed. While it has the keys
(the approval dialog after `tab`, the step-up prompt always) the page legend says nothing: the chat's legend row under the input
stays empty (`hintsOf` returns no hints; the input between its rules shows dimmed and reads `tab to return to chat`), Home's
legend row is empty, and a screen's `ScreenFrame` legend is dropped. Unfocused, the page legend stays (it carries `[tab] approval` in `warning`) and the dialog only says `tab to answer`.
The same rule holds on Home and on every screen.

### 5.8 Input

- Nothing is painted and there is no prompt mark: the draft starts in the gutter column, the same column as the legend below it.
  The input sits between two bare rules and the legend (5.9) is the row below them, with or without the header; two blank rows
  separate the top rule from the conversation.
- Placeholder in `text-muted`:
  - idle: `type a message, or /help`;
  - busy: `esc to stop`;
  - the dialog has the keys: `tab to return to chat`;
  - logged out: no input; the block of 5.12 replaces it.
- Multiline: `enter` sends. **`shift+enter` inserts a newline** where the terminal speaks the Kitty keyboard protocol; `alt+enter`,
  `ctrl+j` and `\` followed by `enter` insert one in every terminal and stay as fallbacks. The input grows to 6 rows.
  The app asks for the protocol at start (Ink's `kittyKeyboard`, mode `auto`, flag `disambiguateEscapeCodes`: the terminal is
  queried with `ESC[?u` and enables it only if it answers). Terminals expected to support it: kitty, WezTerm, Ghostty, foot,
  Alacritty (0.13+), iTerm2 (3.5+, with CSI u reporting) and recent Windows Terminal; others, such as macOS Terminal.app,
  cannot tell `shift+enter` from `enter` and use the fallbacks. The newline hint is `[shift+enter] newline` only once the
  terminal has shown the protocol (it answered the query, or a `shift+enter` arrived as a Kitty sequence), else
  `[ctrl+j] newline`: the legend never names a key that does not work. Pasted text arrives whole through Ink's `usePaste`; its newlines are kept, and it
  is never sent on paste.
- Cursor: one `inverse` cell. It does not blink.
- `/` at the start shows matching commands on one accent row above the input (`/tasks  /nodes  /brain trace  /whoami  /help`). It
  only shows them: there is no menu to navigate. `tab` completes when exactly one command matches.

### 5.9 Legend: key hints

One legend per screen, at the bottom, drawn by `KeyLegend` (`KeyHints` and `FooterRow` are adapters of it): the key in
brackets in `text-muted`, the label `bold`, 4 spaces between pairs (`[enter] send    [esc] home`). A hint with no label is a
typed command and is drawn bold without brackets (`/help`). The legend is preceded by one blank row and followed by the margin
row (`ScreenFrame`); in the chat it is its own row under the input's bottom rule (5.1), followed by the margin row. Home
centres its legend (5.16).

Keys are lower case (`enter`, `esc`, `tab`, `ctrl+b`, `ctrl+g`, `↑↓`). Only the keys that work right now are listed. Scrolling
is never in a legend: the wheel works by itself, and a scroll view says `↓ more · scroll` or `↓ latest [end]` when it matters
(6.3). `pgup` and `pgdn` keep working, unlisted.

**Fitting.** A legend is never cut with `…`. Given its width it (1) tightens the gap from 4 to 2 spaces, then (2) drops whole
pairs, lowest `priority` first and the rightmost first among equals, until it fits. `priority` is a number on the hint, default
10; a `warning` pair (`tab approval`) is 90 and `/help`, `?` and `ctrl+c` are 100, so the way out and the way to help always stay.
The chat's idle legend sets `enter send` 80, `esc home` 70, `shift+enter`/`ctrl+j newline` 40, `ctrl+b sidebar` 20; the busy
one `esc stop` 90, `ctrl+g home` 80, `ctrl+b sidebar` 20; Home's legend while a turn runs `esc stop` 90, `enter chat` 80,
`space menu` 70. A screen
whose legend must not lose a pair may use a second row where it has one to spare (not built yet: `LegendRow` is one row).

| Context | Hints |
| --- | --- |
| chat, idle | `[enter] send    [shift+enter] newline    [ctrl+b] sidebar    [esc] home    /help` (`[ctrl+j] newline` where the terminal does not report `shift+enter`) |
| chat, busy | `[esc] stop    [ctrl+g] home    [ctrl+b] sidebar` |
| Home, idle | `[space] menu    [enter] chat    [tab] ask` |
| Home, a turn runs | `[space] menu    [enter] chat    [tab] ask    [esc] stop` |
| an approval waits | `[tab] approval` is added first, in `warning` |
| dialog has the keys | the page says nothing; the dialog's row reads `[y] allow    [n] deny    [N] reason    [a] allow for task    [tab] back` (priorities: `y` `n` 90, `tab` 80, `N` 40, `a` 30) |
| a list screen | `[↑↓] select    [enter] open    [s] stop    [esc] back` (per screen) |

At 100 to 106 columns the chat's left column is 65 to 71 cells less the gutter and the idle legend keeps `[enter] send`, `[esc] home`,
the newline hint and `/help` (the rest go), which is the first rule above working as written.

**`esc` and `ctrl+g`: leaving the chat never stops a turn.** `esc` has one meaning per state: while a turn runs it interrupts the
turn and nothing else; when idle it goes Home. `ctrl+g` goes Home at any time from the chat, busy or idle; the turn keeps
streaming in the background (the chat stays mounted) and Home shows the live orb, the subtitle and the approvals. On Home `esc`
stops a running turn and does nothing when idle. The orb flight (5.17) plays for `ctrl+g` too.

### 5.10 Sidebar

The sidebar is a stack of frames (`Panel`, 5.18) with no gap between them and nothing painted. It has three panels (two when the
chat header shows with the orb, which replaces the Brain panel: no brain information twice). In wide mode (section 4) the orb and the
wave graph frame sit above the Brain panel, and the header no longer carries brain information, so the Brain panel is back. The title is the label in the top border, the
count a tag at its right, and `+n more /tasks` a tag in the bottom border. The column keeps the 2-column right margin of the title
row (`layout.left` takes it out), so its frames end in the same column as the header's status.

```
╭─ Brain ──────────────────────╮
│ ● Thalamus    ○ Wernicke     │   lit: success · working: info ◐ · idle: muted ○
│ ○ Broca       ◐ Cortex ×2    │
│ ● Motor       ◐ Amygdala ×1  │
│ ○ RAS         ○ Hippocampus  │
│ › cortex.research step 4     │   (muted, truncate)
╰──────────────────────────────╯
╭─ Tasks ──────── 2 running ───╮
│ ◐ research  disk usage 00:42 │   (active: text; finished: muted)
│ ‖ news      morning br… 01:05│
╰─ +4 more /tasks ─────────────╯
╭─ Nodes ───────── 1/2 online ─╮
│ ● laptop-e                   │   (online: text, dot success)
│ ○ pi-garage          2 h ago │   (offline: muted)
╰──────────────────────────────╯
```

- Brain: two columns of 14 cells at 32 columns, or 18 at 40 (`width - 4` split in two), six rows for the eleven regions. The lit lamp `●` is `success`; `◐` (cortex
  workers, amygdala waits) is `info`; idle is the `text-muted` `○` with the label muted. The last row is the latest event in
  muted, or `› no activity yet`.
- Tasks: the glyph in its status colour (running `info`, waiting `warning`, done `success`, failed / timed out `danger`, stopped /
  interrupted / queued muted), then the short agent name, the description truncated, and the elapsed time right-aligned and muted.
- Nodes: online first. Offline nodes show their last-seen time right-aligned. Revoked nodes are not listed. There is no pairing hint
  (pairing is `keith-core pair` on the core machine): when there are no nodes the panel reads `no nodes · keith-core pair` in muted.
- Empty panels read `no tasks yet` or `no activity yet` in muted, without parentheses.

### 5.11 Screens

A screen takes the whole terminal and `esc` returns to where it was opened from (Home or the chat). Help, Tasks, Nodes, Budget and
Brain trace are a `ScreenFrame` (5.18) drawn by `app-framed.tsx`: the margins (one row on top and bottom, two columns on each side),
the title row with the screen's label tag, `✳ K E I T H` centred (the glyph is the connection, 5.2) and the `elevated` countdown at the right, the content,
and ONE legend at the bottom. The screen asks for its legend with `useFooter`; the host draws it as the frame's legend. There is
no sidebar, strip or status line on these screens. Content rules: a muted summary line first (`4 tasks · ✳ 1 running`), tables with
a muted header row and aligned columns, `▸` for the selected row, a status as glyph plus word, an empty state as one muted line,
`PulseGlyph` for activity (one, in the summary line; lists keep the static `◐`), long lists scroll (`ScrollView`: the wheel and `alt+↑↓`,
`anchor="top"` shows `↓ more · scroll` below). While the step-up prompt is open it takes the place of the content and holds the only
legend. Manage is a `ScreenFrame` too (5.15).

**`/tasks` list:**

```
  ╭─ Tasks ─╮                         K E I T H                                          ● online

  4 tasks  ·  ✳ 2 running
      agent      task                                                                  time
  ▸ ◐ research   find disk usage on laptop-e                                          00:42   {bold row}
    ‖ news       morning brief                                                        01:05   {rows not selected: muted}
    ✓ research   compare laptop prices under $800                                     03:10
    ✕ research   read the router admin page                                           00:12
    ⊘ research   summarise the long thread                                            10:00

  [↑↓] select    [enter] open    [s] stop    [esc] back                                       (legend)
```

The summary line is `N tasks` and, while any runs, `· ✳ n running`; the header row (`agent`, `task`, `time`) is muted.

The selected row has an `accent` `▸` in the first column and bold text; the other rows are `text-muted`
(their status glyphs keep their tone). Rows are aligned in columns: glyph, agent (padded to the longest short name, max 12),
description (flex, truncated), elapsed (right). `s` turns the legend into the confirmation `stop this task?  [y] yes  any other
key cancels` in `warning`. The result note (`Task stopped.`) is an info notice row under the list.

**`/tasks` detail** (`enter`):

```
  research  ◐ running · 00:42 · 4 steps
  find disk usage on laptop-e

  No result yet.                                                     (muted while running)

  [esc] back to the list
```

A finished task shows its summary as markdown under the description. A failed one shows a
`danger` notice `✕ Failed: <error>` first.

**`/nodes`:** this list is read only, so there is no selection, no `r` and no confirmation. The platform column shows from 56
columns of content, the version from 72.

```
  ╭─ Nodes ─╮                         K E I T H                                          ● online

  2 nodes · 1 online
    name       status   platform      version  last seen                       (muted header)
  ● laptop-e   online   darwin/arm64  v0.9.0   just now
    shell.exec, fs.read · shell allowed
  ○ pi-garage  offline  linux/arm64   v0.9.0   2 h ago
    fs.read · shell off

  Pair or revoke nodes on the core machine: keith-core pair, keith-core nodes revoke   (muted, bottom)

  [esc] back
```

**`/brain trace`:**

```
  ╭─ Brain trace ─╮                   K E I T H                                          ● online

  last 50 events
  14:02:11  thalamus   message from viandwi24
  14:02:12  cortex     research step 1
  14:02:15  motor      exec laptop-e $ df -h
  14:02:15  amygdala   wait  laptop-e shell.exec
```

The time is muted, the region is padded to 11 columns in `text`, and the rest is `text`. The newest
event is last, and the view sticks to the bottom (section 6.3).

**`/whoami`:** a block in the conversation (not a screen), rendered like an info notice with rows:

```
   · viandwi24  owner                                                                     {i}
     via   local socket  unix:~/.keith/core.sock                    (or: device "laptop" · https://…)
     core  0.9.0 (a1b2c3d) · front openrouter/anthropic/claude-sonnet-4.5
```

**`/budget`:** a muted line (`this month`, or `your spend this month` for a member), the label/value rows, then for the owner a
table (`person`, `spent`, `cap`, `left`, muted header, right-aligned figures) that scrolls, and the muted note at the bottom.

**`/help`:** framed sections stacked directly on each other (`FramePanel`, the group in the top border), keys in `accent`, text in
`text`; a key too long for a side-by-side row puts its text under it. Groups: Commands; Keys by screen (Chat, Home, Tasks and other
screens, Manage, Dialogs) including the hidden keys (`[` `]` on Home, `ctrl+o` `ctrl+p` in the chat and on Home: the orb's
roundness); On the core machine. A member's last group is `Settings`. The page scrolls (the wheel, `alt+↑↓`).

### 5.12 States

**Connecting** (no feed yet): the header shows the pulsing glyph and target; the conversation shows the
empty state.

**Empty conversation** (no messages): three muted lines at the top of the conversation, in the
gutter, each short enough for 60 columns. There is no banner and no logo:

```
  Talk to keith.
  It can run tasks in the background and act on your nodes.
  /tasks shows what runs, /help lists the commands.
```

**No model yet** (`roles.front` unset): a warning notice at the top of the conversation. The input
still works (the core answers with its own notice):

```
   ! No model is set yet. On the core machine run:                                  {w}
     keith-core model set front <provider/model>                                    {w, cmd a}
```

**Disconnected:** the cycle is a drop, `reconnecting… (3 s)` for a window of 5 s, `disconnected` for 15 s with the countdown, one attempt of 5 s, and so on. In `disconnected` and `reconnecting` the whole app is read-only: the message is in every title row (the status line, the chat header's title row in narrow and wide mode, the Home title's red glyph with Home's alert caption), the chat's input row is replaced by the same message and `[r] retry now` (the draft is kept), Home's menu, `enter` and `tab`, the dialogs, Manage and the plugin view refuse their keys with the one line `offline: cannot reach the core (<target>, <reason>) · [r] retry now`; `ctrl+c`, `esc`, `ctrl+g`, the movement keys and scrolling stay, `r` retries now (once per 3 s). `logged out` and the locked socket keep their own panels and are never retried blindly.

```
  ✳ KEITH  idle  ✕ disconnected: cannot reach the core (unix:~/.keith/core.sock) · retrying in 12 s   (danger)
  ...messages (scroll still works)...
────────────────────────────────────────────────────────────────────────────────
  ✕ offline: cannot reach the core · [r] retry now · your draft is kept   (the address and error are in the title row)
────────────────────────────────────────────────────────────────────────────────

  ╭─ alert ───────────────╮     K E I T H                                     ✳ disconnected      (Home)
  │ ⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀ │
  ╰───────────────────────╯
            ✕ Cannot reach the core at unix:~/.keith/core.sock
              a refused key here shows, for 3 s: offline: cannot reach the core (...) · [r] retry now
```

**Reconnecting:** this state uses only the header (`◐ reconnecting…`). The conversation stays and
the input works. On recovery a `reconnected` info toast shows for the rest of the turn (as today).

**Logged out / revoked** (401 on the feed, terminal in eharness): the header says `○ logged out`. The input is replaced by the
problem panel and every key except `ctrl+c` is ignored (there is no input to type `/quit` in; `ctrl+c` quits). Home and the chat
draw a `FramePanel` labelled `Sign in` (the chat: `AuthPanel`, `features/identity/auth-panel.tsx`; Home: the login panel of 5.16, which is a
form). The chat's block has a first row `danger`, the reassurance muted, inside the 2-column margins, and `enter` opens the Sign in screen (5.13):

```
  ╭─ Sign in ─────────────────────────────────────────────────────────────╮
  │ This device is logged out or its credential was revoked.        {d}    │
  │ Press `enter` to sign in.                                       {m}    │
  │ Keith reconnects by itself after the login.                     {m}    │
  ╰───────────────────────────────────────────────────────────────────────╯
```

Over the local socket this state cannot happen (the socket needs no login).

**Core unreachable at start:** the same panel, labelled `Core down`, naming the target it tried and both actions, plus the error
as a third row. The header says `○ offline` (the identity call failed and the feed is not live). The legend reads `[ctrl+c] quit`:

```
  ╭─ Core down ───────────────────────────────────────────────────────────╮
  │ Cannot reach the core at unix:~/.keith/core.sock.                {d}   │
  │ <the error of the failed call>                                         │
  ╰───────────────────────────────────────────────────────────────────────╯
```

**Too narrow** (under 60 columns): one muted line, `keith needs at least 60 columns`, inside the same margins (one row down, two
columns in).

**Errors in screens** (a failed list load): a `danger` notice row under the title. The last good
data stays visible.

### 5.13 Sign in (the screen, and `keith login` for scripts)

Signing in is a screen of the app (ADR-0013), not a command that leaves it. The detailed contract (props, the key table of every
step, secrets, how the app wires it) is `tui-login.md`; this section is the look. `keith login` on a terminal, `keith` (also `chat` and `manage`) on a terminal when no core is found, `/login`, `enter` on
the chat's logged-out block open the same screen (Home signed out has its own login panel, 5.16, which draws the same steps). The text command of the second half is
only for scripts.

**The screen** (`features/login`, drawn only through `@keith/ui`) is a `ScreenFrame` labelled `Sign in`, like every other screen:
the title row (`K E I T H` and the `Sign in` tag), the step in a 2-column margin, `▸` selection rows, `Notice` rows for problems, the
pulsing `✳` while it waits and one `[key] label` legend at the bottom (5.9). One step at a time, in this order:

1. **Core address**: a field prefilled from `--core`, else `client.json`, else `http://localhost:7420`. `enter` asks the core
   (`/health`) and shows its version; an unreachable core is a `✕` row with the reason and the field stays
   filled. A `unix:` address is the local socket: the screen says it needs no login and `enter` continues.
2. **Who**: one box (`who`, placeholder `id, username, email or phone`), pre-filled with the identifier last used on this core.
   `enter` asks the core which methods that identity may use from here. A made-up name gets the same screen as a real one.
3. **Method** (the `flow` step): the methods as tabs, `[PIN]` on screen in the accent, the others dim, a refused one marked `!`
   (`tab` and `shift+tab` switch). The core says which one is on screen first: the PIN on the same network, else the password.
   The fields come from the core's description (masked `•` per typed character, never the text, cleared after every submit; a
   PIN takes digits only). A refused method shows `not available here: <reason>` and no field. On the `lan` zone (plain HTTP) a
   `!` warning stands next to a secret: `plain HTTP on this network: others on it could read what you type`. A wrong answer is
   one `✕` line (`sign-in failed: check your id and what you typed`, the same for every identifier); a 429 adds a live
   `try again in N s`; an expired sign-in returns to the box with what was typed.
4. **Device code**: the approve command (`keith-core devices approve KTPW-4C7M --label <name>`, the code unspaced so it can be
   copied), the code in spaced bold letters (`K T P W - 4 C 7 M`), `waiting for approval` and a live `expires in N minutes`; `esc`
   cancels; an expired or denied code shows the reason and `enter` asks for a new one.
5. **Token**: the `Token` tab: one masked field (a `keith_s_` credential), for the case where a token is already in hand.
6. **Done**: `✓ signed in as <name> (<role>) on <core>`, then the app swaps its connection and opens Home with `signed in as <name>`
   in the caption slot.

Colour off (`NO_COLOR`): every state keeps its words and glyphs (`✓`, `✕`, `◐`, `not available here`, the countdown text); nothing
depends on colour. The minimum width is the app's 60 columns (`keith needs at least 60 columns` below it); at 60 columns long
cores, commands and reasons wrap and no row is wider than the screen. Secrets are in no frame, no argument and no environment
variable, and are not echoed by the terminal (Ink owns raw mode).

**`keith login` for scripts** stays plain stdout (no Ink, no alternate screen), so it fits a pipe, a script and the scrollback. It
runs when stdin or stdout is not a terminal, or when a flag asks for it (`--token`, `--password`, `--password-stdin`, `--username`,
`--device`, `--label`); `tui.md` lists the exact rule. It keeps the structure of the old design and drops what plain text cannot do
(a frame, a ticking countdown). The text lives in `login-view.ts`:

```

  keith login  ·  https://keith.tail1234.ts.net

  On the core machine, approve this device:

    keith-core devices approve KTPW-4C7M --label <name>

    K T P W - 4 C 7 M

  waiting for approval · expires in 10 minutes · esc to cancel
```

The code is spaced by one blank for legibility and never drawn with big ASCII letters; the approve command carries the code
unspaced so it can be copied. The countdown is the minutes at the moment the code arrived (a plain line cannot tick).

Results:

- `✓ Logged in to https://… as viandwi24 (device "laptop").` then `Run keith to start.`. The person comes from one `auth.whoami` call
  with the new credential (3 s at most); when the core does not answer, the line is `✓ Logged in to <url>.` without person and
  device.
- Password login: `✓ Logged in to <url> as <username> (<role>).` then `Run keith to start.`; `✕ Wrong username or password.`,
  `✕ Too many attempts. Try again in N s.`, `✕ Password login is only allowed from this machine, Tailscale, or tailscale serve. Use
  a device code instead.` (exit 1). With only `--label` on a terminal the command asks `How do you want to log in?` (select:
  Password, Device code); the password prompt is hidden like the token prompt.
- `✕ The code expired. Run keith login again.`, exit 1.
- `✕ <server error>` (`the owner denied this login`, `cannot reach core at …`), exit 1.
- Esc, Ctrl+C or SIGTERM: `Cancelled.` on stderr, exit 130, nothing saved.

`keith login --token`: a single prompt `Token  ` with the input masked `•` (piped input prints only the result lines), then the same
result line. `keith logout` prints `✓ Logged out of <url>. This device's credential is revoked.`

### 5.14 Step-up dialog and role views

The step-up prompt is the same `Dialog` as 5.7, always focused (`warning` frame and title), in the place of the
approval dialog (above the input on the chat, in the screen region on other screens). The PIN is masked with `•`; `tab`
switches to the password; the last row is the legend:

```
  ╭─ Confirm it's you ─────────────────────────────────────────────────────╮                {w}
  │ This action needs a quick check.                                  {m}   │
  │ ✕ Wrong PIN or password.                                  {d, after a failure}          │
  │ PIN › ••••                                                              │
  │ [enter] confirm    [tab] use password    [esc] cancel                   │
  ╰─────────────────────────────────────────────────────────────────────────╯
```

A dead end (no PIN or password set, an old token) has no input; the last row is `[esc] close` and the danger row
holds the next step (`keith-core people pin <username>`, `keith-core token create`). The chat's legend follows:
`[enter] confirm    [tab] switch method    [esc] cancel` (`[esc] close` for a dead end).

`/budget` for a member is a screen of label/value rows (`Your cap  $5.00 (set by the owner)`, `Spent`, `Remaining`,
`Period`) closed by the muted line `The cap is set by the owner.`. For the owner it adds a `People` block under the
global rows: a muted header row and one `ListRow` (no selection) per person with `person`, `spent`, `cap` and
`left` right-aligned in 9 columns, `no cap` and `-` in muted/plain text. `/help` for a member replaces the
`On the core machine` group by `Settings` with the row `Ask the owner`.

### 5.15 Manage

The Manage screen (`/manage`, `keith manage`, the Home menu's full screens) is a `ScreenFrame` (5.18): label tag ` Manage `,
`K E I T H` centred, the connection status at the right, one legend at the bottom. It hides the sidebar and the strip. The left is the
section list in the Home menu's look (plain rows, `▸` accent and a bold label on the current section, the others dim, no frame, no
fill); the right is the section in a framed pane (`FramePanel`) with the section title in its top border and `n/N` as the right tag.

```
  ╭─ Manage ─╮                       K E I T H                                    ● online

  ▸ Overview               ╭─ People ─────────────────────────────────────────── 2/9 ─╮
    People                 │   USERNAME     NAME        ROLE     STATUS               │
    Groups                 │ ▸ owner        Owner       owner    ● active             │
    Devices & tokens       │   ana          Ana         member   ● active             │
    Nodes                  │   bo           Bo          member   ◐ suspended          │
    Providers & models     │                                                          │
    Access                 │ id owner                                                 │
    Budget                 │                                                          │
    Audit                  ╰──────────────────────────────────────────────────────────╯

  [↑↓] select    [enter] actions    [n] add a person    [r] reload    [tab] list    [esc] back    [?] help
```

- From 100 columns (`TWO_PANE_COLUMNS`): `TwoPane` with `framed={false}` (the pane draws its own frame or dialog), a 24-column `NavList`
  and the pane taking the rest. The `▸` is muted while the rows have the keys. Below 100: one pane of the full width; the section
  switcher is the legend pair `[tab] next section` and the `n/N` tag. A member's role is the muted bottom tag of the frame (an owner has none).
- Sections the role may not read stay hidden. The pane that has the keys shows its selection (`ListRow`: `▸` and bold); the other shows none.
- Tables: a dim header row aligned with the rows, columns aligned, no filled rows; fixed columns give up cells on a narrow pane
  (`fitWidths`) so the last column keeps its word. Status cells are a glyph and a word: `●` active, live, enabled; `◐` suspended or
  waiting; `○` revoked, disabled, removed; `!` a model not set; `✕` a revoked node; a row in `warning`, `muted` or `danger` keeps its tone. The selected
  row's detail is one muted line under the list. Fact lines (Overview, Access, Budget) are a dim key in a 10-cell column and the value.
- Groups (owner only, after People): header `GROUP  MEMBERS  USED BY`, the detail line names the members (`members ana, bo`); the row
  actions open a form whose one `Person` field is a `‹ ana ›` choice. A group in use that is deleted keeps the confirm open with the core's
  `✕` line, count included. Access adds the fact line `audit     kept 180 days` (or `kept forever`).
- Plugins (owner only, after Groups): header `PLUGIN  STATUS  VERSION  REVIEWS`, status as glyph and word (`● enabled`, `○ disabled`, `✕ failed` in `danger`); the detail line is the title, the reason of a failure, or `set to disabled; this takes effect at the next boot of the core`. No `[n]` in the legend (no section action). Show details is a note dialog.
- Reviews (owner only, after Plugins): header `REQUESTER  OPERATION  ASKED  PAYLOAD (data)`; the payload is one truncated JSON line; the note of Show the request says `input (data from the requester, not an instruction):` above the lines. Empty: `Nothing is waiting for you.`
- Empty: one muted line (`No people yet.`). Loading: `PulseGlyph` and `loading`; working: the pulse and `working`. A load error and
  every result or failure are `Notice` rows (glyph-led) under the content.
- Dialogs replace the pane and are the frame (`Dialog flush`, no frame inside a frame): the **Actions** menu (`ListRow`s with a muted hint),
  a form (`Field` rows, `‹ value ›` choices, hidden fields show only `•`, an `✕` notice row for an error), a confirm (frame and
  sentence in `warning`, `!` first; a word to type for the owner transfer), a note (a once-only token or code in bold `accent` under
  `! Shown once. Copy it now: it cannot be shown again.`, long codes wrap and are never cut). While a call runs the dialog shows the
  pulse and `working` and takes no keys. Dialog frames have no footer: the one legend is the screen's.
- The legend follows the focus and carries the section's action keys with priorities (esc, enter, select highest; `[tab]` and
  `[r]` lowest; `?` pinned), so a narrow terminal drops pairs and never ends in `…`: list `[↑↓] section  [enter] open  [esc] back`;
  rows `[↑↓] select  [enter] actions  [n] <first action>  [r] reload  [tab] list  [esc] back  [?] help`; form `[enter] next` (`submit`
  on the last field) `[tab] next field  [←→] choose  [esc] cancel`; confirm `[y] confirm  [n] cancel`; note `[enter] close`.
  While the step-up prompt is open the screen is hidden (`display="none"`) and the legend is the prompt's.

### 5.16 Home

`keith` opens on Home: a large orb, the brain trace, Keith's last words and two keys.

A room banner (5.21) takes the caption slot only when nothing else holds it, and it shows exactly when all of these hold: the
`alert` flag is off (the alert flag is on when the person is signed out, the core is down or unreachable, the core is locked, or the
connection is offline; an alert with no caption still keeps the banner out), there is no panel, no heir line, no notice, and no turn
is running. Otherwise the slot shows the alert caption or the heir line, else the notice, else the subtitle. An
invitation is a Home notice above the caption (`[enter] accept  [d] decline`). The shared pieces live in
`packages/ui` (`src/orb/` is pure and tested; the components wrap it); the screen is `apps/tui/src/features/home/`.

```
  ╭─ thinking ───────────────────────────────╮
  │ ⣿⣿⣷⣤⣀⣀⣴⣿⣿⣿⡿  ○ Thalamus      ○ Wernicke  │      K E I T H
  │ ⠛⠿⣿⣿⣿⠿⠛        ● Broca  ▅   ○ Cortex    │
  │ thalamus › broca                         │
  ╰──────────────────────────────────────────╯

                    ⢀⣤⣶⣿⣿⣿⣿⣶⣤⡀              (OrbCanvas, braille)
                  ⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆
                    ⠙⠿⣿⣿⣿⣿⣿⠿⠋

              Sure, I will check the budget and
                 tell you where it stands.                  (Subtitle, 2 rows)

                 [space] menu    [enter] chat    [tab] ask    (KeyLegend)
```

- **Orb.** `OrbCanvas` draws 46 rings of 132 points, displaced by travelling waves, as braille (2x4 dots per cell) in
  `width x height` cells. `cellAspect` (cell width over height, default 0.5) keeps it round. Five modes, each with its
  own speed, amplitude, voice and colour, eased when the mode changes: `idle` (`orb-idle`), `listening` (`success`),
  `thinking` (`orb-thinking`, swirling), `speaking` (`orb-speaking`, pulsing with a voice), `alert` (`danger`, jittering).
  The colour of a dot fades toward the terminal background (`bg`), not toward black, so the light theme works; its
  brightness is stepped (8 levels) to keep the escapes per row few.
- **Brain frame.** `BrainFrame` is the EKG of `BrainTrace` (a mirrored braille trace, newest at the right, coloured by the
  region that owns the peak) in a btop frame: the status word as a tag in the top border (`╭─ thinking ─╮`). Inside: the
  graph (12 to 36 cells), the two-column region list (`● Broca ▅` lit with a level bar, `○ Cortex` muted) when the inner
  width is at least 46, and a last row with the trail of recent regions (`thalamus › broca`, the newest that fit) or `no activity yet`.
- **FramePanel.** The generic btop frame: rounded corners, tags set into the border (`╭─ Menu ─╮`, bottom tags, a top-right
  tag, a centre label; a `hot` tag paints its first letter in `accent`), body rows as `lines` or as children between `│` sides.
  A frame is always exactly `width` cells; tags that do not fit are dropped (right, then centre) or clipped, body rows are clipped.
- **Subtitle.** `Subtitle` takes the text Keith is saying, wraps it (hard-breaking a word longer than a row), keeps the
  newest 2 rows and centres them, always taking 2 rows of height. The text is typed out (90 characters per second, faster
  when far behind); a text that continues the last one keeps its progress, any other restarts it, `''` clears.
- **KeyLegend.** `[space] menu    [enter] chat    [tab] ask`: the key in brackets in `text-muted`, the label bold, 4 spaces between pairs (5.9: the one legend of every screen, fitted by priority).
- **Clock.** `useFrameClock({ fps = 12, running })` is one `setInterval`; fps is capped at 30 and the timer is stopped
  while `running` is false. Pass the same `clock` to `OrbCanvas`, `BrainFrame` and `Subtitle` so a screen has one timer.
  Measured: `OrbCanvas` 100x40 at 12 fps costs about a fifth of a core under Ink (the model itself under 1 ms a frame).
- **Depth.** truecolor: smooth; 256 and 16: the same picture with colours quantised (cube or grey ramp, then the 8+8 ANSI
  codes); `none` (`NO_COLOR`): no animation and no escape code: the orb is a static `● <mode>` centred in its box, the
  brain frame is plain text, the subtitle shows its whole text at once. A mode is never colour alone.
- **Sizes.** Home hides the brain frame below 80 columns and the subtitle below 14 rows (the screen decides; the
  components take the size they are given). The orb fills the rows left (1 margin row top and bottom, the title row, a gap,
  the 2-row caption slot, a blank row, the legend) up to 48 rows, a bound on the cost of rewriting its braille at 12 fps; its width
  in cells is `height / cellAspect`, so it is round for the terminal's real cell shape. One spare row stays free under the
  orb (from 14 rows) as a gap before the caption slot.
- **Title row.** `✳ K E I T H` centred; the `✳` carries the connection (5.2) and a word follows only when not online. The facts that used to sit here are in the menu.
- **Menu boxes.** Overview: connection, core version and status, you, front model. Budget: spend over limit this month, what
  is left, and the `!` warning. Audit: its description and `→ open` (the app holds no audit rows).
- **Caption slot.** Under the orb there is one slot of 2 rows (1 row below 14 rows) plus the blank row before the legend.
  The orb's size depends on the terminal rows, columns, the cell aspect and the alert's rows (`homeSize`), never on the rest of what
  the slot shows. Whatever Home says is drawn into the slot, one thing at a time, in this priority: the alert state (up to 4 rows: a
  message that wraps past the slot takes the extra rows from the orb, so the legend stays on screen), then the failed-approvals notice
  (hidden while the core is down), then any other notice, then `dreaming…` (muted, centred) while a dream runs, then the subtitle. The dialogs
  (approval, step-up) and the menu are absolute overlays over the orb and never resize it.
- **Fixed orb box.** The orb sits in a slot of `homeSize.areaRows` rows (`flexShrink 0`, no `flexGrow`) in a box of exactly
  `orbWidth` x `orbHeight` cells at `orbTop`/`orbLeft` (explicit margins, no centring that rounds). Width, height and
  position are the same from the first frame and in every state (modes, alert, ask prompt, subtitle of 0 to 2 rows, notices,
  dialogs, menu, legend changes); the ask row, legend and every other part live in rows reserved up front or overlay
  absolutely. `home-orb-size.test.tsx` paints Home in each state and checks the box.
- **Alert caption** (core down): no frame; two rows centred like the subtitle. Row 1 in `danger`: `✕ Cannot reach the core at <address>`;
  core down is the error row alone, no tip. When row 1 does not fit the width the address is shortened in the middle (`http://127.0.0.1:…:7420`): never a third row. The orb is `alert` and keeps moving. The chat keeps its framed
  `Sign in` / `Core down` panel (5.12). Signed out has no caption: it has the login panel below (the caption's `○ Signed out` and
  `Press enter to sign in` stay only where the panel cannot be drawn, e.g. over the local socket).
- **Login panel** (signed out, `features/login/login-panel.tsx`): a `FramePanel` labelled `Sign in`, drawn like the approval dialogs
  (absolutely, over the lower orb, at most 56 cells wide (`loginPanelWidth`; never wider than the terminal minus 4), centred on the axis of the orb and the
  legend; the content wraps inside it), so the orb never resizes. The orb is `alert` and keeps moving.
  It shows the same steps as the Sign in screen (5.13) with no address step (the core is the one that said 401):
  ```
  ╭─ Sign in ──────────────────────────────────────╮        ╭─ Sign in ──────────────────────────────────────────╮
  │ ▸ who   id, username, email or phone           │        │  Device code   [PIN]   Password    Token           │
  ╰────────────────────────────────────────────────╯        │ ▸ PIN                                              │
        [enter] next                                        │ [ ] remember for 30 days  (ctrl+r)                 │
                                                            │ ! plain HTTP on this network: others on it could   │
                                                            │   read what you type                               │
                                                            ╰────────────────────────────────────────────────────╯
                                                              [enter] sign in    [tab] method    [esc] back
  ```
  Above the frame, when `client.json` holds a login that was not remembered, one compact centred box on the `user-message` fill (wrapped to the frame width), a single muted sentence: `An old saved login (from before sign-in existed) is not used. Sign in below, or press ctrl+f to forget it.` Under the fields of a PIN or password,
  `[ ] remember for 30 days  (ctrl+r)`, one line (`tui-login.md`, "Remember this device").
  One box at first (pre-filled with the identifier last used on this core); `enter` shows the method the core marked `default` for this
  client's zone (the PIN on `loopback`, `lan` and `tailscale`, else the password) with the other methods as tabs (`tab` and `shift+tab`;
  a refused one is `!`-marked and shows the core's reason). The warning line shows on the `lan` zone only. PIN and password are masked
  (`•`), never drawn, cleared after each submit. `esc` goes back one step (method to box; nothing behind the box). The legend is the
  one the step asked for (`useFooter`), drawn in Home's legend row; while the panel is up the menu (`space`), the quick ask (`tab`)
  and the chat (`enter`) keys are off (the panel owns the keys). On success the app swaps its connection and Home opens signed in
  with `signed in as <name>` in the caption slot.
- **Privacy panel** (the first-login notice, once per person, `features/identity/privacy-notice.tsx`): a `FramePanel` titled `Your privacy`, at most 46 cells wide (never wider than the terminal), drawn over the lower orb like the login panel, its text wrapped inside. Body: the core's notice (two sentences); legend `[enter] got it`. Home's orb, wordmark and status stay drawn; the menu and the quick ask are off while it is up.
  ```
                   ╭─ Your privacy ─────────────────────────────╮
                   │ The owner of this Keith can read what you  │
                   │ keep in it. Each time they look, Keith     │
                   │ writes it down: see Manage > Privacy.      │
                   ╰────────────────────────────────────────────╯
                                   [enter] got it
  ```
- **Legend.** `[space] menu    [enter] chat    [tab] ask`; while a turn runs `[space] menu    [enter] chat    [tab] ask    [esc] stop` (priorities `esc`
  90, `enter` 80, `space` 70, so a narrow terminal drops the menu first). `esc` on Home stops a running turn and does nothing
  when idle; `ctrl+g` in the chat brings the user here with the turn still running.

- **Logout.** The last entry of the menu, directly below Help with no blank row (a menu taller than the terminal scrolls to keep the selection visible): `Logout`, for every signed-in person; `enter` or `→` runs `/logout`. **Offline** (5.12) the menu still opens but every leaf except Logout is `text-muted` (groups still open; their leaves are dimmed the same way) with no `▸`/bold on the selection, the legend dims `enter chat` and `tab ask`, and `[r] retry now` joins it; `→` and `enter` on a dimmed entry show the one-line `offline:` hint, Logout works (it needs no core).
- **Signed-in line.** The notice slot under the orb (`signed in as <name>`, one muted line) is centred on the same axis as the orb and the legend; a longer notice keeps its left edge. No slash command is named in it.

- **Menu levels.** The menu has two levels: `Overview`, then the groups `People & access` (People, Groups, Devices & tokens, Access), `Apps`, `Models & budget` (Providers & models, Budget) and `System` (Nodes, Privacy, Audit, Tasks, Brain trace), then `Help` and `Logout`. A group row ends with a muted `▸`; `enter` or `→` opens its submenu in the same box (the group's title as a muted first row), `←` or `esc` goes back onto the group, `esc` at the top and `space` anywhere close the menu. Reopening starts at the top. The legend adds `[←] back`.
- **Plugin entries.** The `Apps` submenu lists the views the core sent (`GET /plugins/tui/menu`, already filtered for the person) first, then `Plugins` and `Reviews` (the manage sections); `enter` or `right` opens the view (5.19). No views: `Apps` is just those two.

- **Quick ask.** `tab` opens a one-line input in the blank row between the caption slot and the legend (the slot keeps its
  two subtitle rows, so the reply stays visible and the orb never resizes; below 14 rows it takes the one caption row).
  Plain `TextInput`, placeholder `ask keith…`, no prompt mark, centred, at most 76 columns. Legend while open
  `[enter] send    [esc] close` (priorities 90, 80); closed, `[tab] ask` (priority 60, dropped first). `esc` closes the
  prompt only. A long reply is read in the chat (`[enter] chat`). Works with `NO_COLOR` (text only).

- **Motion: the intro and the idle hide.** The terminal has no opacity, so a fade is the foreground colour blended toward the
  theme background (`bg`) in steps (`Reveal`, `fadeTheme`, `useFade` in `packages/ui`; colours stay theme tokens).
  | Depth | Fade |
  | --- | --- |
  | `truecolor` | smooth: 10 steps (`#rrggbb` blended per step) |
  | `256` | coarse: 4 steps, each blend mapped to the nearest xterm-256 colour |
  | `16`, `none`, or reduced motion | none: a part is there or not, at once. `none` never passes a colour prop. |

  *Intro.* The first Home that mounts in a process reveals, each part fading in over 350 ms and starting 300 ms after the
  previous (about 1.25 s in all): the orb, then the wave graph (the brain frame), then the legend, then the `K E I T H` title with
  the status mark. Any key skips it (the key is not swallowed: it also does its job). A Home that mounts again (back from the chat,
  a swapped connection) shows everything at once. Off with `KEITH_INTRO=0`.
  *Idle hide.* After `idleHideSeconds` (default 60; `KEITH_IDLE_HIDE_SECONDS`, `0` never hides) without a key, the graph, the
  legend, the title and the status fade out over 300 ms; the orb, the caption slot (subtitle, alert lines, notices) and every
  dialog stay. The next key, or a wheel notch, fades them back in; that key is swallowed: `enter` does not open the chat, `space`
  does not open the menu, and `ctrl+c` is never swallowed. Only Home hides: the chat, Manage, the dialogs and the other screens never do.
  Nothing hides, and the timer is reset, while an approval or step-up dialog is up, the login or unlock panel is up, the core is
  down or the session logged out (`alert`), a notice or failed-approvals line shows, a turn runs or the user is typing, or the menu or
  the quick ask is open; if it was hidden when one of these appears, it comes back.
  *Still orb.* With `--disable-orb` (`KEITH_DISABLE_ORB`, the motion context's `orbStatic`) the orb is one fixed frame: the same
  shape in every state, drawn with no timer, no waves and no intro of its own (it is there at once, the other parts keep their
  intro). Its colour changes at once with the state (`alert` on a lost core, `thinking` while a turn runs, and so on). Every orb
  draws it: Home, the chat's sidebar orb and the header orb. The Home flight is skipped (a plain switch, below).
  *Cost.* One one-shot timer (`Scheduler.after`) while Home is shown and unblocked; none while hidden or blocked. A fade runs
  one timer per fading part, at most one tick per step (33 ms or more), and clears it the tick the level arrives, so a settled
  Home adds no timer and no redraw beyond what the orb itself needs. Settings and reduced motion: `tui.md` (Home).

### 5.17 Chat header

The chat's top 9 rows from 80 columns and 20 rows (`ChatHeader` in `packages/ui`, `layout.header`); the prototype's chat view.

With a room (5.21) one banner row sits under the header, in the chat column's width (`● Room "Planning" · Ana, Duta, Keith · /room`).

```
  ⣀⣀⣤⣤⣀⣀
 ⢀⣴⣿⣿⣿⣿⣷⣄   ✳ KEITH  thinking                                  ● online
⢀⣿⣿⣿⣿⣿⣿⣿⣿⣆                                  ● Thalamus  ▃  ○ Wernicke
⢸⣿⣿⣿⣟  ⢘⣿⣿⣿                              ⢸⣿  ○ Broca        ○ Cortex
⠈⣿⣿⣿⣿⣶⣶⣾⣿⡟                              ⢸⣿  ○ Motor        ○ Amygdala
 ⠈⠿⣿⣿⣿⣿⠏                                     ○ Ras          ○ Hippocampus
   ⠈⠛⠿⠿⠛⠉   thalamus › cortex
  ...messages...
────────────────────────────────────────────────────────────────────
  ✻ type a message, or /help
────────────────────────────────────────────────────────────────────
  [enter] send    [shift+enter] newline    [ctrl+b] sidebar    [esc] home    /help
```

- **Orb**: `OrbCanvas` 14 x 7 at the left (2 columns in), live, in the mode colours (static `● <mode>` without colour).
- **Title row**: the pulsing glyph (`· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢`, 8 steps a second, from the wall clock so the title and the prompt agree;
  `✳` still without colour) coloured by the connection (`success` online, `warning` connecting or reconnecting, `danger` offline or logged out), `KEITH`
  bold, the mode word muted, then the connection word only when not online (always without colour); at the far end the
  `elevated` countdown.
- **Wide mode** (100 columns, 40 rows, sidebar shown): the header is the `title` variant: this title row and a blank one. The orb, the
  graph and the region lamps are in the sidebar (section 4, 5.10).
- **Sidebar column**: from 100 columns the sidebar starts on the very top row, level with this title row, and runs the full
  height of the screen down to the margin row, past the input and the legend; the header (and its region list, sized from the left
  column), the conversation, the input's two rules and the legend all live in the left column and are as wide as it (5.1, 5.9).
- **Brain rows**: `BrainFrame bare`: the graph (4 braille rows, at most 36 cells), the two-column region list (six rows) beside it when
  there are 46 cells, and the trail of recent regions (or `no activity yet`).
- **Replaces** the status line and the sidebar's Brain panel. Approvals, step-up, notices, scrolling and
  markdown are as in 5.3 to 5.7. Below 80 columns or 20 rows the compact layout of 4 and 5.2 stays.
- **Input**: 5.8; the pulsing glyph is the prompt. It sits between two bare rules and the legend is 5.9's, its own row
  below them; where the left column is too narrow the lowest-priority hints are dropped (never cut with `…`).
- **Flight**: Home to chat (`enter`) and back (`esc`, `ctrl+g`) move the orb between its two boxes in 4 eased frames 75 ms apart (13 fps),
  the orb alone, then the screen shows; no key is held. Skipped without colour, and under `--disable-orb` (a plain switch).
- **Cell aspect**: the header's orb takes the same `cellAspect` as Home (detected, `KEITH_CELL_ASPECT`, or 0.46).

### 5.18 Frames and the screen frame

**FramePanel** (`packages/ui/src/frame-panel.tsx`, pure text in `orb/frame-text.ts`) is the one frame. Panels, dialogs, blocks, the
detail pane of a two-pane screen and Home's brain frame all draw through it.

```
╭─ Tasks ─────────── 2 running ─╮     top tags: left (the label), centre, right (a count or a status)
│ body rows                      │     sides `│` in `border`; body as strings (`lines`) or as children
╰─ +4 more /tasks ───────────────╯     bottom tags
```

- Rounded corners `╭╮╰╯`; a tag is ` text ` (a space each side, no `┤├`), tags are joined by `─`. A `hot` tag paints its first letter in
  `accent` (the letter is a hotkey). Tags that do not fit are dropped (right, then centre) or clipped; body rows are clipped. A frame
  is always exactly `width` cells.
- `tone` (`warning`, `danger`, `info`, `success`, `accent`) colours the border and the tags: a dialog that has the keys, a problem block.
  Without it the border is `border` and the tags `text`. Without colour the tone is lost, so the label says what it is.
- `padX` puts columns between a side and the children; `grow` makes a children frame take the height its parent gives it.

| Component | Draws |
| --- | --- |
| `Panel` | a sidebar frame: title tag, count tag at the right, `+n more` tag below |
| `Dialog` | the approval, step-up and manage dialogs: title tag, `1 of N` tag, `warning` tone while focused |
| `Block` | the logged-out and core-down block: label tag (default `Problem`, `Notice`, `Info`), tone by level |
| `TwoPane` | the detail pane of a two-pane screen: the section's label as its tag |
| `BrainFrame` | Home's brain frame: the status word as its tag |

**ScreenFrame** (`packages/ui/src/screen-frame.tsx`) is a full screen: one blank row, the title row, a blank row, the content, a blank row,
the legend, one blank row; a 2-column left margin.

```
                                                            (blank margin row)
  ╭─ Manage ─╮               K E I T H                  ● online      title row
                                                            (gap)
  content                                                           children: width - 2 columns
  ...
                                                            (blank row)
  [↑↓] select    [enter] open    [esc] back    /help                  legend
                                                            (blank margin row)
```

Props: `width`; `height` (omit it to take what the parent gives); `label` (the corner tag, hidden on a row too narrow for it and the
name); `status` (a `StatusInfo`: the connection and the countdown); `legend` (hints, dropped by priority to fit `width - 4`, or one sentence in
`warning`); children. `TitleRow` is the title row alone (the compact `StatusLine` uses it) and `SCREEN_CHROME_ROWS` (6) is what a
screen with a legend spends outside its content.

### 5.19 Plugin view

A plugin's view is a `ScreenFrame` (5.18) whose label tag is the menu entry's label. The content area is `width - 4` columns by `rows - 6`
rows; the view's lines fill it from the top, one terminal row each, cut at the width (never wrapped; the view lays itself out for the size it was
asked for). The legend is `[esc] back    [ctrl+g] home` (plus `[r] reopen` once the view ended where a reopen can work).

```
  ╭─ Notes ─╮                 K E I T H                  ● online
                                                           (gap)
  Notes (3)  /search                                       the view's own screen, drawn by StyledLines
  ▸ buy milk
    call the dentist
                                                           (blank row)
  [esc] back    [ctrl+g] home
```

States: connecting (`connecting…` muted), open (frames), ended (the last frame stays, a blank row, then a `Notice`: `info` when the view exited, `warning` for every other reason).
The colours of a view are data from outside the theme: `StyledLines` (`@keith/ui`) is the only component that draws them, passes none in `none` depth, and never receives an escape
(the client's parser already dropped it). A plugin that wants the app's look reads `useTheme()` on the server and gets the same tokens. Home's menu lists the entries in its `Apps` submenu (5.16).

### 5.20 Toast

A short message in the top-right corner of the screen, over whatever is shown (Home, chat, manage, sign in). It is for a
fact the person caused and may miss while looking elsewhere (`signed in as Ana`, `unlocked`, `The old saved login is forgotten.`);
conversation notices (5.6) stay as they are.

```
                                              ✓ signed in as Ana
```

- **Place.** `ToastStack` is one absolutely positioned box starting at row 2, right-aligned with the 2-cell gutter. Row 0 is the margin and row 1 is the title row with the connection mark (`✳ online`, `✳ logged out`; in the wide chat the mark sits in the main column's title row), so a toast never covers the indicator; it may cover the top right of the content below (the wide chat's tasks frame, a manage pane), and never the legend (a toast is at most 4 rows high, 2 under 20 terminal rows; the stack holds at most 3 toasts). It never moves
  or resizes the layout under it and has no input handler, so it never takes a key (a toast cannot be dismissed or answered).
- **Look.** One compact filled box per toast (the `user-message` fill, as in `Message`): a level glyph, then the text.
  Glyph and tone by level: `info` `·` in `info`, `success` `✓` in `success`, `warning` `!` in `warning`, `error` `✕` in
  `danger`. The text wraps on words to `min(40, columns - 6)` cells including the box, at most 4 rows (2 rows on a terminal under 20
  rows); the last row ends with `…` only when the text is longer; a long unbroken token is cut at the width. Continuation rows are
  indented under the text (`wrapLines`).
- **Count.** At most 3 at once, newest last; a fourth drops the oldest at once. A toast's rows are not the layout's: it stays an overlay
  and moves nothing under it.
- **Time.** A toast stays `ms` (default 5000), fades out over 300 ms, then is removed. It fades in over 150 ms. Both use the
  fade engine (`useFade`, `Reveal`): truecolor 10 steps, 256 colours 4 steps. In `NO_COLOR`/16 colours and with reduced motion
  there is no fade: it appears and disappears at `ms`. The glyph carries the level where there is no colour.
- **Timers.** `ToastProvider` owns them on the `MotionProvider` scheduler (tests drive it with `manualScheduler`): two
  one-shots per toast, none while there is no toast, all cleared on unmount. `useToast().push(text, { level, ms })` returns an id
  for `dismiss(id)`; without a provider `push` does nothing.

### 5.21 Room

A shared room (`docs/specs/corpus-callosum.md`; `tui.md`, "Room"). Three parts: the banner row, the room view, and the
invitation notice (Home, 5.16).

**Banner.** One row on Home (in the caption slot, only while no alert, panel, heir line or notice holds it and no turn runs: see
5.16) and in the chat, drawn by
`RoomBannerRow`: `● Room "Planning" · Ana, Duta, Keith · /room`, `accent` while the room is active; `○ Room "Planning" ·
waiting for Duta · /room`, `text-muted` while only invitations are out. It is cut at the end, never wrapped.

**Room view** (`/room`, a framed screen labelled `Room`, `Esc` back to Home):

```
  Room
  Planning
  ● Ana  ● Keith  ○ Duta (invited)
  Ana      what should we cook?
  K Keith  Pasta, maybe. Or the soup from last week.
  · Duta joined
  ◐ Keith is thinking…
  ╭─ Confirm ────────────────────────────────────────────────────────────────────╮
  │ Remove Duta from the room? [y] [n]                                           │
  │ tab to answer                                                                │
  ╰──────────────────────────────────────────────────────────────────────────────╯
  › message the room
  [esc] back to Home  [ctrl+l] leave  [tab] confirm
```

- **Title and members.** The room's name in bold; `· ended` or `· left` after it. The member row lists the active members
  and the invited ones (`(invited)`), then Keith. The dot is the presence: `●` `success` online, `◐` `warning` busy, `○`
  `text-muted` offline or not shared. Keith's dot is always online.
- **Transcript.** A 12-cell name column, then the words. A member's line is plain text; Keith's line is `K Keith` in accent
  with the words as Markdown. A join, leave, remove, end or handoff is one muted row with `·` (a handoff reads `Ana asked in
  their own chat`; its request stays in the speaker's chat). It scrolls like a conversation (the latest line sticks; `End`).
- **Indicator row.** One row under the transcript: the pulsing glyph and `Keith is thinking…`, `Keith is answering Ana…` or
  `Duta is typing…`. Empty when there is nothing to show; the row is kept so nothing moves.
- **Confirmation bar.** One at a time, the oldest. Its question carries `[y] [n]` (`Remove Duta from the room? [y] [n]`,
  `End the room "Planning"? [y] [n]`, `Share this with Planning? [y] [n]` with the post text quoted under it, cut at 80
  characters). It is shown to its confirmer only. The keys are given only after `tab`, like the approval bar: a plain `y` or
  `n` is typed into the input and answers nothing. Focused, the frame and title turn `warning` and the last row is
  `[tab] back`; unfocused the last row is `tab to answer`. `tab` or `esc` gives the keys back. While the bar has the keys the
  page legend is empty.
- **Input line.** `›` in accent and the input. The placeholder is `message the room`, or `reply to Keith` when the last line is
  Keith's (the message then goes with `replyToKeith`). A room that ended or that the person left has no input: the line reads
  `The room has ended. Its transcript stays readable.` or `You are no longer in this room.`.
- **Offline.** The input row is the offline line (`✕ offline: … · [r] retry now · your draft is kept`, as in the chat input) and the legend
  dims everything but `esc`, the movement keys and `[r] retry now`; a refused key shows the `offline:` toast (`useGuardedInput`).
- **Legend.** `[esc] back to Home`, `[ctrl+l] leave` (while the person is in the room and it is not ended), `[tab] confirm`
  (while a confirmation waits). Leaving keeps the view open with `You are no longer in this room.`.
- **Failures.** A failed send, leave or answer is an error notice under the bar (`Failed to send: …`); a failed read keeps
  what the view had and shows `Failed to load the room: …`.

**Invitation.** A toast `Ana invites you to a room with Keith.` when a new invitation arrives, and the Home notice of the same
text with the keys: `[enter] accept  [d] decline` (5.6). Accepting opens the room view; declining says `Declined.` in a toast.

## 6. Interaction

### 6.1 Focus model

One owner of the keys at a time, in this order of precedence:

1. **Logged-out block**: only `ctrl+c` / `/quit`.
2. **Approval dialog**, only after `tab`: `y n N a`, `tab`/`esc` back. It gives the keys back by
   itself when nothing waits.
3. **Screen** (`/tasks`, `/nodes`, `/brain trace`, `/help`): its own keys; `esc` back.
4. **Input band** (the default): text, `enter`, `esc` stops a busy turn (idle: goes Home), `ctrl+g` goes Home.

Global keys work in every state but 1:

- `ctrl+b` toggles the sidebar (this changes `tui.md`: it was the brain panel; `/brain` keeps
  toggling the brain panel inside the sidebar);
- `ctrl+t` toggles the tasks panel;
- `ctrl+g` goes Home from the chat at any time (a running turn keeps going);
- the mouse wheel, `alt+↑` / `alt+↓` and `end` scroll (6.3);
- `ctrl+c` quits.

A chat message never answers an approval (`tui.md`).

### 6.2 Key hint format

Everywhere: `[key] label`, the key in `text-muted` inside brackets, the label bold, 4 spaces between pairs (2 when the row is
tight), dropped by priority and never cut (5.9). Words, not symbols: `[esc] back`, not `⎋`. One hint list per context lives in the
feature (`app-hints.ts`), and the legend renders it through `<KeyHints width>` or `<FooterRow>`.

### 6.3 Scrolling

The conversation is an Ink scroll view (`overflow="hidden"` + `contentOffsetY`, measured with
`useBoxMetrics`, the pattern from Ink's README). It sticks to the bottom while the user has not
scrolled. Every `ScrollView` (the conversation, Help, Trace, Tasks, ...) scrolls with:

- **the mouse wheel**, 3 lines a notch (as terminal coding agents do);
- `alt+↑` / `alt+↓`, one line;
- `end`, back to the latest row (sending a message does too);
- `pgup` / `pgdn`, half a viewport: a silent fallback, never in a legend, hint or help text.

While scrolled up in the chat a one-line pill `↓ latest [end]` shows under the messages (`↓ new messages [end]` when something
arrived); a top-anchored page (Help) says `↓ more · scroll` while more is below. Only the last 200 messages are mounted.
Older ones are reached with `/history` later (not in P8). List screens keep the selected row visible.

**The wheel.** Ink has no mouse API and drops the mouse sequences it receives, so the app turns on SGR mouse reporting itself
(`ESC[?1000h ESC[?1006h`) and reads the wheel events (`ESC[<64;x;yM` up, `ESC[<65;x;yM` down; every other button, motion,
click and release is ignored). It does so in front of Ink: `stdin.read` of the TTY is wrapped so that Ink's own `readable`
loop receives the text without the mouse reports (an extra `data` listener would switch the stream to flowing mode and starve
Ink). Wheel events reach every active `ScrollView` through a small bus in `packages/ui`. Mouse reporting is switched off on
exit, on an uncaught error, on `SIGINT`, `SIGTERM` and `SIGHUP`, and before the terminal is handed back; the terminal is never
left in mouse mode.

**`/mouse`.** Mouse capture blocks the terminal's own text selection. `/mouse off` switches reporting off so selecting and
copying work as usual (no wheel scrolling then); `/mouse on` brings it back; `/mouse` alone toggles. Holding `shift` (`alt` in
some terminals) while dragging selects text with the mouse on. The state lasts for the session. `/help` says so.

### 6.4 Wrapping and markdown

- Prose wraps at word boundaries to the prose width (conversation width minus gutter and indent;
  there is no cap: the conversation column fills the room beside the sidebar). Width is measured with `Bun.stringWidth` (Bun first, rule 11).
- Code blocks (fenced) have no paint and no frame: a muted `│` gutter on every row. The language tag is
  muted on the first row, right-aligned. Lines are **not** wrapped: they truncate with `…` at the
  edge, so copy-paste of a visible line stays correct. A block longer than 30 lines shows 25 and
  then `… n more lines`.
- Inline code: an `accent` word with no backticks and no paint. Without colour (`none` depth) the backticks stay.
- Markdown scope:
  - headings: `#`–`###` are bold, with no `#` drawn and one blank row before them; deeper levels
    are bold;
  - lists: `-`/`*` render as `•` (indented 2); numbered lists keep their numbers;
  - `**bold**` is bold, and `_em_` stays plain text;
  - links show as `text (url)` with the url muted;
  - block quotes get a muted `│` gutter;
  - tables are passed through as plain text when they fit, and otherwise as a code block;
  - images and raw HTML are shown as their text.
- No syntax highlighting in P8 (one accent rule). A later version may add a muted 3-colour scheme.

## 7. Ink 8 implementation notes

Ink 8.0.0 (the catalog version) supports everything this design needs. This was checked against the installed `ink/readme.md` and
`build/styles.d.ts`.

| Effect | Ink API |
| --- | --- |
| frames | `FramePanel`: the top and bottom edges are `Text` rows built by `orb/frame-text.ts` (the tags are in the string); the sides are a `Box` with a custom `borderStyle` that has only `│` left and right (`borderTop`/`borderBottom` off) |
| muted text | `color={t.textMuted}`. Use `dimColor` only in `none` depth, where it is the only tool (dim on a truecolour grey is too faint) |
| selection | an accent `▸` cell and `bold`; no background, no `inverse` (the one `inverse` is the text cursor) |
| right-aligned and centred rows | `position="absolute"` children in a one-row `Box` (the title row), `<Spacer/>` or `justifyContent` |
| truncation | `<Text wrap="truncate-end">` (legends are not truncated: they drop whole pairs) |
| scroll view | `overflow="hidden"`, `contentOffsetY`, `useBoxMetrics` on a `flexShrink={0}` content wrapper |
| size | `useWindowSize()` (re-renders on resize) |
| paste | `usePaste` (bracketed paste; pasted text never reaches `useInput`) |
| full screen | `render(..., { alternateScreen: true, incrementalRendering: true })`; `maxFps` stays 30 |
| colours | `#rrggbb`, `ansi256(n)` or a chalk name: Ink's `colorize` accepts all three; frame edges carry their own escapes from `frame-text.ts` |

Limits to respect:

- A frame needs a width: give `FramePanel` the cells it has (the sidebar's width, the left column's minus the gutter).
- Borders add 2 columns and 2 rows. Account for them in a dialog's height.
- `measureElement` / `useBoxMetrics` read 0 during the first render. The scroll view clamps on every render.
- `<Static>` is not used: it prints above the app and cannot sit beside a sidebar.

### Shared components (`packages/ui/src/`, `@keith/ui`)

Features use only these components (plus `Box`/`Text` for plain layout without colour). A feature
never passes a colour string, a `borderStyle` or a `backgroundColor`; nothing in the app is painted except the user message (`Message`). `check-imports` can enforce
this later with a pattern on `features/**`.

| Component | Responsibility |
| --- | --- |
| `theme.ts` | the token tables (dark, light) and `resolveTheme({ theme, depth }) → Theme` (pure; tested) |
| `ThemeProvider` / `useTheme()` | context with the resolved `Theme`, `depth`, `spinner: boolean` (lets `PulseGlyph` animate) |
| `Reveal` / `useFade` / `fadeTheme` / `blend` | a fade-in or fade-out of its children by colour depth (5.16 Motion); `MotionProvider` carries the `Scheduler` (injectable; `manualScheduler` in `@keith/ui/testing`) and reduced motion; the orb and glyphs read the level (`useFadeLevel`) |
| `Surface` | a padded region (`pad`): nothing painted, nothing drawn |
| `StatusLine` / `StatusInfo` | the compact header (`TitleRow` without a label); `StatusInfo`: connection and `elevated` countdown |
| `TitleRow` | the title row of a screen: label tag left, `K E I T H` centred, status right |
| `ScreenFrame` | a full screen: margins, `TitleRow`, content, one legend (5.18) |
| `FramePanel` | the one btop frame: `width`, `top`, `topRight`, `center`, `bottom` tags, `tone`, `padX`, `grow`, body as `lines` or children |
| `KeyLegend` / `KeyHints` | `[{ key, label, tone?, priority? }]` / `[{ key, action, tone?, priority? }]` → `[key] label` pairs, fitted to `width` by priority |
| `Message` | `kind: 'user' \| 'assistant' \| 'proactive'`, `streaming`, children; user: marker, indent and the `user-message` fill across the width; the others nothing painted |
| `ToolLine` | glyph, label, summary, right-side state, optional output lines |
| `StyledLines` | the lines of a plugin view as styled runs (5.19): `lines`, `width`, `height`; the one place an outside colour is drawn |
| `ToastProvider` / `useToast` / `ToastStack` | the toast (5.20): `push(text, { level, ms })` owns the timers, the stack draws the top-right overlay |
| `wrapLines(text, width, maxLines)` / `alertLinesOf(rows)` | the rows of a top alert, toast or caption (5.2, 5.20): word wrap, a long token cut, `…` on the last row past `maxLines`; the line cap (4, or 2 under 20 rows) |
| `Notice` | `level: 'info' \| 'warning' \| 'error'`, rows; a glyph-led row |
| `Dialog` / `Chip` | the approval frame: title, count, rows, `focused`, footer (a `FramePanel`); `dialogInner(width)` is a row's width |
| `Panel` | sidebar frame: title, count, `more`, `width`, rows |
| `ListRow` | a row of columns: `selected` is `▸` and bold, the others muted |
| `Badge` | glyph + word in a tone (`● online`, `✕ logged out`, `◐ Cortex ×2`) |
| `PulseGlyph` | the activity indicator: `mode` (an orb colour) or `tone`, `running` |
| `Markdown` | the subset in 6.4, built on `Text`/`Box` (no new dependency) |
| `ScrollView` | the sticky-bottom scroll view in 6.3 |
| `TextInput` | the existing input, made multiline (`shift+enter`, `alt+enter`, `ctrl+j`), with `usePaste` and the cursor cell |
| `Screen` | the old screen shell: a bold title row, blank row and gutter, used until a screen adopts `ScreenFrame` |
| `Block` | a framed block in a level colour with its label in the border and rows in their own tones (logged-out, core down) |
| `Field` | one form row: label, then a text input, a hidden input (`•` only) or a choice `‹ value ›`; `▸` marks the focused one |
| `NavList` | the section list of a two-pane screen; the current item is `▸` bold (accent while it has the keys, muted while the other pane has them) |
| `TwoPane` | a navigation pane of plain rows and a framed detail pane (`label` in its border) that takes the rest |
| `Rich` | text where `` `commands` `` and `/words` are accent; the backticks stay without colour |
| `OrbCanvas` | the voice orb as braille rows: `mode`, `width`, `height`, `cellAspect`, `running`, `fps`, `clock`; static `● mode` in none depth |
| `BrainFrame` | the framed EKG: `trace` (a `BrainTrace`), `width`, `status`, `graphRows`, `running`, `regions`, `bare`, `clock` |
| `ChatHeader` | the chat's top 9 rows: `mode`, `trace`, `width`, `running`, `clock`, `cellAspect`, `right` (5.17) |
| `Subtitle` | centred, typed-out words under the orb: `text`, `width`, `maxRows` (2), `cps` |
| `useFrameClock` | one timer for an animation: `{ fps = 12 (max 30), running }` → `{ tick, dt }` |
| `FooterProvider` / `useFooter` / `FooterRow` / `LegendRow` | the legend: a screen or dialog sets its hints while mounted, the app shows them (or its own for the chat); `rule={width}` draws them as the separator line above the input, `width` fits them |

The glyphs live in `packages/ui/src/glyphs.ts`, one object. `tasks-state.ts` and `nodes-state.ts` import their
icons from it.

Notes from the build:

- The chat stays mounted while a screen is open (`display="none"`): the stream, the draft and the
  scroll position survive `/tasks` and back.
- `ink-testing-library` fixes the terminal at 100 columns and gives no rows, which would break the
  full-screen layout at any other size. Tests render through `testing/render.ts`, the same
  harness with a size you choose, and `setupApp` passes `columns` and `rows` to both the harness
  and `App`.
- Wrapping is Ink's (it measures with `string-width`), not a Keith function; the hard wrap of the
  input draft uses `Bun.stringWidth`.
- A tool part carries no timing, so a finished call shows `✓` alone, not `✓ 0.4s`. A delegation
  takes its glyph and elapsed time from the task on the board that has the same worker and
  description.

## 8. Testing

- Tests assert structure and text, never colours: rows, glyphs, order, truncation, which hints are
  shown, which region a text sits in. `ink-testing-library` and the PTY tests render with
  `depth: 'none'` and `spinner: false`, so frames are plain text and stable.
- `theme.test.ts` checks token resolution: the depth table, `COLORFGBG` parsing (`15;0` dark, `0;15`
  light, missing → dark), `NO_COLOR` empty versus set, and `KEITH_THEME` overriding `auto`.
  `config.test.ts` checks that the new env vars are read there only.
- One PTY test runs the whole flow with `NO_COLOR=1`: send, stream, approval via `tab`/`y`,
  `/tasks`, `esc`. It asserts the frames contain no `\x1b[3` / `\x1b[4` colour codes and that every
  state is still identifiable by text and glyph.
- Layout tests at 60, 99, 100, 159 and 160 columns check the sidebar width, the activity strip and
  that the prose fills the column. Height tests at 19 and 11 rows check the footer and sidebar hiding.
- The P8 gate attaches frames (chat with tool lines and the sidebar, approval unfocused and focused,
  tasks, nodes, brain trace, logged out, login; P9 adds `stepup`, `member-waiting`, `owner-asked-by`,
  `budget-owner` and `budget-member`) rendered at 100 × 30 in truecolour dark, each with a
  `*.plain.txt` twin rendered without colour. `testing/frames.test.ts` writes them when
  `KEITH_FRAMES_DIR` is set (`FORCE_COLOR=3 KEITH_FRAMES_DIR=<dir> bun test
  ./apps/tui/src/testing/frames.test.ts`), and it is skipped otherwise. A reviewer compares them
  with the mockups here.
- `testing/ansi.ts` tells a colour code from bold, dim, inverse and cursor moves: the `NO_COLOR`
  PTY test forces chalk on (`FORCE_COLOR=3`), so only the theme can keep colour out of the output.

## References

- Terminal coding agents' TUIs: theme tokens for background, panel, element, muted text and subtle
  borders; a `system` theme that keeps the terminal's own background; truecolour fallback to 256
  colours; multiline input with `shift+enter`, `ctrl+j` or a trailing backslash; leader keys; a
  toggle that shows tool output; mouse capture versus native text selection.
- Terminal UI libraries: adaptive light and dark colours; colour profile downsampling (TrueColor to
  ANSI256 to ANSI to none); border sides; padding over margins; a theme with a primary and a base
  background colour, and a live theme preview.
- Differential rendering with synchronized output is why this spec uses Ink's `incrementalRendering`.
- A linear, scrollback-style transcript is why this spec keeps one column of messages with no cards.
- NO_COLOR convention: https://no-color.org/
- Ink 8 README (`backgroundColor` on Box (not used), border background and dim colours, `contentOffsetY`
  scroll views, `usePaste`, `useWindowSize`, `alternateScreen`, `incrementalRendering`):
  https://github.com/vadimdemedes/ink (checked against `node_modules/.bun/ink@8.0.0…/readme.md`)
- Terminal dashboards: the list/detail screen pattern and context-sensitive footer hints.
