# P7 — English first

Oct 27, 2026 · status: **done**

## Goal

Keith is a global open-source project, so everything in the repo is English: UI text, slash
commands, notices, docs, specs, plans, file names, changelogs and tests. Today the README, the test
guide, every plan, two specs and about 50 source files (TUI texts, core notices, tests that assert
them) are Indonesian. P7 is done when:

1. No Indonesian text is left in tracked files outside `.ref/` (checked by grep for common
   Indonesian words; the remaining hits are listed and justified in the evidence).
2. Keith still answers the owner in the owner's language: that is the model's job, not hardcoded
   text. Prompts stay English and say "reply in the user's language".
3. `bun run check` and `bun run smoke` pass.

Out of scope: git history (commits are already English), i18n framework (one language, English;
a locale layer can come later if someone asks), the user's local memory files.

## Decisions

| Topic | Decision |
| --- | --- |
| Slash commands | `/lanjut` → `/continue`, `/ulang` → `/retry`. No Indonesian aliases |
| Core texts (budget, secret guard, motor denials, no-model notice) | English. Contract text that tests assert changes with them |
| TUI texts (help, notices, approval bar, panels, screens) | English. `message-text.ts` maps known eharness notice codes to short English texts |
| Test guide | `docs/panduan-uji.md` → `docs/manual-testing.md`, English. Example prompts in English |
| Plans | Translate `P0-mvp.md` and the done plans; rename `P1-m0-foundation`, `P2-m1-chat`, `P3-m2-brain`, `P4-m3-node-motor`, `P5-m4-hardening`, `P6-ready-to-test`. Fix every link |
| Specs, README, SECURITY.md, AGENTS.md, CHANGELOGs | English; CHANGELOG entry line rewritten |
| Eval `news` | Checks and prompts in English; keep the four checks' meaning |
| Guard | AGENTS.md convention: "All repo text is English." No new lint tool |

## Steps

Each step goes to a Sonnet 5.5 subagent with disjoint files. Light load: targeted tests per step,
`bun run check` once at the end, smoke once.

1. **Core and shared code.** `apps/core` (src, evals), `packages/*`, `scripts/` (smoke fake provider)
   and their tests; specs they own (`budget.md`, `motor.md`, `hippocampus.md`, `resume.md`, `evals.md`).
2. **TUI.** `apps/tui` texts, commands `/continue` and `/retry`, tests (PTY tests included), `tui.md`.
   Runs after step 1 lands when a TUI test asserts a core text.
3. **Docs.** README, `docs/manual-testing.md`, plans (translate and rename), ARCHITECTURE,
   decisions, SECURITY, AGENTS.md, CHANGELOGs. Can run in parallel with step 1.
4. **Gate.** Grep for Indonesian words, `bun run check`, `bun run smoke`, commit per step on `main`
   (local, no push), evidence appended here, plan moved to `docs/plans/done/`.

## Gate evidence (Oct 27, 2026)

| Check | Result |
| --- | --- |
| Commits (local `main`, not pushed) | `10bab5c` core, `bfb676f` docs, `bf66487` TUI, `c36f36a` manual test guide, plus this one |
| Indonesian words | `git grep -nIiw` over 45 common Indonesian words (repo minus `.ref/`, `bun.lock`, this plan): no hits. No file name left with Indonesian words |
| Commands | `/continue` and `/retry`; no Indonesian aliases |
| `bun run check` | exit 0: Biome clean, tsc clean, 564 pass / 0 fail, check-imports, check-size, check-exports ok |
| `bun run smoke` | `SMOKE PASS (6 steps ok, 2486 ms)`; asserts the English no-model notice, the TUI prompt and the fake provider reply |
| gitleaks | no leaks on every commit |

Notes:
- Keith's front prompt already says to answer in the language the owner writes in; no prompt change.
- The news eval matches English phrases only (prompt "show me the news today please").
- The TUI boolean field accepts `y`, `yes`, `true`, `1` (no `ya`); `/budget` accepts `none` (no `tanpa`).
- This plan still names `docs/panduan-uji.md` where it describes the move.
