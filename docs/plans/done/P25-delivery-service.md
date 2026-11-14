# P25 — Delivery service: exactly once, retried, reported

Nov 10, 2026 · status: **done Nov 10, 2026** (Haiku implementers, orchestrated by Sonnet; `bun run check` 3086 pass and `bun run smoke` 60 steps pass) · depends on: P21 (done), P26 phase 1 (no migration ships before the backup and lock exist; P22 order: P23, P26, P24, P25) · ADR: 0024 §5, 0027 §16 · closes: F-010, F-019, F-020, F-021 (P22 milestone M1)

## Goal

When a plugin, and later a protocol, has something to tell a person ("your reminder is due"), it goes through one core service that delivers it
exactly once, retries when the front agent is briefly unreachable, and tells the creator when it finally could not deliver. The owner stops
having reminders vanish silently, duplicate after a restart or stop recording after months. The service also has one place (a route interface)
where presence-based routing (P27) and protocol `notify` steps (P28) plug in later.

## Why

- **F-010** a one-time reminder is lost without a notice when `session.inject` throws (`plugins/reminders/fire.ts:36-37,58`,
  `apps/core/src/modules/plugins/wake.ts:28-45`). ADR-0027 §16: a reminder that could not be delivered is reported to its creator.
- **F-019** `wake.ts` ignores `request.id`; eharness `inject` has an idempotency `key` (`.ref/eharness/src/agent/session-types/turn.ts:241`).
  The reminders plugin writes `last_slot` only after the wake, so a hard kill in between delivers twice. ADR-0027 §16: delivery is exactly once
  by run id and `lastSlot` is written in the same transaction as the fire record.
- **F-020** after downtime the eharness scheduler (`.ref/eharness/src/scheduler/scheduler.ts`, `processRow`) fires the latest missed slot and the
  latest fresh slot in the same tick, so a cron reminder can wake twice at boot. ADR-0027 §16: the boot tick fires at most the latest slot.
- **F-021** `fires:<creator>:<hour>` keys in `plugin_kv` are never deleted; `KV_KEYS_MAX` is 10 000 (`packages/host/src/storage/kv.ts:6`), after
  which `kv.set` throws after the delivery and the slot is dropped. ADR-0027 §16: fire counters pruned after 48 hours.
- ADR-0024 §5 (one delivery service, exactly once by run id), §4 (`reminder-missed` built-in protocol later reuses this service).
- ADR-0025 §5 (routing picks a client by presence) needs a seam: a route chosen per delivery, default "the front session of the person".
- P29 needs fan-out to every channel; the `fanout` field exists from the start so P29 does not edit this contract.

## Scope

In:
- Core module `apps/core/src/modules/delivery/` with `deliver(request)`, a durable `deliveries` table, a retry timer, the failure report, the
  route interface and the default front-session route.
- `createWake` (`modules/plugins/wake.ts`) becomes a thin adapter over the service; the plugin-facing `WakePort` keeps its shape plus a `queued`
  result and an optional failure notice.
- Reminders plugin: a fires table (fire record + `last_slot` in one transaction), rate limit counted from it, 48-hour prune, one-time removal of
  the old `fires:*` kv keys, the failure notice for the creator.
- Host schedule service: a slot is declined as `superseded` when a later slot of the same cron is already due (F-020).

Out (with where it goes):
- Presence routing, client records, `activeClient` (P27); the service only exposes the planner seam.
- Protocol steps `notify`, `ask`, `wake` and the `reminder-missed` / `approval-stale` built-ins (P28); they call `deliver()`.
- Moving reminders to protocol triggers (ADR-0024 §5): P28 phase 6 (final phase); the reminders plugin keeps its API. Until then this plan's reminders flow is the delivery path.
- A once reminder that falls due while its plugin is off, and cancel on done rows (ADR-0027 §17, F-022): P24.6.3 and P24.6.4. A catch-up replay (`late: true`) is never declined as `superseded` by P25.2.3, and a superseded decline is never recorded in P24's catch-up store.
- Channels other than the front session (push, mail, node notification): they arrive as routes in P27/P28 and later.
- eharness changes: none. The inject `key` already exists. Its dedupe window is the newest 200 stored messages (see Risks).

## Design

### Contracts (`packages/contracts/src/delivery.ts`, exported from `index.ts`)

```ts
DeliveryNeedsSchema = z.object({
  mode: z.enum(['wake', 'note']).default('wake'),   // wake: start a turn; note: store it, no turn, no cost
  capabilities: z.array(z.string().max(60)).max(5).default([]), // client capabilities the route must offer, all of them (P27: 'open.view', 'notify')
  fanout: z.enum(['best', 'all']).default('best'),   // best: first route that works; all: every route the planner returns (P29 check-ins)
  urgency: z.enum(['normal', 'high']).default('normal'),
})
DeliveryRequestSchema = z.object({
  id: z.string().min(1).max(200),                    // the run id: stable per fire (inject key)
  source: z.string().min(1).max(80),                 // 'plugin:reminders', later 'protocol:<id>'
  to: z.string(),                                    // person id
  billTo: z.string().optional(),
  name: z.string().min(1).max(60),                   // eh.event name the model sees
  text: z.string().min(1).max(4000),
  data: z.unknown().optional(),
  needs: DeliveryNeedsSchema.default({ mode: 'wake', urgency: 'normal', capabilities: [], fanout: 'best' }),
  onFailure: z.object({ to: z.string(), text: z.string().max(1000), key: z.string().max(120) }).optional(),
})
DeliveryOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('delivered'), route: z.string(), attempts: z.number().int() }),
  z.object({ status: z.literal('queued'), reason: z.enum(['unavailable']), nextAttemptAt: z.number() }),
  z.object({ status: z.literal('failed'), reason: z.enum(['budget', 'unavailable', 'recipient-gone', 'no-route']), attempts: z.number().int() }),
])
```

The plugin-facing port stays in `packages/host/src/schedule.ts`: `WakeRequest` gains optional `failureNotice?: { to: string; text: string }`;
`WakeResult` becomes `{ delivered: true } | { delivered: false; reason: 'budget' | 'recipient-gone' } | { delivered: false; queued: true }`
(`unavailable` is no longer returned: it is queued and retried). `recordingWake` in `packages/host/src/testing/memory-extras.ts` follows.

### Data model (migration: the next free number, additive, generated with drizzle-kit; the ADR-0027 §3 backup of P26 phase 1 is already in place)

Table `deliveries` in a new area file `packages/db/src/schema/delivery.ts` (P23.1.0 split `keith.ts`), repo `packages/db/src/repos/deliveries.ts`:

| Column | Notes |
| --- | --- |
| `id` text PK | the run id; a second `create` with the same id returns the stored row (this is the exactly-once guard in the core) |
| `source`, `recipient_id`, `bill_to`, `name`, `needs` (json), `data` (json) | the request |
| `text` text | blanked (`''`) when the row becomes `delivered`, so the retention of message text is the retry window only |
| `report_to`, `report_text`, `report_key` | the failure notice, nullable |
| `status` | `pending`, `delivered`, `failed` |
| `reason`, `attempts`, `next_attempt_at`, `route` | outcome fields |
| `created_at`, `updated_at` | epoch ms |

Index on `(status, next_attempt_at)`. Rows `delivered` or `failed` are purged 7 days after `updated_at` in the existing prune tick
(`apps/core/src/compose-timers.ts`, `prune`). A delivery row carries text of a person's reminder only until it is delivered (or 7 days after a final failure).

Plugin table (generated with `bun run plugin:db:generate reminders --name fires`): `plg_reminders_fires(fire_id PK, reminder_id, creator_id, slot,
fired_at, state)`, `state` is `claimed` or `accepted`; index on `fired_at`.

### The service (`modules/delivery/`)

```ts
interface DeliveryRoute {
  id: string                                          // 'front'
  send(request: DeliveryRequest, ctx: { attempt: number }): Promise<RouteResult>
}
type RouteResult = { ok: true } | { ok: false; reason: 'budget' | 'recipient-gone' | 'unavailable' }
interface RoutePlanner { plan(person: string, needs: DeliveryNeeds): Promise<DeliveryRoute[]> }  // ordered, best first
```

- `createDelivery({ db, planner, audit, now, retryMs: [60_000, 300_000, 1_800_000], warn })` returns `{ deliver(request), tick(), start(), stop() }`.
- `deliver`: validate, `create` the row (existing id: return its outcome without sending), run `attempt()`.
- `attempt`: ask the planner for routes, try them in order until one is `ok` or a terminal reason. `budget` and `recipient-gone` are **terminal**
  (spec: a once reminder ends on `budget`; the person is gone). `unavailable` on every route schedules the next retry (`queued`); after the last
  retry the row is `failed`. A terminal failure (or the last retry) sends the **failure notice** (below), writes `delivery.failed`.
- **Default planner**: `[frontRoute]`, where `frontRoute.send` is today's `createWake` body moved here: budget check
  (`remainingUsd` against `FRONT_TURN_BUDGET_USD`), `agent.session(frontSessionId(to), frontSessionOptions(...))` with the shared `{ lock }`, then
  `session.inject('eh.event', { name, text, data }, { deliver: 'next-turn', wake: needs.mode === 'wake', principal, key: request.id })`.
  The inject `key` is the run id (a longer id is replaced by its SHA-256 hex), so a retry or a restart after a hard kill is a no-op that returns
  the stored message (F-019). The route first checks the recipient is an active person (ADR-0027 §15).
- **Failure notice** (F-010): a second delivery with `id = 'report:' + onFailure.key`, `needs.mode = 'note'` (a stored message, no turn, no budget),
  `to = onFailure.to`, name `delivery-failed`, text from the plugin, and no `onFailure` itself (no loops). `report_key` makes it once per key; the
  reminders plugin puts the reminder id and the UTC day in the key, so a repeating reminder that keeps failing reports once a day. If the
  creator cannot be reached either, only the audit row and a log line remain.
- **Seam for P27 and P28**: `createDelivery({ planner })` takes any `RoutePlanner`. P27 supplies one that orders routes by presence
  (`activeClient`, then the most recent reachable client offering every `needs.capabilities` entry, then the front session) and may return an empty list with a
  queue marker; P28's `notify` step calls `deliver()` with `source: 'protocol:<id>'`. Neither needs a change to the service or the table.
- **Timer**: `start()` runs `tick()` once at boot (rows left `pending` by a stopped core are retried) and then every `CoreTiming.deliveryTickMs`
  (30 000; tests ~20). `tick` selects `pending` rows with `next_attempt_at <= now`, at most 20 per tick.

Audit kinds (never text): `delivery.sent {id, source, to, route, attempts}`, `delivery.retry {id, attempt, nextAttemptAt}`,
`delivery.failed {id, source, to, reason, attempts}`, `delivery.reported {id, to}`. Actor `system`.
A terminal failure (also the last retry) also emits the activity record `delivery.failed { personId: to, deliveryId, source, reason }` on the recipient's front session id (schema `DeliveryFailedRecordSchema` in `packages/contracts/src/delivery.ts`; no text). It is the source of P28's `reminder-missed` trigger (`event` over `delivery.failed` with `source: 'plugin:reminders'`); P27.1.4 only lists it in the activity table of `thalamus.md`.
`doctor` gets one check `delivery`: `!` when rows are `pending` older than an hour, with the count; `failed` rows of the last 7 days are listed as a hint.

### Reminders plugin (`plugins/reminders/fire.ts`, `store.ts`, `schema.ts`)

`onSchedule` becomes:

1. Re-read row and people (unchanged). Skip reasons unchanged except `unavailable` disappears.
2. Look up `plg_reminders_fires` by `fire.fireId`. `accepted`: return `{ fired: false, reason: 'duplicate' }`. `claimed`: go to 4 (a crash or hard kill
   happened between the claim and the delivery: delivery is idempotent by `fire.fireId`).
3. Rate limit: count fires of this creator in the last hour from the table (replaces the kv counter, F-021). Over 20: skip `rate-limit`.
   Then **one transaction** (`ctx.db.transaction`): insert the fire row as `claimed` and set `last_slot = fire.scheduledAt` on the item (F-019, §16).
4. `ctx.wake({ ..., id: fire.fireId, failureNotice })`. `delivered` or `queued`: in one transaction set the fire row `accepted` and call `markFired`
   (`status` `done` for a once reminder); audit `fired` with `delivery: 'delivered' | 'queued'`. `budget` or `recipient-gone`: skip as today
   (a once reminder ends) and the service has already reported it to the creator.
5. Housekeeping on each fire: `DELETE FROM plg_reminders_fires WHERE fired_at < now - 48 h`; delete any leftover `fires:*` kv keys (loop with
   `kv.list({ prefix: 'fires:', limit: 1000 })`, once they are gone the call is empty and cheap).

`failureNotice` text (English, framed as data for the model, in the style of `frame()`): "A reminder you set for <recipient> could not be
delivered (<reason>). Tell <creator> briefly, in their language. Reminder text, quoted: <json>", only for the creator who wrote that text.

### Host scheduler (`apps/core/src/modules/plugins/schedule.ts`)

In `fire({ schedule, scheduledAt, fireId })`: for a cron spec, if `nextCron(expr, scheduledAt) <= now()` a later slot of the same schedule is already
due, so this one is declined: audit `plugin.<id>.schedule.skipped { key, scheduledAt, reason: 'superseded' }` and return `{ fired: false }`. The
scheduler then fires the later slot, so a boot tick fires at most the latest slot (F-020). Once schedules are unaffected.

### Settings, errors, UI

No settings, no TUI screen and no CLI command in this plan; the owner sees failures through `keith-core doctor` and `keith manage` audit. The
plugin operations keep their error codes.

## Phases

### Phase 1 — Contracts, table, service

Goal: a tested delivery service exists and nothing calls it yet.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P25.1.1 | Write the spec and the contracts | `docs/specs/delivery.md` (new), `packages/contracts/src/delivery.ts` (also `DeliveryFailedRecordSchema`), `packages/contracts/src/index.ts` (or the area file P23.1.0 made), `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`) | delivery.md; contracts rule 2 | `packages/contracts/src/delivery.test.ts`: defaults, id length 200, outcome union | spec reviewed, `bun run --filter @keith/contracts` types pass |
| P25.1.2 | `deliveries` table and repo | new area file `packages/db/src/schema/delivery.ts`, `packages/db/src/repos/deliveries.ts`, `packages/db/src/index.ts`, generated `packages/db/drizzle/<next>_*.sql` (`bun run --filter @keith/db db:generate`), `docs/specs/db.md` (table list, repo list, migration note) | db.md "Tables", "Migrations" | `packages/db/src/repos/repos.test.ts`: create is idempotent by id, `due(now, limit)` order, `settle` blanks text, `purge(before)`; a `migration-<n>.test.ts` like `migration-0009.test.ts` (old rows unchanged); the table gets its row in the db.md retention inventory (P26.1.5) | repo tests pass, `scripts/exports.snapshot.json` regenerated with `bun scripts/check-exports.ts --write` |
| P25.1.3 | The service with the default front route; on a terminal failure it also reports the undelivered message: the failure notice and the `delivery.failed` activity record (contract in `delivery.ts` from P25.1.1, spec in `delivery.md` "Failure notice") | `apps/core/src/modules/delivery/{delivery,route-front,planner,removal,index}.ts` (`removal.ts` registers the pending rows of a removed person in the P26 removal registry: `keep` leaves them, `purge` deletes them, `export` lists ids only), `apps/core/src/modules/delivery/delivery.test.ts` | delivery.md "Service", "Routes", "Failure notice" (the record) | scripted route tests: delivered once for the same id sent twice; `unavailable` queues, retries at 1/5/30 min on a fake clock, then fails; `budget` terminal; failure notice stored as a `note` once per key; recipient inactive is `recipient-gone`; inject key equals the run id (and a 300-char id is hashed); `fanout: 'all'` tries every route the planner returns and is `delivered` when any is ok; a removed person's pending rows are purged by the registry; a terminal failure emits one `delivery.failed` record with `personId`, `deliveryId`, `source`, `reason` and no text, on the recipient's session id only; a delivered message emits none | all cases pass; module imports nothing but `index.ts` of other modules (check-imports) |

Phase gate: `bun run check`.

### Phase 2 — Core wiring and the host

Goal: plugin wake goes through the service; the boot tick fires at most the latest slot.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P25.2.1 | `WakePort` result and request | `packages/host/src/schedule.ts`, `packages/host/src/index.ts`, `packages/host/src/testing/memory-extras.ts`, `docs/specs/plugins.md` ("Schedules and wake") | plugins.md Schedules and wake | `packages/host` tests for `recordingWake` results (`queued`, `recipient-gone`) | host types pass, reminders still compile |
| P25.2.2 | `createWake` becomes the adapter; compose builds the service, timer and prune | `apps/core/src/modules/plugins/wake.ts`, `apps/core/src/compose-timers.ts` and `compose-regions.ts` (`CoreTiming.deliveryTickMs`, `timers`, `prune` purge, boot `start()`), audit kinds are free strings (there is no kinds list outside `ACL_AUDIT_KINDS`, which is ACL only) | plugins.md, delivery.md "Boot and timers", thalamus.md boot order | `modules/plugins/schedule.test.ts` and `apps/core/src/plugins-reminders.e2e.test.ts` stay green; new e2e case: the front agent is absent at fire time, the reminder is delivered after it returns, once | reminders e2e passes with the service in the path |
| P25.2.3 | Superseded slot in the host scheduler | `apps/core/src/modules/plugins/schedule.ts` | plugins.md "Ticking" (new rule) | `schedule.test.ts`: cron with a missed and a fresh slot at boot fires one (the latest) and audits `superseded`; once schedules unchanged; a catch-up replay with `late: true` fires even if a newer slot is due (for cron only the latest is replayed); a superseded decline is not written to the catch-up store of P24.6.3 (the store of P24.6.3 is untouched by it) | F-020 case passes |
| P25.2.4 | `doctor` check `delivery` | `apps/core/src/cli/doctor/checks/delivery.ts` (new, listed in the table of `cli/doctor.ts`), `docs/specs/core-cli.md` (doctor row) | core-cli.md doctor | `cli.test.ts` doctor cases: stale pending row gives `!` | doctor prints the count |

Phase gate: `bun run check` and `bun run smoke` (core boots with the new timer and migration).

### Phase 3 — Reminders on the service

Goal: fire records, rate limit and prune live in one transaction-safe table; failures reach the creator.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P25.3.1 | Fires table | `plugins/reminders/schema.ts`, generated `plugins/reminders/migrations/` (`bun run plugin:db:generate reminders --name fires`), `plugins/reminders/store.ts` | reminders.md "Data" | `reminders.test.ts`: store helpers (claim, accept, count per hour, prune) | migration generated, tests pass |
| P25.3.2 | New `onSchedule` flow and failure notice | `plugins/reminders/fire.ts`, `plugins/reminders/reminders.test.ts` | reminders.md "The fire", "Restart", "Limits"; plugins.md | `claimed` row from a simulated kill is resumed and delivered once; `accepted` row is `duplicate`; claim and `last_slot` commit together (a throw between rolls both back); rate limit from the table; fires older than 48 h pruned; old `fires:*` keys deleted; `queued` still counts as fired; `budget` skip carries a failure notice; the notice never holds the text for anyone but the creator | all cases pass, audit rows hold no text |
| P25.3.3 | End to end | `apps/core/src/plugins-reminders.e2e.test.ts`, `scripts/smoke/delivery.ts` (hooked from `scripts/smoke.ts`; reminder with the front agent paused) | reminders.md "Restart" | e2e: whole core stopped between claim and delivery, booted again: exactly one message, `delivery.sent` once; two cron slots missed: one wake | e2e and smoke pass |
| P25.3.4 | Docs | `docs/ARCHITECTURE.md` (Delivery row in Regions plumbing note), `docs/specs/plugins/reminders.md` final pass, `docs/manual-testing.md` (the scenarios of "Owner to run"), `docs/plans/active/P22-one-keith-foundations.md` row marked done | reminders.md | none | docs match code |

Phase gate: `bun run check` and `bun run smoke`.

## Exit criteria

- [x] `docs/specs/delivery.md` written; `plugins.md`, `plugins/reminders.md`, `db.md`, `core-cli.md`, `thalamus.md` (boot order and timer) updated in the same commits.
- [x] `packages/contracts/src/delivery.ts` and tests; the delivery migration and the reminders fires migration generated, not hand-edited.
- [x] No "Changes in P25" marker is left in `docs/specs` (`grep -rn "Changes in P25" docs`): the step that lands the code rewrites the sentence in present tense.
- [x] Same run id delivered twice produces one message (service test and e2e).
- [x] Hard-kill test: claimed fire resumes once; two missed cron slots fire one wake; counters stay bounded after 48 h.
- [x] A delivery that fails is reported to the creator and audited without text; `doctor` shows pending rows.
- [x] The planner seam is documented for P27 and P28 (delivery.md "Routes").
- [x] `bun run check` and `bun run smoke` pass; manual scenario below run.
- [x] `docs/ARCHITECTURE.md` mentions the service; P22 row marked done.

## Risks and mitigations

- **Inject dedupe window.** eharness reads the newest 200 stored messages only (best effort, spec 11 §6.3). Retries run within about 36 minutes, but a
  chatty session could push the first message out of the window. Mitigation: the `deliveries` row is the primary guard (a `delivered` row never
  sends again); the key covers the crash between inject and the row update, which is a window of milliseconds.
- **Retry storm after a long outage.** At most 20 rows per tick and four attempts each; failures are reported once per key.
- **A failure notice to a creator whose budget is empty.** It is a `note` (no turn, no cost); nothing is charged.
- **Text kept in the core database.** Limited to pending rows, blanked on delivery, purged after 7 days; audit never has text.
- **Superseded rule hides a slot.** Only when a later slot of the same cron is already due; it is audited with both times.
- **Migrating live data.** The migration is additive and P26 phase 1 (already shipped, by the P22 order) takes the backup before any migration at start.

## Traceability

| Id | Closed by step |
| --- | --- |
| F-010 (silent loss, report to creator) | P25.1.3 (failure notice), P25.3.2 (plugin notice), P25.3.3 (e2e) |
| F-019 (double delivery) | P25.1.3 (inject key and row), P25.3.2 (claim + `last_slot` transaction), P25.3.3 |
| F-020 (two fires at boot) | P25.2.3 |
| F-021 (kv key cap, counters) | P25.3.1, P25.3.2 (table counter, 48 h prune, kv cleanup) |
| ADR-0024 §5 | P25.1.3, P25.2.2 |
| ADR-0027 §16 | P25.1.2, P25.2.3, P25.3.2 |
| Removal registry part for pending deliveries (ADR-0027 §26) | P25.1.3 |
| Needs shape for P27/P28/P29 (`capabilities`, `fanout`) | P25.1.1, P25.1.3 |

## Owner to run

1. `bun run manual:core`; sign in with `bun run manual:tui`; ask Keith for a reminder in 1 minute. Expected: it arrives once.
2. Set a reminder for 2 minutes ahead, stop the core with Ctrl-C before it is due, start it 3 minutes later (`bun run manual:core`). Expected: it
   arrives once, marked late in `keith manage` audit (`plugin.reminders.fired`, `late: true`).
3. Make a cron reminder every 15 minutes, stop the core for an hour, start it. Expected: one wake, an audit row `plugin.reminders.schedule.skipped`
   with `reason: superseded` for the older slot.
4. Empty a member's budget (set that person's cap to 0 in `keith manage` Budget), let a reminder for them fire. Expected: the creator finds a message that it
   could not be delivered (reason budget) the next time they open the chat; the audit has `delivery.failed` and `delivery.reported`, no text.
5. `keith-core doctor` with the core stopped after step 2 kill: `delivery` check passes after the next start.

## Gate evidence (Nov 10, 2026)

- Commits f848108 (contracts and spec) to afcdac8 (a throwing wake) and 2d926f5 (docs); `bun run check`: 3086 pass, 0 fail, check-imports, check-size, check-exports (19 entries) ok. `bun run smoke`: SMOKE PASS, 60 steps (block `scripts/smoke/delivery.ts`, 13 s because the scheduler ticks every 15 s).
- Migrations: core `0015` (`deliveries`, generated by drizzle-kit) and plugin `reminders` `0001_fires` (generated by `plugin:db:generate`); both ran on top of the P26 backup.
- Deviations recorded by the implementers: `queued` is `delivered: true` plus a `queued` field (so `fire.ts` compiles unchanged and a queued wake counts as fired); `CoreTiming.deliveryRetryMs` exists so tests can shorten retries; the recipient check lives in the service, not the route (a planner cannot skip it); `no-route` is reported to plugins as `unavailable`; the wiring is a new file `compose-delivery.ts` (compose-regions.ts is near its size limit); `ctx.db.transaction` is used by the reminders fire (the schedule context has no transaction port); the failure notice cannot name the reason (not known when the wake is asked) and clips the reminder text to 300 characters; a skip after a claim deletes the fire row and keeps `last_slot`; the e2e CRASH case writes the claim rows into the sqlite file after stopping core A and boots core B (the harness cannot kill between claim and wake); the e2e "front agent absent at fire time" case could not be built (the harness cannot remove the lead agent), the queued-then-delivered-once path is covered in `modules/plugins/wake.test.ts`.
- Fixed by the orchestrator after the report: a `wake` that throws in a live core left a `claimed` row and dropped the slot with no report. `fire.ts` now treats a throwing wake as `unavailable` (the claim row goes, the skip is audited); the "core stopped" simulation in `fires.test.ts` kills the process after the wake instead (a trigger that aborts the accept).

## Not verified

- The manual scenarios of "Owner to run" (Scenario 20 in `docs/manual-testing.md`) on a real core with a real front agent: pause the front agent, fire a reminder, watch it queue and arrive once; a reminder that cannot be delivered reports once a day to its creator.
- Retry timing at the real values (1 min, 5 min, 30 min); tests use 20 ms.
- A real hard kill of the core process between the wake and the accept (simulated by a trigger and by seeded rows).
- The presence-based route (P27) and the protocol `notify` step (P28) only have the seam (`RoutePlanner`), no consumer yet.
