# P19 — Home motion: intro and idle hide

Nov 9, 2026 · status: **done Nov 9, 2026**

Home fades its parts in the first time it appears and hides most of itself after a pause.
Rules: `docs/specs/tui-design.md` 5.16 (Motion) and `docs/specs/tui.md` (Home, Motion).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Opacity | Foreground blended toward the theme `bg` in steps | A terminal has no opacity |
| Steps per depth | truecolor 10, 256 colours 4, 16 and none: none | Smooth where it can be, honest where it cannot; `NO_COLOR` never animates and never gets a colour prop |
| Time | An injectable `Scheduler` (`MotionProvider`; `manualScheduler` for tests) | Deterministic tests, no sleeps on the clock |
| Cost | One-shot idle timer; fade timers exist only while a level changes | The laptop overheats; a settled Home adds no timer |
| Intro | First Home mount per process; any key skips (and still acts) | Returning from the chat must be instant |
| Hide | Only Home, after 60 s by default; blocked by anything that needs the person | Never hide an approval, a login panel or an error |
| Wake key | Swallowed, except `ctrl+c` | `enter` must not open the chat from a hidden screen |
| Settings | `KEITH_INTRO`, `KEITH_IDLE_HIDE_SECONDS`, `KEITH_REDUCED_MOTION` in `platform/config.ts` | Same pattern as `KEITH_THEME` and `KEITH_CELL_ASPECT`; `client.json` holds only the login |

## Owner to run

Scenario 0a in `docs/manual-testing.md`: the fades were verified with a fake clock only, not by eye on a real terminal.
