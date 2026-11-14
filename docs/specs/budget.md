# Budget

Code: `apps/core/src/modules/budget/`, adapter `packages/db/src/eh/budget-ledger.ts`
(`db.md`). Contract: `packages/contracts/src/budget.ts`. Tests: `apps/core/src/budget.e2e.test.ts`.

## Purpose

One global monthly spending limit for every agent, optional monthly caps per person, and a plain
sentence naming the limit that was reached instead of silence.

## Ledger

- **Scopes.** The global scope `GLOBAL_SCOPE` (stored value `owner`, the name of the MVP's only
  scope, kept so ledgers from before P9 stay valid) holds everyone's spending; each person has the
  scope `person:<personId>` (`personScope`). The month is the ledger's period (UTC calendar month).
  A person's row IS their spending record; its `limit_usd` is their cap (null = uncapped, the
  default; the owner is uncapped unless a cap is set). No separate table: `eh_budget_scope` already
  carries scope, period, limit and spent.
- Every agent (front and both workers) has `budget.ledger = { adapter, scopes: (ctx) => [GLOBAL,
  person:<id>] }` on the same `sqliteBudgetLedger`, wrapped by `trackRefusals`. The person is
  `ctx.principal.id` (the person who asked for the turn; a worker inherits it from the turn that
  sent it), so a worker spends its person's budget. No principal means the global scope only.
  **`billTo` (P16).** A turn whose principal carries `billTo: <personId>` is charged to `person:<billTo>`
  instead of `person:<id>` (`billedPerson`, `budget.ts`): a reminder that fires for its recipient is paid by
  its creator (`{ id: recipient, billTo: creator }`). It is an accounting key only, never authority (the turn
  still acts as `id`); a worker inherits it with the rest of the principal; a missing, empty or non-string
  value falls back to `id`. Identifiers only, the principal is persisted (at most 2048 bytes). Tests:
  `modules/budget/budget.test.ts` (a real turn reserves under `person:ana`, never `person:ben`) and
  `spike-billto.test.ts` (the path through send, park, wake and the inbox). A reservation is all-or-nothing over both scopes, so a turn is refused
  when either the global or the person's remaining is not enough. Global is asked first.
- Default global limit `DEFAULT_MONTHLY_LIMIT_USD` = 20, set once at boot. The "set once" mark is the
  setting `budget.seeded`, so a limit the owner removed (`null`) stays removed after a restart. A
  new month inherits the limit (and cap) of the latest row (ledger rule).
- Per-turn caps stay: front `maxTurnUsd: 0.5` (`FRONT_TURN_BUDGET_USD`, no session cap: the front
  session never ends), workers `maxTurnUsd: 1`, `maxSessionUsd: 3` (`WORKER_BUDGET`).
- The amount a person types (CLI, setup, wizard, TUI) is parsed once, by `parseUsdLimit` in `@keith/contracts`: `none` removes the limit; a plain decimal of USD from 0 to 10000 with at most two places is the amount; empty text, `0x10`, `1e3`, `NaN`, `-1` and `unlimited` are refused (FD10-04).
- Costs come from the model catalog (`providers.catalog()`): an unpriced model costs 0 (eharness warns `W_MODEL_UNPRICED`). The owner may set a manual price per model (`models.price.set`, USD per million tokens, ADR-0027 §23): it is kept in the settings key `models.prices` and laid over the catalog price in the provider service, so eharness sees an ordinary `ModelInfo.pricing`, the spend is counted, and a guest role may use the model. `models.price.clear` puts the catalog price back. That warning is routed to the log and noted in `budget.get` (`unpriced: [model]`, the refs since boot, once each; `modules/budget/unpriced.ts`, ADR-0027 §23). `keith-core doctor` warns about each role model with no catalog price, read from the picks and the catalog. The guest role refuses an unpriced model. The
  compaction summarizer and the memory flush are priced like the front role's model behind them
  (`providers.md`, `resolveRoleModel`).

**Guest scopes (P17, `guests.md`).** A guest turn is charged to `owner`, `guests` (the month) and
`guests:day:<YYYY-MM-DD>` (UTC; the ledger period is the month, so each date is its own scope) and **never** to a
person scope. `Budget.scoped(caps, scopes)` builds the `budget` config over named scopes; `createGuestBudget`
(`modules/guests/guest-budget.ts`) supplies the scopes and `guestConfig()`: `maxSessionUsd = sessionUsd`,
`maxTurnUsd = min(sessionUsd, 0.05)`. A scope without a limit accepts any spending, so `seed()` writes
`setBudgetLimit` for `guests` (`monthlyUsd`) and today's scope (`dailyUsd`) at the start of every turn and before
entry; entry says `no-limit` if a guest scope still has none. Entry is also refused (`owner-floor`) when the
owner's global scope has less than 25 percent of its limit left (an owner with no global limit is never floored),
and with `daily-cap` / `monthly-cap` when a guest scope is used up. A guest turn stopped by a cap ends the
session (`cost-cap`); the guest never sees the owner's budget text.

## Stop notice

A refused reservation, or a turn over its own cap, ends the turn with `cost-cap` and an empty
assistant message. `budget.notice()` (`budgetNotice` of `eharness/limits`; the refusal carries the scope) stores an `eh.notice`
(`level: 'warning'`, `code: 'EH_COST_CAP'`) the chat shows:

- ledger refusal on a **person's cap** (scope `person:…`): "Your monthly cost cap (<cap> USD, set by
  the owner) is reached (<used> USD used). Ask the owner to raise it, or wait until next month.", or
  "Your remaining monthly cost cap is not enough for one turn: …". The global texts below say
  "The monthly cost limit" / "The remaining monthly cost limit"; the first word tells which limit.
- ledger refusal on the **global** limit, limit really reached (spent + reserved >= limit): "The monthly cost
  limit (<limit> USD) is reached (<used> USD used). Change it with /budget or wait until next month."
- ledger refusal, limit not reached but the rest is smaller than the reserve a turn takes first
  (a front turn reserves up to its 0.5 USD cap; e.g. limit 0.01 USD): "The remaining
  monthly cost limit is not enough for one turn: <used> of <limit> USD used or reserved, while one
  turn reserves up to 0.5 USD. Raise the limit with /budget or wait until next month." A worker
  session (`front:<id>:agent:<task>`, checked first) says "while one worker turn reserves up to 1 USD"
  (`WORKER_TURN_BUDGET_USD`, the cap of `WORKER_BUDGET`; P24.3.4, F-039); any other session says "while
  one turn needs to reserve its cost up front".
- per-turn or per-session cap: "This turn stopped because its cost went over the
  per-turn limit. Send another message, or ask for a smaller task."

Workers have the plugin too, but the owner learns through the task: a worker that stops on
`cost-cap` with no text gets the board summary and error `COST_CAP_SUMMARY` ("Stopped because the cost
limit was reached (cost-cap) ..."), and the lead receives the report "[subagent stopped: cost-cap]";
the lead's instructions tell it to say the limit was reached and that `/budget` raises it.

## oRPC (`budgetProcedures(budget, people)`)

`budget.get` needs `budget.read`; `budget.set` and `budget.setPersonCap` need `budget.manage` and a
step-up over TCP (`permissions.md`).

- `budget.get` -> `BudgetStatus { scope, limitUsd|null, spentUsd, reservedUsd, remainingUsd|null,
  periodStart, periodEnd, unpriced: string[], people? }`; `remainingUsd` = max(0, limit - spent - reserved); `periodEnd`
  is the first instant of the next month (UTC). What it describes depends on the caller:
  - `budget.manage` holder (the owner): the global scope plus `people`: one row per person who is
    not `left` (`personId`, `username`, `name`, cap as `limitUsd`, `spentUsd`, `reservedUsd`,
    `remainingUsd`).
  - anyone else: their own scope `person:<id>`: own spend, own cap, and `remainingUsd` also bounded
    by what is left globally. No `people`, no one else's numbers.
- `budget.set({ limitUsd })` (`null` removes the limit) sets the global limit, returns the global
  status and appends the activity event `budget-changed` `{ status }` (system event: the owner's
  feed only, `thalamus.md`).
- `budget.setPersonCap({ person, usd })` (`person` = id or username, `usd: null` removes the cap)
  returns that person's row and appends `budget-changed` on the person's front session with
  `{ status }` = their own view, so their client refreshes. Audited as `settings.budget.cap`.
- CLI: `keith-core budget show` (global and per person), `budget set <usd|none>`,
  `budget cap <username> <usd|none>`.

## Invariants

- Without a limit (`null`) nothing is refused by the ledger; the per-turn caps still apply. A
  person with a cap can never spend more than it, and never more than what is left globally.
- Tests: `apps/core/src/isolation.e2e.test.ts` (cap refuses one person, ledger rows per person).
- The ledger never lets spent + reserved pass the limit across processes (conformance, `db.md`).
