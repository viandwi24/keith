# P5 — M4 "Hardening"

Oct 26, 2026 · plan for milestone M4 of `P0-mvp.md` · status: **done**

## Goal and limits

M4 is the last MVP milestone. Keith is ready for daily use as an assistant that stays alive. M4 is done when:

1. **Keith remembers.** What the owner asks it to remember ("I'm vegetarian", "the office laptop is called laptop-e") is still used next week and after a restart. Hippocampus lights up when memory is written or read.
2. **Keith does not drop.** A dropped TUI connection, or a core that restarts in the middle of an answer, recovers by itself. A running answer is continued or clearly marked interrupted, not lost silently.
3. **Keith is frugal and honest about cost.** There is a monthly limit for all agents. The owner can see spending in the TUI. When the limit is reached, Keith says so in a clear sentence, not silently.
4. **Keith does not make things up.** The "show me the news" eval passes: the front layer never claims a result before the worker report arrives, and every link in the final answer comes from that report.
5. **Endless conversations stay healthy.** Compaction and the tool output limit keep the context in check; the daily log is stored in `data/logs/`.

Not in M4:

- The web UI and the desktop-web sandbox.
- Voice.
- People Contact, multi-user.
- Scheduler and DMN.
- `longRun` for workers.
- Automatic backup.

## Decisions (CTO, Oct 26, 2026)

| Topic | Decision | Basis |
| --- | --- | --- |
| Hippocampus | eharness `memory()` on the front agent and both workers. The root is on disk at `data/memory/owner/`, mounted through `filesystem({ fs: diskFs(...) })` at the path `/memories` with `hiddenPrefixes` so the generic file tools do not touch it. The pinned file `/memories/profile.md` is always in the context. The front agent uses `flushOnCompaction: true` | Spec 14; the pattern of `examples/memory.ts`. The root path is verified by a test |
| Hippocampus events | `brain.hippocampus.write` from `onWrite`; `brain.hippocampus.recall` from `step.end` when `memory_view` is called. The `memory_*` tools are excluded from `brain.motor.act` | Research: memory does not emit events itself, and the memory tools would light up Motor |
| Memory discipline | Instructions: store preferences and facts about the owner; do not store system status, tasks or secrets (API keys, tokens) | The `memoryDiscipline` pattern in team |
| Resume across restarts | The `sqliteStreamLog` adapter (tables `eh_stream_log`, `eh_stream_chunks`) adapted from team, proven by `streamLogConformance`. `storage.streams` on all agents. A stable `recovery.instanceId` per core (stored in `data/instance-id`), and `session.recover()` of the front session at boot before reconcile | Spec 04 §6.2, spec 05 §9.2 |
| Reconnect in the client | The feed gets `isBusy`, `onBoot`, `onResync`: on a core restart or resync, the chat session does `refetch()` then `follow()` if a turn is still running. `checkStalled()` every 3 seconds while the chat is busy. The TUI shows the connection status in the header (a reconnecting indicator) and an interrupted turn with the commands `/continue` (`continueTurn`) and `/retry` (`retryTurn`) | Spec 27 |
| Long history | `clip: 2000` on the chat session so large tool history does not flood the TUI | A 0.9 feature |
| Budget | A SQLite ledger (`eh_budget_scope`, `eh_budget_reservation`, `eh_budget_record`) adapted from team, proven by `budgetLedgerConformance`. One monthly `owner` scope for all agents. The front agent `maxTurnUsd: 0.5`; workers stay 1/3 USD. `budgetNotice` + `trackRefusals` with plain-language texts; for workers, the notice reaches the owner through the task report | Spec 12 §4.1, spec 33 |
| Seeing cost | The oRPC `budget.get` (limit, used, remaining this month, cost per task) and `budget.set`. TUI: `/budget`, and this month's spending in the header | Research §3 |
| Front agent compaction | `summarizeAt: 0.65`, `keepLast: 6`, `prune: { keepTurns: 2, minChars: 2000 }`, the `front` role model (cheap) as the summarizer. Workers use the eharness defaults | Spec 06; the 0.9 fix for reasoning models |
| Output and step limits | `toolOutput: { maxChars: 20_000 }` on all agents. Worker `stepBudget` (`chunk: 20`, `cap: 60`, `wrapUp: true`); the front agent `cap: 16` with an `onCap` that reminds it to delegate. `toolCalls` uses the 0.9 defaults | Spec 09, 33 |
| Logs | The logger writes one JSON object per line to `data/logs/keith-YYYY-MM-DD.log`, keeps 14 days, plus the console. eharness `W_*` warnings are forwarded to the logger. Bun first: `Bun.file`/`appendFile`, no log package | P0 "Files"; ADR-0006 |
| Dead letter | `inbox.onDeadLetter` → an error-level log + a notice in the front session | Spec 05 |
| "Show me the news" eval | Two modes. **Scripted** (part of `bun run check`, in CI): a scripted model, checks the order, no result claim before the report, every URL in the final answer is in the report, plus a negative script that must fail. **Real model** (manual, `bun run eval:news` with an OpenRouter connection): the same prompt to a real agent, regex and URL checks, cost limit, report in `data/evals/` | The runner pattern of `examples/coder/evals` |

## Steps

Each step is done by a Sonnet 5.5 subagent, reviewed and committed in the orchestrating session. Steps 1 and 2 can run in parallel; 3 and 4 can run in parallel after that.

1. **`packages/db` + `contracts`**:
   - `sqliteStreamLog` + `streamLogConformance`.
   - `sqliteBudgetLedger` + `budgetLedgerConformance` + `setBudgetLimit`.
   - The `brain.hippocampus.write` / `.recall` payloads.
   - The `budget.get` / `budget.set` contract.
2. **Logger** (`apps/core/src/platform/logger.ts`): daily file, retention, `W_*`, dead letter.
3. **Core**:
   - Hippocampus: memory on all agents, events, discipline.
   - Stream log and recovery: `instanceId`, `recover()` at boot.
   - Budget: ledger, scope, `budgetNotice`, oRPC procedures.
   - Compaction, `toolOutput`, `stepBudget`.
4. **Client + TUI**:
   - Reconnect and resume: feed `onBoot`, `onResync`, `isBusy`, plus `checkStalled`.
   - Connection status, `/continue`, `/retry`.
   - `clip`.
   - `/budget` and cost in the header.
   - The Hippocampus region.
5. **Eval**: `apps/core/evals/news/` (the scripted scenario in tests, the real-model runner `bun run eval:news`).
6. **Documents**: specs `hippocampus.md`, `budget.md`, `resume.md`, `evals.md`, `logging.md`; updates to ARCHITECTURE, AGENTS.md, P0 (MVP done), README (everyday use).

## M4 gate (evidence) = MVP gate

| Evidence | How |
| --- | --- |
| The adapters are correct | `streamLogConformance` and `budgetLedgerConformance` are green |
| Remembers | The owner asks Keith to remember something → a file in `data/memory/owner/` → core restart → in the next session its content is in the model prompt; the events `brain.hippocampus.write` and `.recall` |
| Secrets do not enter memory | The discipline is tested: a request to store an API key is refused by the instructions (tested with a scripted model on the tool called) and gitleaks stays clean |
| Recovers after a dropped connection | Client + PTY tests: the server cuts the stream mid-answer → the TUI reconnects and shows the complete answer |
| Recovers after a core restart | The core is stopped mid-answer → a new core → the turn is marked interrupted with a notice, the TUI shows it, `/continue` continues it; the resume reader reads the SQLite log from another process |
| Budget | A small monthly limit → the next turn stops with a notice in plain language that shows in the chat; `budget.get` shows used and remaining; a worker that runs out of budget reports clearly |
| Compaction | A long session with a scripted model → an `eh.compaction` marker is stored, memory is flushed before the summary, a running delegation is still reported after compaction |
| Scripted eval | An honest script passes, a script that claims a result too early fails, a made-up URL fails |
| Real-model eval | Run by viandwi24 with an OpenRouter connection (`bun run eval:news`); the report in `data/evals/` is attached |
| Logs | The daily file is created, holds `W_*`, with no secrets (gitleaks scans a sample file) |
| Quality | `bun run check` green from a clean clone, `act` twice, `gitleaks`, a suite that is stable under load |

## Risks

| Risk | Handling |
| --- | --- |
| Memory stores the wrong thing or secrets | Discipline in the instructions, text files the owner can edit, a secret-refusal test |
| Compaction drops important context | `keepLast: 6`, memory flush before the summary, an eval of delegation across compaction |
| The real-model eval is not deterministic | The CI gate uses the scripted mode; the real mode is extra evidence with a cost limit |
| A turn cannot be continued after a crash | Clearly marked interrupted; tools are never re-run automatically (eharness behavior) |
| Logs grow without limit | 14-day retention |

## Execution notes

Commits: 55e4486 (db: stream log, budget ledger, logger), 3a7aeed (client/TUI: reconnect, `/budget`),
90afa09 (core: hippocampus, resume, budget, compaction), b9d781f (more stable tests), fb9c580
(news eval), fab1d68 (a stream that drops before the first word is attached again), then the closing
docs commit.

Changes from the plan:

- **A stream that drops before the first word.** eharness treats it as a failed send (a toast, no
  `follow()`), although the core keeps running the turn. `client.reportChatNotice` is called from the
  session's `notify`, checks the core, then calls `followServerTurn()` (`client.md`).
- **The quality gate was lightened** (Oct 26, 2026): viandwi24's MacBook overheated from repeated test
  loops, artificial CPU-load loops and repeated `act`. "`act` twice" was replaced by `act` once per
  gate and only after viandwi24 agrees. "A suite that is stable under load" was replaced by fixing the
  flakes seen at high load (see b9d781f) and `bun run check` green on a quiet machine.
- **Secrets do not enter memory.** A scripted model cannot refuse by itself. What is tested: the
  discipline instruction is in the prompt (`memory.e2e.test.ts`), the memory file cannot be read by
  the worker's file tools, and gitleaks is clean. A real refusal can only be seen with a real model.

### Gate evidence

| Evidence | Result |
| --- | --- |
| The adapters are correct | `packages/db/src/eh/conformance.test.ts`: `streamLogConformance` and `budgetLedgerConformance` green |
| Remembers | `memory.e2e`: memory written in one process is in the prompt after a restart, the region lights up; a worker writes memory with its task id |
| Secrets do not enter memory | See the note above; `gitleaks git` 62 commits: no leaks found |
| Recovers after a dropped connection | `reconnect.test.ts`, `resilience.test.tsx`, PTY `cli.pty.test.ts`: an answer cut in the middle and one cut before the first word both show complete, once |
| Recovers after a core restart | `resume.e2e`: core B marks core A's turn as interrupted with a notice; a reader on another core replays chunks from SQLite. TUI: `/continue` and `/retry` |
| Budget | `budget.e2e`: `get` shows the limit, used and remaining; a small limit stops the turn with a readable notice; a worker that runs out of budget reports |
| Compaction | `compaction.e2e`: compaction after memory is flushed, an already running delegation is still reported; tool output truncated at 20,000 characters; `stepBudget` |
| Scripted eval | `evals/news/checks.test.ts`, `cli.test.ts`: an honest script passes, a too-early claim fails, a made-up URL fails, the report is redacted |
| Real-model eval | **Waiting for viandwi24**: `OPENROUTER_API_KEY=… bun run eval:news`, the report in `data/evals/` |
| Logs | `logger.test.ts`: daily file, rotation, retention, `W_*` goes up to warn, a file with no secrets |
| Quality | `bun run check` on a quiet machine (Oct 26, 2026): 497 pass, 0 fail, 67 files, 44 seconds. A clean clone at 4127cae (`bun install --frozen-lockfile` then `bun run check`): 497 pass, 0 fail, 42 seconds. `act` for this gate: waiting for viandwi24's permission (once) |

## [DECIDE]

Decided by viandwi24, Oct 26, 2026:

1. The monthly cost limit for all agents: **20 USD/month** (default, changeable through `/budget`).
2. TUI to a core on another machine: **not in the MVP**. Use it on the core machine or through Tailscale; TLS follows with the web UI.
