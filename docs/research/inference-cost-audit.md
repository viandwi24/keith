# Inference cost and caching audit

Status: research, read-only audit. No code changed. Date: 2026-11-12.
Scope: every model call site of `apps/core` (plus the eharness 0.12.0 pieces Keith runs), the DeepSeek provider path, and the
recorded calls of the owner's test install (`.data/test/data/keith.db`, opened read-only).

Sample: 35 completed model calls from 2026-11-11 16:32 to 2026-11-12 20:50 (local time), one owner, one test install. Small.
Treat the ranking as a hypothesis for production traffic, where front turns are far more frequent than in this sample.

Conventions:
- `µ$` = micro-dollars. `cost_micro` in `llm_calls` is in µ$.
- Costs are catalog estimates (`llm_calls.cost_source = 'estimate'`), priced with the owner's DeepSeek prices:
  flash in 0.15 / out 0.6 / cache-read 0.003 per M; pro in 0.66 / out 1.98 / cache-read 0.022 per M.
  Three rows were recomputed by hand and match (front step 1181 µ$, judge step 37005 µ$, flush step 3556 µ$).
- `tokens_in` includes cached tokens; `cache_read` is the cached part; `tokens_out` includes reasoning.
- Repo paths are relative to the repo root. eharness paths are relative to `.ref/eharness/`.
- Dates and per-person facts are generalised. Message texts and memory contents are not reproduced.

Method (reproducible): `llm_calls` joined to `llm_bodies` (gzip JSON of the exact request, written by
`apps/core/src/modules/audit/activity-logs/capture.ts:161-176`). Consecutive requests were compared message by message
(first differing index), and the tools array was compared by name and JSON. Token counts were calibrated against the
provider's `tokens_in` on five front requests: about 0.265 tokens per JSON character of the request.

---

## 1. Summary

### 1.1 The five biggest wastes, ranked by estimated money

Sample total: 74,244 µ$ ($0.0742). The dream judge is 74.4% of it.

| # | Waste | Evidence | Estimated saving |
| --- | --- | --- | --- |
| 1 | **A failing dream judge run is repeated with the same candidates.** `DreamPlanSchema` requires `text` with min 1 (`packages/contracts/src/dreaming.ts:52`), but 131 of 133 `drop` decisions came back with `"text": ""`. The run failed with cause `judge` after 46,289 µ$ (62% of the sample). Its cursor stayed `{}` (`dream_runs`), so the next run (nightly `0 3 * * *`, `apps/core/src/modules/hypothalamus/dream-protocol.ts:21`) re-judges the same candidates. | Section 4.5 | Up to 100% of the repeated spend: one judge run per night until the schema or cursor is fixed. |
| 2 | **The judge writes a full decision per candidate, on the pro model.** One step produced 18,432 output tokens (10,252 reasoning), 23 KB of JSON for 133 candidates, 37,005 µ$ alone. Most candidates are greetings or small talk. The 12 k-character budget (`collect.ts:19`) counts text only; the real prompt was 30,588 characters. | Sections 4.4, 4.5 | About 32,000 µ$ (about 44% of sample spend) if output falls to about 2,000 tokens, which is an assumption. Pro-to-flash is a further 3.3x on output. |
| 3 | **Thinking is on for every call, with no setting in Keith.** The AI SDK turns DeepSeek V4 thinking on by default, and no call sends a `thinking` option (checked in all 36 request bodies). Reasoning is 55.8% of recorded output tokens and about 23,700 µ$ of spend. The judge alone is 20,342 µ$. | Sections 3.4, 4.1 | About 20,000 µ$ (27%) if the judge runs with thinking off and quality holds. Summarizer and flush are only about 1,900 µ$ (2.5%). Overlaps with #2. |
| 4 | **Cold caches from volatile tool definitions and a different flush tool set.** The `client_call` description lists the person's online capabilities, so the tools prefix changes with the clients (3 variants seen). Two front turns were billed cold: 1,812 and 1,731 µ$ against about 250 µ$ for a normal turn. The pre-compaction flush sends a whitelisted tool subset, so its first step was cold: 3,556 µ$ with 768 tokens cached. | Sections 3.2, 4.4 | About 6,400 µ$ (about 9%). Grows with every client connect and disconnect. |
| 5 | **The front turn reminder sits inside the history, so every turn re-bills the previous turn and its own reminder.** The turn reminder is inserted before the current turn's first message and never stored (eharness `src/loop/prompt.ts:37-51`). Next turn, that position holds the user's message, so the cache matches only up to there. Steady turns re-bill about 750 tokens (about 40% of a flash front turn's cost). | Sections 3.1, 3.3, 4.3 | About 80 µ$ per steady flash turn (about 30%). About 360 µ$ per turn if the front runs on pro. Small in this sample, but front turns dominate in production. |

Cross-check: the top 5 are the judge (#1, #2, #3), the cache breaks (#4, #5), and no other call type is a material waste in the sample.
Deliberate omissions: worker, room, guest, web search, and wake turns have no rows in `llm_calls` (section 6), so their cost is unknown, not zero.

### 1.2 Measured cache hit ratio

- All 35 calls: **74.9%** (324,096 of 432,611 input tokens cached). The low figure is driven by the judge (59.9%) and the summarizer (0.9%).
- Front steps (22 flash calls): **84.0%** overall, **93-96%** on steady turns.
- One long front conversation (9 turns, section 4.2): cold first turn at 7.5%, then **93.0% to 96.3%** from turn 2, except the one turn
  where the tool definitions changed (82.5%).
- So the prefix is not broken in general. The system prompt and the tool list are reused. The breaks are the turn reminder
  placement (every turn) and tool-definition churn (occasionally).

---

## 2. Call-site inventory

Columns: call site; role and model in this install (from `settings`: `model.front = deepseek:deepseek-flash`,
`model.cortex = deepseek:deepseek-v4-pro`); trigger; steps and caps; can it run with nothing to do; measured in the sample.

| # | Call site | Role / model | Trigger | Steps and caps | Runs with nothing to do? | Sample |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Front user turn: `apps/core/src/modules/wernicke-broca/agent.ts:183-341`, session opened in `apps/core/src/modules/thalamus/app.ts:169` | `front` via `roleModel` (`agent.ts:267`, `apps/core/src/modules/providers/role-model.ts:24-35`) | user message | `loop.maxSteps` 8 (`agent.ts:332`), `stepBudget` chunk 8 cap 16 (`agent.ts:311-315`), turn budget `FRONT_TURN_BUDGET_USD` 0.5 (`agent.ts:323`, `apps/core/src/modules/budget/budget.ts:28`) | No, needs input | 22 steps, 9,225 µ$ |
| 2 | Front wake turns: a reminder fires (`plugins/reminders/fire.ts:139-161`), a protocol `wake` step (`apps/core/src/modules/hypothalamus/steps.ts:143-170`, reserved 0.02 flat per `steps.ts:71`), a worker report (`apps/core/src/modules/ras/proactive.ts:61-62`), any `wake` delivery (`apps/core/src/modules/delivery/route-front.ts:44-64`) | `front` | timer or event | same as #1 | Yes: a due fire or wake step always starts a model turn. The budget check happens before the call (`route-front.ts:44-47`). | none recorded (no `wake` trigger rows) |
| 3 | Delegation to workers: the `agent` tool (`apps/core/src/modules/cortex/cortex.ts:43-56`), workers `cortex.research` and `cortex.general` (`apps/core/src/modules/cortex/workers.ts:191-216`) | `cortex` (pro in this install) | the front model decides | base 20, chunk 20, cap 60 steps (`workers.ts:76`); turn cap 1 USD, session cap 3 USD (`workers.ts:73`) | No, the model decides | not measured: no worker rows; the 4 `tasks` rows predate the activity log (created before Nov 11) |
| 4 | `web_search` inside a worker: `apps/core/src/modules/cortex/web-search.ts:37-60`, model `SEARCH_MODEL` (`web-search.ts:11`) = `OPENROUTER_DEFAULTS.front` = `anthropic/claude-haiku-5.5` (`apps/core/src/modules/providers/service.ts:45-51`), using the first enabled OpenRouter connection (`web-search.ts:20-25`) | a second provider, not DeepSeek | worker calls the tool | one `generateText` per search, web plugin with 5 results (`web-search.ts:50-56`) | No | not measured (no OpenRouter rows); cost billed by OpenRouter |
| 5 | Automatic summarizer: eharness `src/compaction/summarize.ts:133-141`, configured at `apps/core/src/modules/wernicke-broca/agent.ts:324-330` | `front` (`agent.ts:326`) | context above `summarizeAt` 0.65 of 1,048,576 tokens, about 681k (`agent.ts:327`) | `maxSummaryTokens` default 4,000 (eharness spec 06) | No (threshold) | not reached |
| 6 | Manual `/compact` and `/new`: `apps/core/src/modules/wernicke-broca/context-service.ts:80-81, 189-199` | flush then summarizer | owner command | see 5 and 7 | No | 2 compactions, 9,755 µ$ in total |
| 7 | Pre-compaction flush: eharness `src/compaction/flush.ts:305-331`, `DEFAULT_FLUSH_MAX_STEPS = 3` (`flush.ts:41`); Keith hooks: `hippocampus flushOnCompaction` (`agent.ts:303`), dreaming flush line (`apps/core/src/modules/hippocampus/dream/flush-hook.ts:15-30`) | `front` | every compaction, including `/new` (`flush-hook.ts` header) | up to 3 steps, a whitelisted tool subset (`flush.ts:305-306`) | Partly: an empty session runs no call (`context-service.ts:189-190`) | 6 calls, 4,515 µ$ |
| 8 | Dream judge: `apps/core/src/modules/hippocampus/dream/judge.ts:118-189`, called from `dream/service.ts:500` | `cortex` (pro here, `judge.ts:124`) | nightly `dream` protocol (`dream-protocol.ts:21`, cron `0 3 * * *`), manual `/dream` | 4 steps (`judge.ts:28`), `maxUsdPerRun` default 0.15 (`packages/contracts/src/dreaming.test.ts:183`) | No candidates: skipped without a call (`dream/service.ts:478-483`). Candidates present: the judge is called even when every candidate is a greeting | 5 calls, 55,264 µ$ (74.4%) |
| 9 | Room turns: `apps/core/src/modules/corpus-callosum/turns.ts:183-190`, agent `agent.ts:133, 147, 153` | `front` | each addressed line (default `answerMode: 'addressed'`, `corpus-callosum/service.ts:463`); every line in `every` mode (`packages/contracts/src/rooms.ts:28`) | `ROOM_STEPS` 6 (`corpus-callosum/agent.ts:39, 147`); budget check per speaker (`turns.ts:176-180`) | Yes, in `every` mode | not in sample |
| 10 | Guest agent: `apps/core/src/modules/guests/guest-agent.ts:40-62`, limits `packages/contracts/src/guests.ts:74-80` | `guest`, no default: null until the owner picks (`apps/core/src/compose-guests.ts:133`) | visitor message | 3 steps, 800 output tokens per call, 0.05 USD per turn (`apps/core/src/modules/guests/guest-budget.ts:15`); no compaction (`guest-agent.ts:59`) | No | not in sample |
| 11 | Evals: `apps/core/evals/news`, `apps/core/evals/guest/session.ts:120`, `apps/core/evals/dreaming` | real models, manual | `bun run eval:news` etc. | per script | not in `bun run check` (AGENTS.md) | not in sample |
| 12 | Protocol `notify`, `ask`, `act`, `wait`, system steps; built-ins `approval-stale` and `reminder-missed` (`apps/core/src/modules/hypothalamus/builtins.ts:38-60`) | none | event or time | none | no model | no model calls |
| 13 | Timers and heartbeats: node 10 s, client 20 s, presence 60 s, schedule tick 15 s (`apps/core/src/compose-timers.ts:73-86`) | none | timer | none | no model | no model calls |
| 14 | No model call found: agenda (`hypothalamus/agenda.ts`, tool based), presence (`parietal/tool.ts`), `client_call` (`parietal/client-tools.ts`), notes and reminders tools, report block (`prefrontal/report.ts`, template), titles and summaries (none), eharness internal judge (`eharness/guard`, `modelClassifier`: not imported by Keith) | none | | | no | 0 |
| 15 | Node daemon (`apps/node`) and TUI (`apps/tui`): no model calls found | none | | | | 0 |

Retries: no model-level retry loop exists. The dream judge is not retried inside a run. Delivery retries (1, 5, 30 minutes,
`apps/core/src/compose-timers.ts:30`) re-route a message, and a wake refused for budget costs no model call
(`route-front.ts:44-47`).

---

## 3. Front-turn prefix analysis

### 3.1 Request layout (verified in the captured bodies)

```
REQUEST of one front step (apps/core, eharness 0.12.0 layout)     stable across turns?
------------------------------------------------------------------------------------------
[system block 1]  FRONT_INSTRUCTIONS + delegation + agenda           3,295 chars  YES, byte-identical in all 36 calls
                  + memory protocol (agent.ts:56-70, hippocampus.ts:29-32)
[system block 2]  empty for the front (no session-refresh parts)     -            YES
[tools]           36 definitions, ~36.2k chars (~9.6k tokens)        NO: client_call text differs with the
                  protocol_propose alone = 12.8k chars                  online capabilities (3 variants seen)
[history]         stored messages of earlier turns, no reminders     YES, grows; assistant messages carry
                                                                      reasoning_content (section 3.4)
[TURN REMINDER]   persona, who-line, address line, client context,   NO: its position is the start of the current
                  mode block, memory roots + pinned profile.md,       turn, so the next turn's history does not
                  (motor instructions for workers only)               contain it (section 3.3)
[current user message]                                              new each turn
[STEP REMINDER]   active task list, appended after the last result   trailing, per step (cache-neutral)
```

Where the break happens, measured on two real consecutive turns of the same conversation (requests 05 and 06; the user messages are translated):

```
turn 1  request: [system] [tools] [REMINDER t1] [user "hello"]
turn 2  request: [system] [tools] [user "hello"] [assistant] [REMINDER t2] [user "all good"]
                                  ^ first differing message: index 1, reminder vs user text
=> the cache can match [system][tools] only; "hello", the answer and the reminder are re-billed.
```

Across the 36 requests, the 20 consecutive pairs inside one turn are pure appends (the first difference is past the end of the
earlier request). The 16 pairs that cross a turn boundary all differ at the previous turn's reminder position (indices 1 to 19).

### 3.2 Verdict per volatile piece

| Piece | Source | Changes when | Verdict |
| --- | --- | --- | --- |
| System block 1 | `agent.ts:56-70`, `agent.ts:190-195` | never per turn | **Good.** Identical in all 36 requests. |
| Tools: `client_call` description | `apps/core/src/modules/parietal/client-tools.ts:104-115` ("Capabilities online for this person now: ..."), built by the tool factory (`client-tools.ts:118-122`); observed to change between two turns of one session (turn T8, section 4.2) | a client connects, disconnects or changes its capabilities | **Bad.** Three variants of 36,250, 36,152 and 36,245 characters, differing only in this description. Any change busts the cache after the system block. `W_CACHE_BUST` does not see it: `eharness src/loop/step-build.ts:142` fingerprints system blocks and tool names only, not descriptions. |
| Tools: `protocol_propose` (12,845 chars) and other large schemas | `apps/core/src/modules/hypothalamus/tools.ts` | never | Static, so cache-safe, but about 3.4k tokens per request. A cold miss makes it expensive. |
| Turn reminder: persona block | `agent.ts:198-201`, `apps/core/src/modules/prefrontal/prompt.ts:54-72` | persona edits | **Static content in the wrong place.** Placed at turn start, so each turn's history drops it. |
| Turn reminder: who-line and address line | `agent.ts:202-216` | never for one person | Same placement problem. |
| Turn reminder: style lines | `agent.ts:218-234`, `prompt.ts:100-123` | style edits | Same placement problem. |
| Turn reminder: client context | `agent.ts:236-250`, `apps/core/src/modules/parietal/context-block.ts:67-91` (local time at minute resolution, `context-block.ts:84`) | every minute | **Volatile by design.** It must sit at the end of the request. Its content is about 150-200 tokens. |
| Turn reminder: mode block | `agent.ts:252-264`, `apps/core/src/modules/prefrontal/mode.ts:38-56` | channel changes | Static per channel. Same placement problem. |
| Turn reminder: memory roots and pinned `profile.md` | memory plugin (`.ref/eharness/src/memory/plugin.ts:284-294`), `apps/core/src/modules/hippocampus/hippocampus.ts:88-105`, default pinned cap 2,000 characters (`plugin.ts:48`) | profile edits, dreaming writes | Changes rarely. Re-sent in full every turn. Same placement problem. |
| Step reminder: active tasks | `apps/core/src/modules/tasks/reminder.ts:37-40` | task changes | **Good.** Trailing, so it does not break the prefix. |
| History: assistant `reasoning_content` | AI SDK DeepSeek provider (section 3.4) | every turn | Stable, cacheable, but it grows the context (section 3.4). |
| Prune of old tool outputs | eharness `src/compaction/prune.ts:147-161`, `src/compaction/turn-context.ts:229-232`, Keith config `agent.ts:329` (`keepTurns: 2`, `minChars: 2000`) | when a turn ages out of the last two | **Risk, not observed.** Each completed turn beyond two is rewritten once, so the prefix changes once per aging turn. The sample has no tool output above 2,000 characters, so the effect is unmeasured. |
| Tool output cap | `agent.ts:331` (`toolOutput.maxChars` 20,000), set only under hardening (`apps/core/src/compose.ts:310`) | n/a | Good. Each output is capped, but up to 16 steps per turn. |

### 3.3 Why the reminder causes the cross-turn miss

- eharness inserts the turn reminder at `turnStart` every step and never stores it (`src/loop/prompt.ts:37-51`, `layoutMessages`).
  Its normative spec says the same (`.ref/eharness/docs/specs/02-context-registry.md:186-198`).
- Keith's docs say the opposite. `docs/specs/prefrontal.md:198-199` says the persona is "sent in each turn's reminder, after the
  cached prefix", and eharness spec 02 section 6 rule 2 says reminders "sit after the cached prefix" (line 239-240). Both are
  true only inside one turn. Across turns the reminder sits inside the reused history.
- The `Harness check` in `docs/specs/prefrontal.md:185-199` concluded "no gap". The cost claim there is wrong. The measured data
  shows about 750 tokens per turn re-billed.
- Code comment drift: `apps/core/src/modules/prefrontal/prompt.ts:1-4` says the static persona block "goes into the system prompt".
  The code (`agent.ts:198-201`) puts it in the turn reminder. The code is right about the layout and the comment is not.

### 3.4 Reasoning replay in the history

The DeepSeek provider sends `reasoning_content` on every assistant message of the history, and V4 requires it
(`node_modules/.bun/@ai-sdk+deepseek@3.0.73+.../dist/index.js`, `reasoning_content: reasoning ?? (isDeepSeekV4 ? "" : void 0)`).
Measured share of message characters that is reasoning text, in the long front conversation:

| Request (message count) | Reasoning share of message chars |
| --- | --- |
| 5 messages | 2.7% |
| 9 messages | 14.4% |
| 17 messages | 18.4% |
| 19 messages | 30.9% |
| 23 messages | 37.2% |

This grows with the conversation. It is cacheable when stable, but it widens the uncached tail and brings compaction nearer.
Whether DeepSeek bills the replayed text at the hit price is not measurable from these rows. Unknown, section 6.

### 3.5 Verdict on the front prefix

The system block and the tool list are cache-friendly: 93-96% hit on steady turns, identical system block in every call.
The two real breakers are: (a) the turn reminder sits in the reused history, so each turn re-bills the previous turn and the
reminder; (b) the `client_call` description is live state, so connects and disconnects bust the whole cache. Smaller: the flush
tool subset (cold first step), prune rewrites, and reasoning replay growth.

---

## 4. Measured numbers

### 4.1 Totals by call kind and model (status `ok`)

| Call kind | Model | Calls | Input tokens | Cached | Hit | Output | Reasoning | Cost (µ$) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| step (front) | deepseek-flash | 22 | 274,329 | 230,528 | 84.0% | 3,269 | 2,441 | 9,225 |
| compaction (summarizer) | deepseek-flash | 2 | 14,333 | 128 | 0.9% | 5,181 | 2,497 | 5,240 |
| flush | deepseek-flash | 6 | 78,973 | 54,528 | 69.0% | 1,139 | 611 | 4,515 |
| step (dream judge) | deepseek-v4-pro | 5 | 64,976 | 38,912 | 59.9% | 18,790 | 10,274 | 55,264 |
| **Total** | | **35** | **432,611** | **324,096** | **74.9%** | **28,379** | **15,823** | **74,244** |

By model: flash 30 calls, 18,980 µ$ (25.6%); pro 5 calls, 55,264 µ$ (74.4%).
Reasoning is 55.8% of output tokens and about 23,672 µ$ of spend (the judge's reasoning alone is 20,342 µ$).

### 4.2 One long front conversation, turn by turn

Conversation g3 (one front session, 9 turns, 10 calls). Turn 1 is cold because the tool list changed when the session started.

| Turn (time) | Calls | Input | Cached | Hit | Uncached | Output | Cost (µ$) | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 17:53 | 1 | 11,958 | 896 | 7.5% | 11,062 | 115 | 1,731 | cold: new tool variant |
| T2 18:50 | 1 | 12,113 | 11,264 | 93.0% | 849 | 234 | 302 | |
| T3 18:51 | 1 | 12,354 | 11,520 | 93.2% | 834 | 270 | 322 | |
| T4 18:51 | 1 | 12,630 | 11,776 | 93.2% | 854 | 134 | 244 | used in 4.3 |
| T5 18:51 | 1 | 12,772 | 12,032 | 94.2% | 740 | 90 | 201 | |
| T6 18:51 | 2 | 26,044 | 25,088 | 96.3% | 956 | 428 | 476 | two steps |
| T7 18:53 | 1 | 13,393 | 12,800 | 95.6% | 593 | 281 | 296 | an aborted call (no tokens) sits between T6 and T7 |
| T8 20:49 | 1 | 13,657 | 11,264 | 82.5% | 2,393 | 154 | 485 | tool variant flipped back to one cached 3 h earlier |
| T9 20:50 | 1 | 13,704 | 13,056 | 95.3% | 648 | 186 | 248 | |

Turns 2 to 9 excluding T8: **94.7%** hit (97,536 of 103,010 input tokens). The ratio climbs after the first turn and stays flat.
Turn 2 onward is steady, so the cache does not stay near zero. The uncached part is the previous turn plus the new reminder
(section 3.1).

### 4.3 Anatomy of one steady front turn (T4, 18:51)

| Part | Tokens | Price (per M) | µ$ |
| --- | --- | --- | --- |
| Uncached input | 854 | 0.15 | 128 |
| Cached input | 11,776 | 0.003 | 35 |
| Output (incl. 69 reasoning) | 134 | 0.6 | 80 |
| **Total** | | | **244 (recorded 244)** |

Uncached input is about 53% of this turn's cost. Across the six steady turns (T2, T3, T4, T5, T7, T9), uncached input averages
about 750 tokens (112 µ$) against about 269 µ$ per turn in total: about 40%.

System and tools together are about 10,500 tokens (3,295 system characters and 36,250 tool characters at 0.265 tokens each).
The persona, who, style and mode lines, client context and memory are about 500 tokens of the reminder.

### 4.4 The five most expensive single calls

| Rank | µ$ | Call | Why |
| --- | --- | --- | --- |
| 1 | 37,005 | run B, step index 2 (pro) | 13,516 in (13,184 cached), 18,432 out (10,252 reasoning), 152.7 s. The reply is 23 KB of JSON: one decision per candidate for 133 candidates, 131 of them `drop` with a reason. The reply then failed `DreamPlanSchema` (section 4.5). |
| 2 | 8,728 | run B, step index 0 (pro) | Cold: 13,023 in, 0 cached. The candidate list (30.6 KB) is new on the pro model, so no prefix is warm. |
| 3 | 8,457 | run A, step index 0 (pro) | Cold, same reason: 12,612 in, 0 cached. |
| 4 | 4,974 | summarizer of compaction 1 (flash) | 13,938 in, 0 cached (its prompt differs from the chat prefix). 4,805 out, 2,345 reasoning. |
| 5 | 3,556 | flush step 1 of compaction 1 (flash) | 23,613 in, 768 cached: the flush's tool subset changes the tools prefix (`flush.ts:305-318`), so the first step is cold. The next two flush steps cache well (23,680 cached of 23,856). |
| 6 | 1,812 | front turn, 17:53 (flash) | 12,298 in, 896 cached: the `client_call` description changed. Normal turn: about 250. |
| 7 | 1,731 | front turn, 17:53 (flash) | Same as 6, a new tool variant. |

Cold front calls: (1,812 - 250) + (1,731 - 250) = 3,043 µ$. Flush cold step: 3,556 - (23,613 × 0.003 + 212 × 0.6) = about 3,360 µ$ above a warm step.

### 4.5 The dream judge, run by run

| Run | Trigger | Calls | Cost (µ$) | Outcome | Cursor after |
| --- | --- | --- | --- | --- | --- |
| A | manual | 2 (pro) | 8,975 | failed `interrupted` (the core stopped during the run; `apps/core` log line `dreaming: 1 run(s) the core stopped during ended as failed`) | `{}` |
| B | schedule | 3 (pro) | 46,289 | failed `judge`: 133 candidates; the reply parsed as JSON but failed `DreamPlanSchema` | `{}` |

Run B check, read-only: validating the saved reply against `DreamPlanSchema` (`packages/contracts/src/dreaming.ts`) gives 131
issues, all `text: too_small` (min 1), on the 131 `drop` decisions. The judge prompt (`apps/core/src/modules/hippocampus/dream/prompt.ts:18-47`)
asks for a text per decision and says nothing about an empty text on `drop`.

Input size: the candidate message was 30,588 characters for 133 candidates. `JUDGE_INPUT_CHARS` (12,000, `collect.ts:19`) counts
candidate text only (`collect.ts:211-220`). Each candidate line adds about 120 characters of id, day and source id
(`prompt.ts:50-60`). The comment at `collect.ts:17-18` says the budget is "about 3 000 tokens"; the real judge input was 13,516 tokens.

Judge settings: the cortex role is pro (`model.cortex`), the judge has 4 steps (`judge.ts:28`), and the cap is 0.15 USD
(default, `packages/contracts/src/dreaming.test.ts:183`). Run B cost 46,289 µ$, under the cap.

### 4.6 Cache behaviour details

- All 32 non-zero `cache_read` values are multiples of 128 (`cache_read % 128 = 0`). Consistent with 128-token cache units. Verify against DeepSeek documentation.
- A prefix cached at 17:53 was still hit at 20:49 (call T8: 11,264 cached). So the cache lived at least 3 hours. The upper bound is unknown.
- Cold front turns at 17:53 show only 896 cached tokens: the system block only (about 900 tokens). So the system block is cached and the tool list is not, once the tools differ.

### 4.7 Cost model check

`cost_micro = uncached × input + cache_read × cache price + tokens_out × output price`, with catalog prices. Matches within rounding on
three rows (section header above). Costs are estimates, not invoices. `cache_write` is null for every row (DeepSeek does not report it).

---

## 5. Waste candidates and fixes

### 5.1 Candidates checked (part D)

| ID | Candidate | Finding | Estimate |
| --- | --- | --- | --- |
| D1 | Judge model choice | Classification-like work on pro (`model.cortex`). Pro is 3.3x flash on output and 4.4x on input. | About 2/3 of judge spend, if flash is good enough (unmeasured quality). |
| D2 | Judge output per candidate | Full decision per candidate, reasons included (section 4.4). | Section 1, waste 2. |
| D3 | Judge prompt sizing | Budget on text only (section 4.5). | About 60-75% of judge input per run. |
| D4 | Judge reasoning | Pro thinking on (section 4.1). | About 20,000 µ$ per 133-candidate run. |
| D5 | Failed run repetition | Schema and cursor (section 4.5). | Up to one full judge spend per night. |
| D6 | Reminder placement | Section 3.3. | About 80 µ$ per flash turn (30%), 360 µ$ per pro turn. |
| D7 | Tool churn | Section 3.2. | About 1,500 µ$ per cold front turn. |
| D8 | Flush tool subset | Section 4.4 item 5. | About 3,360 µ$ per compaction with a flush. |
| D9 | Summarizer always cold | Its prompt is a transcript, not the chat prefix. | 5,000 µ$ per compaction, mostly output. Only a cheaper output (less reasoning) helps. |
| D10 | Reasoning on summarizer and flush | 2,497 + 611 reasoning tokens. | About 1,900 µ$ (2.5%). |
| D11 | Prune rewrites | Section 3.2. | Unmeasured. |
| D12 | Reasoning replay growth | Section 3.4. | Unmeasured billing; it shortens the time to compaction. |
| D13 | `summarizeAt` at 0.65 of 1,048,576 | `agent.ts:327`: about 681k tokens before a summary, so a cold miss at that size costs about 0.10 USD on flash and 0.45 USD on pro. | Insurance against one large miss; not a current cost. |
| D14 | Tool definitions size | 36 tools, about 9.6k tokens per request; `protocol_propose` alone about 3.4k. | About 9.6k tokens per request on each miss. Cache hits make it cheap (about 30 µ$ per flash call). |
| D15 | Front step caps | Sample max 2 steps per turn (T6). | No waste in the sample. |
| D16 | Worker caps | 60 steps and 1 USD per turn (`workers.ts:73, 76`). | Unmeasured. |
| D17 | Web search provider | A second provider (OpenRouter haiku) is used silently when such a connection exists (`web-search.ts:20-25`). | Unmeasured. |
| D18 | Rooms in `every` mode | A full turn per line. Default is `addressed` (`service.ts:463`). | No waste with the default. |
| D19 | Protocols and timers | Notify steps and timers call no model (section 2, rows 12-13). | None. Good. |
| D20 | Nightly dream without new messages | Skipped before the judge when there are no candidates (`dream/service.ts:478-483`). | None. Good. |
| D21 | Wake budget accounting | A protocol wake is charged a flat 0.02 USD reservation, not the real cost (`steps.ts:71, 167`). | Accounting only. |
| D22 | Model alias | `deepseek-flash` is an alias that the SDK says currently serves V4.1 Flash (`@ai-sdk/deepseek` `is-deepseek-v4-model`). Unpinned: cost and cache behaviour can change silently. | Risk. |

### 5.2 Fix list

Classes: **SAFE** = mechanical, no spec or behaviour decision; **SPEC** = needs a spec change in the same commit (AGENTS.md rule 1);
**DECIDE** = owner decision; **UPSTREAM** = eharness change, adopted by upgrade (ADR-0011); **MEASURE** = measure first.

| # | Fix | Files | Change | Expected saving | Risk | Class |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Accept an empty `text` for `drop` | `packages/contracts/src/dreaming.ts:52`, `packages/contracts/src/dreaming.test.ts`, `docs/specs/dreaming.md`, `apps/core/src/modules/hippocampus/dream/prompt.ts:39` | `superRefine`: `text` non-empty only for keep-short-term, promote, merge and supersede. The prompt says so. | Stops a failed run from wasting a whole judge spend (46,289 µ$ here). | Low. | SPEC |
| F2 | Stop repeating a judge batch after a refusal | `apps/core/src/modules/hippocampus/dream/service.ts` (failure path, around lines 500-520), `collect.ts` | On `judge-output` or `turn-error`, either advance the cursor past the batch or allow one retry per window. Keep a counter in the run row. | At most one judge spend per night. | Dropped candidates; record in the diary. | DECIDE |
| F3 | Judge answers only for non-drop candidates | `prompt.ts:18-47`, `judge.ts` (`parseJudgeReply`), `apply.ts` (treat an absent id as drop), `packages/contracts/src/dreaming.ts` | The model returns only the decisions that change memory. A missing id is a drop. | About 32,000 µ$ on this batch, assuming about 2,000 output tokens (assumption). | Medium: applier semantics; tests in `judge.test.ts` and `apply.test.ts`. | SPEC |
| F4 | Pre-filter greetings and very short candidates in code | `apps/core/src/modules/hippocampus/dream/collect.ts` | Count the rule's matches first (section 6). Put skipped candidates in `dropped`. | Fewer candidates in input and output. Count unknown. | Low: a short fact (a name) could be lost; keep the threshold small. | MEASURE |
| F5 | Count the rendered prompt in the judge budget | `collect.ts:211-222`, comment `collect.ts:17-21`, `prompt.ts:50-60` | Add the per-candidate overhead to the budget (or budget on the rendered length), and fix the "about 3 000 tokens" comment. | Judge input from about 13.5k to about 4k tokens per run (about 70%). | Low: fewer candidates per run; the cursor moves through `dropped.cap`. | SAFE |
| F6 | Judge on a cheaper model | `judge.ts:124` (`resolveRole('cortex')`), settings | A dedicated judge role or a `dream` model setting; default to flash until measured. | About 3.3x on output, 4.4x on input for the judge. | Judgement quality; measure on the same 133 candidates with `apps/core/evals/dreaming`. | DECIDE, MEASURE |
| F7 | Thinking off for the judge and the summarizer | `apps/core/src/modules/providers/role-model.ts:24-35` or a `wrapLanguageModel` middleware in `providers/deepseek.ts`, setting `providerOptions.deepseek.thinking = { type: 'disabled' }` (SDK option, `@ai-sdk/deepseek` `index.js` around line 52) | Per call: no-tools calls (summarizer) and the judge role. Confirm eharness lets a per-call provider option through. | Judge about 20,000 µ$ per run; summarizer and flush about 1,900 µ$. | Judge quality; measure first. | MEASURE |
| F8 | Move the turn reminder to the end of the request | upstream `.ref/eharness/src/loop/prompt.ts:37-51` (`layoutMessages`), spec `.ref/eharness/docs/specs/02-context-registry.md:186-198`; Keith docs `docs/specs/prefrontal.md:185-199` | Place the turn reminder with the step reminder (trailing), so the history stays byte-identical across turns. Keith-side interim: move the reminder content to `step.prepare` `reminder`. | About 550 tokens per steady turn: about 80 µ$ on flash (30%), about 360 µ$ on pro. | Medium: the model sees its context after the history; changes all Keith agents. | DONE (eharness 0.13.0, `reminders.turnPlacement: 'end'` on the front agent only) |
| F9 | Make `client_call` description static | `apps/core/src/modules/parietal/client-tools.ts:104-115`, `:118-122`; put the list in a `refresh: 'turn'` instruction, as `apps/core/src/modules/motor/remote.ts:446-452` does for motor | Fixed description; the online capabilities go in the turn reminder. Update `docs/specs/parietal.md` and `docs/specs/node-drivers.md`. | About 1,500 µ$ per cold front turn; 3,043 µ$ in this sample. | Low. The model reads the list from the reminder. | SAFE + SPEC |
| F10 | Keep the flush on the full tool list | upstream `.ref/eharness/src/compaction/flush.ts:305-331`; Keith memory flush config (`.ref/eharness/src/memory/plugin.ts`, `compaction.before` hook returning `tools: MEMORY_FLUSH_TOOLS`) | Keep the front tool list and restrict with `toolChoice` or approval. | About 3,360 µ$ per compaction with a flush. | Upstream; the flush behaviour changes. | UPSTREAM |
| F11 | Fingerprint the full tool JSON in the cache-bust check | upstream `.ref/eharness/src/loop/step-build.ts:142`; Keith `doctor` check | Include tool descriptions in `W_CACHE_BUST` detection, so churn like F9 is visible. | Detection only. | Low. | UPSTREAM + SAFE |
| F12 | Defer rarely used tools | `apps/core/src/modules/wernicke-broca/agent.ts` (`deferTools` option), `apps/core/src/modules/hypothalamus/tools.ts` (schema size) | Defer notes, reminders, protocol, agenda and document tools behind `tool_search`. Shorten `protocol_propose`'s schema. | About 30 µ$ per cache-hit call on flash; more on misses. | Discovery changes the tool list and busts the cache once (eharness spec 02 section 6). | DECIDE (low value) |
| F13 | Prune threshold | `agent.ts:329` (`prune: { keepTurns: 2, minChars: 2000 }`) | Raise `minChars` or `keepTurns` after measuring tool-heavy sessions. | Unmeasured. | More context per call. | MEASURE |
| F14 | Summary threshold | `agent.ts:327` (`summarizeAt: 0.65`) | Consider an absolute budget (for example about 250k tokens) so one miss stays bounded. | Insurance: a miss at 250k costs about 0.04 USD on flash instead of 0.10. | More summaries (each about 5,000 µ$ plus a flush). | DECIDE |
| F15 | Pin the DeepSeek model ids | `apps/core/src/modules/providers/service.ts:45-47` (`deepseek.front: 'deepseek-flash'`), settings `model.front` | Use a versioned id (`deepseek-v4-flash`) for predictable cost and cache. | Predictability. | Verify the versioned id gives the same behaviour. | DECIDE |
| F16 | Measure workers, rooms, guests, web search, wake turns | `apps/core/src/compose.ts`, `compose-regions.ts` (`activityLogs` wiring), `apps/core/src/modules/audit/activity-logs` | Confirm the activity-log plugin is on the worker and room agents. Then re-run section 4 queries. | Decides D16 and D17. | Low. | SAFE + MEASURE |
| F17 | Cache-hit report per turn | new read-only query in `apps/core/src/modules/audit/activity-logs` or `scripts` (no workspace imports in scripts) | Print hit ratio per turn and flag turns below 50% after the first. | Visibility only. | Low. | SAFE |

Order of work: F1 and F5 first (safe, small, remove the repeated judge spend and the input overhead). Then F9 (safe, stops
cold turns). Then F2 and F3 (the judge output contract). F8 was the biggest structural win for the front; it needed the upstream change (eharness 0.13.0, done).
F7 and F6 need an evaluation on the same batch before any change.

---

## 6. Unknowns and how to measure them

- **Worker, room, guest, web search and wake turns.** No rows in `llm_calls`. The four worker tasks predate the activity log
  (created before Nov 11; the first activity-log row is Nov 11 16:32). Measure: run one delegation, one room line, one reminder, then query
  `llm_calls` by `session_id` prefix (`front:`, `dream-judge:`, the worker and guest prefixes), `call_kind` and `trigger`.
- **Cache TTL.** Only a lower bound: at least 3 hours (T8). Measure: repeat one request after 1 h, 6 h and 24 h and read `cache_read`.
- **Cache unit.** 128 observed (section 4.6). Verify against DeepSeek documentation.
- **Reasoning replay billing.** Whether DeepSeek bills the `reasoning_content` of earlier turns at input prices, or drops it. Measure
  one fixed request with and without the replayed text and compare `prompt_tokens`. Not done here (no request was sent).
- **Judge quality with flash and thinking off.** No data. Measure on the same 133 candidates with `apps/core/evals/dreaming` (costs money, not in `check`).
- **Token-per-character ratio.** 0.265 calibrated on this mix (English and Indonesian chat, tool schemas). Production text may differ.
- **Candidate greetings.** Count how many of the 133 candidates are short (for F4) with a read-only query on the candidate text, not run here.
- **Costs** are catalog estimates. An invoice from DeepSeek is the only exact answer.
- **Sample size.** One install, 35 calls, 1.2 days. The ranking favours the dream judge. Re-rank with a week of production traffic.

Documentation drift found (not changed):
- `docs/specs/prefrontal.md:198-199` and eharness spec 02 section 6 rule 2 (line 239-240): "after the cached prefix" is true only inside a turn.
- `apps/core/src/modules/prefrontal/prompt.ts:1-4`: says the persona block goes into the system prompt; the code puts it in the turn reminder.
- `apps/core/src/modules/hippocampus/dream/collect.ts:17-18`: "about 3 000 tokens" for the judge input; measured 13.5k.
- `docs/specs/dreaming.md` was not checked against `packages/contracts/src/dreaming.ts:52` (see F1).

---

Method notes: the analysis used read-only queries on `.data/test/data/keith.db`, gunzipped request and response bodies written
to the session scratchpad (not in the repo), and one read-only validation of a saved judge reply against `DreamPlanSchema`. No
migrations, no writes to `.data/`, no edits to `apps/tui/src/cli.tsx` or `scripts/manual.ts`. `bun run check` was not run:
this change is documentation only (Biome excludes `*.md`, AGENTS.md gotchas), and running the full check would load the machine.

---

## 7. Status of the fixes (2026-11-12)

| Fix | Status | Commit | What changed | What remains |
| --- | --- | --- | --- | --- |
| F1 empty `text` on `drop` | done | 0bef017 | `DreamCandidateSchema`: text required for the four changing actions; a drop needs none. Prompt says so. | none |
| F2 repeated failing batch | done | 0bef017 | A failed judgement is retried once; the second failure of the same batch advances the cursor and writes `dropped.failed` to the diary. The batch is kept in the failed run row under a reserved cursor key (no migration). | The skip drops the batch without a second look; a batch that changes with new messages counts as new (one more retry). |
| F3 judge answers only for changes | done | 0bef017 | Prompt asks for non-drop decisions only. An unnamed candidate is dropped as `absent`. Applier safety rules unchanged. | Output size is unmeasured on real traffic. |
| F5 budget on rendered lines | done | 0bef017 | `JUDGE_INPUT_CHARS` is 10 000 rendered characters (was 12 000 of text, about 30 600 rendered in run B). `judgeLine` is the unit. | The 0.4 tokens per character ratio is the audit's estimate; the judge's memory reads are not counted. |
| F7 thinking off | done (judge, summarizer and flush; checked 2026-11-13) | 50aa94c | `providers/thinking.ts`: `providerOptions.deepseek.thinking = disabled` per call for DeepSeek models in `NO_THINKING_CALLS` (`dream-judge`, `compaction`). `INFERENCE_THINKING` is a code constant (`off`). The summarizer and the memory flush use the compaction model: `wernicke-broca/agent.ts` (`model: () => resolveRoleModel('front', providers, 'compaction')`). | The owner setting `inference.thinking` is a follow-up. Quality with thinking off is not measured: run `bun run eval:dreaming`. `summarize-at.ts` is not the summarizer and is not part of this fix. |
| F8 turn reminder at the end | done (eharness 0.13.0) | this commit | Front agent only: `reminders: { turnPlacement: 'end' }` (`wernicke-broca/agent.ts`). The room has no turn reminder (its context is a `step.prepare` reminder, already trailing). Workers (`cortex.general`) keep the default: their turn reminder is the motor list, and they run up to 60 steps per turn, so the per-step re-send outweighs the cross-turn saving. Anthropic cache note in `wernicke-broca.md`: the OpenRouter provider id hides the Anthropic model from eharness' cache gate. | `wernicke-broca/agent.test.ts` ('the turn reminder trails the wire': turn 2 starts with turn 1's stable prefix; fails with `turn-start`). |
| F9, F14, F16, F17 | done | 58d41cc, 3f1b29a, bb84b35, 8d7f71d | Fixed; details in section 8. | none |
| F15 | done (already in place) | 3208b6f | The DeepSeek ids were versioned from the start (`deepseek-v4-flash`, `deepseek-v4-pro`); the audit quotes an older id. | none |
| F4, F6, F10, F11, F12, F13 | not started | | | As in section 5.2. |

Expected saving, in plain words (estimates, not measured on real traffic):

- **F1 and F2.** A judge batch that fails is no longer re-judged every night. The sample's failed run (46,289 µ$) would have produced a plan
  instead of nothing; after two failures of one batch, the nightly spend on it stops. At most one extra judge spend per failing batch.
- **F3.** The judge writes one decision per change, not one per candidate. The audit's estimate for a 133-candidate run is about 32,000 µ$, if output
  falls to about 2,000 tokens (an assumption).
- **F5.** The judge's candidate input is capped at about 10 000 rendered characters per step, against about 30 600 in run B: roughly two thirds less
  candidate input per run.
- **F7.** The judge's reasoning tokens (about 20,300 µ$ in the sample) are no longer billed. Quality is the open question; the eval decides whether
  the default stays `off`.

Tests: `packages/contracts/src/dreaming.test.ts`, `packages/db/src/repos/dreaming.test.ts`, `dream/{apply,collect,judge,prompt,service}.test.ts`,
`providers/thinking.test.ts`. The judge's thinking option is asserted on the scripted model's recorded calls.

## 8. Fixed in the front-turn, summarize and logs work

### Fixed in

| Fix | Commit | What changed | Tests |
| --- | --- | --- | --- |
| F9 static `client_call` description | 58d41cc | The description is one fixed text (`CLIENT_CALL_DESCRIPTION`). The live list is the turn reminder line `Apps online now: ...` (`appsOnlineLine`, written by the front agent when `client_call` is wired). A capability not listed is unavailable. The `no-client` answer still names the online capabilities. Spec: `parietal.md`, `node-drivers.md`. | `parietal/client-tools.test.ts` (description byte-identical with 0, 1 and 2 apps online; the line follows presence); `wernicke-broca/apps-online.test.ts` (scripted turns: the tool description is the same in four calls, the reminder line changes). |
| F14 absolute summarize threshold | 3f1b29a | `compaction.summarizeAt` is a function form: `min(0.65, 200000 / contextWindow)` on the front role's model, read per turn. An unknown window keeps 0.65. Spec: `wernicke-broca.md`. | `wernicke-broca/summarize-at.test.ts` (pure `summarizeRatioFor`, `windowOfModel`); `compaction.e2e.test.ts` still passes. |
| F16 every AI call in the logs | bb84b35 | No code change was needed: the capture plugin is on all five agents (front `compose-regions.ts`; workers `createCortex`; rooms `compose.ts`, `compose-rooms.ts`; guests `compose-regions.ts`, `compose-guests.ts`; web search through `observeAux` in `cortex/workers.ts`). The test now reads each row back on a real core: a worker turn is a `task` session of its person, a room turn a `room` session with the speaker and no person, a guest turn a `guest` session with no person. Spec: `activity-logs.md` ("What each agent adds"). | `activity-logs-agents.e2e.test.ts`; `cortex/web-search.test.ts` (the search model goes through the observe hook). |
| F17 cache-hit visibility | 8d7f71d | The session overview shows input tokens and the cache hit (with the cached tokens). The generation list has a `cache hit` column. A call after the first of its session with a hit under 50% is marked `↓`, and the legend says `low cache hit`. The ratio is derived in the view (`logs/cache-hit.ts`); nothing is stored and the contract is unchanged. Spec: `activity-logs.md` (TUI), `tui.md`. | `logs/cache-hit.test.ts` (ratio, marks, totals); `logs-format.test.ts` (cells, overview, legend); `logs-view.test.tsx` (the rendered marker and legend). |
| Spec drift, item 5 | fd44535 | `prefrontal.md` "Harness check" now says the turn reminder is re-billed across turns (about 750 tokens per turn), accepted for now, with F8 as the upstream fix. `prompt.ts` comments say the persona block is in the turn reminder. | none (docs and comments). |

Expected saving, in plain words (estimates, the audit's numbers, not measured on production traffic):

- **F9.** Connecting or disconnecting an app no longer changes the tool list, so it no longer re-bills the whole tools block (about 9.6k tokens
  on a miss). The sample's saving was about 3,000 µ$ over 1.2 days (about 1,500 µ$ per cold front turn). Steady turns are unchanged.
- **F14.** On a 1M-token model a conversation is summarized at 200k tokens, not 650k. One cold miss at the summary point costs about 0.04 USD
  on flash instead of 0.10. Normal turns cost the same. The cost is more summaries on large-window models (each about 5,000 µ$ plus a flush).
- **F16.** No saving. The worker, room and guest calls now show their cost and tokens in the logs, so D16 and D17 can be measured.
- **F17.** No saving. A low cache hit after the first call is visible per generation, so a prefix that busts the cache shows at once.

Web search: a call is recorded as `aux:web-search:<person>` of the person who asked (eharness 0.13.0 passes `ctx` to `search`), `unknown` only
without a principal. Wake turns are front turns and are recorded by the front plugin; this is by construction,
not probed with a scripted wake.

### Not done (decisions)

- **F10** (keep the flush on the full tool list). Upstream (eharness `compaction/flush.ts`). About 3,360 µ$ per compaction with a flush. Not now.
- **F11** (fingerprint the full tool JSON in the cache-bust check). Upstream (eharness `step-build.ts`). Detection only, no saving. Not now.
- **F12** (defer rarely used tools behind `tool_search`). Low value: about 30 µ$ per cache-hit call on flash. The discovery step also busts the
  cache once. Not done.
- **F13** (prune threshold). Measure first: the sample has no tool output above 2,000 characters, so there is no data to set `minChars` or
  `keepTurns` from.
- **F15** (pin the DeepSeek model id). An owner decision, not code: the owner sets `deepseek-v4-flash` in the `front` role. Settings, no code change.
