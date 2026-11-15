# Plugins (the Keith plugin layer)

Code: `packages/host` (manifest, guard, context, testing kit, OpenAPI), `apps/core/src/modules/plugins` (adapter to eharness, loader, HTTP routes; steps 3 and 4),
`plugins/<id>/` (the plugins). ADR: `docs/decisions/0016-keith-plugin-layer.md`. Plan: `docs/plans/done/P16-keith-plugin-layer.md`.
Related: `acl.md` (resource access), `permissions.md` (capabilities), `auth.md` (actors and sessions), `thalamus.md` (routes), `motor.md` (`tool.approve`).

Status: steps 1 to 9 of P16 are implemented (manifest, guard, compile and load, HTTP, storage, services, events and calls, the owner review queue, schedules and wake, access, the Notes and Reminders plugins: `plugins/notes.md`, `plugins/reminders.md`). The operator surface (`keith-core plugin ...`, the Plugins and Reviews sections of `keith manage`, grants of plugin capabilities) is step 10, also implemented: see "Operator surface".

## Purpose

A plugin author writes `defineKeithPlugin({...})` with **operations**. From one operation declaration the host derives the AI tool, the HTTP route with its
OpenAPI entry and the inter-plugin call, and every one of them passes the same **guard**. No path (tool, route, call) skips it. Plugins are trusted code the
owner installs (tier T1): this layer is a structure, not a sandbox; a plugin runs with the core's authority.

## Manifest (`PluginManifest`, validated by `defineKeithPlugin`)

| Field | Rule |
| --- | --- |
| `id` | kebab-case, 2 to 24 characters, starts with a letter; not reserved (`eh`, `app`, `acl`, `agent`, `keith`, `plugins`, `plugin`, `nodes`, `motor`, `shell`, `memory`, `tasks`, `task`, `tool`, `auth`, `people`, `reviews`, `review`). `acl` is reserved because `aclGuard` treats every `acl_*` tool as ACL-changing |
| `version` | `major.minor.patch` |
| `apiVersion` | exactly `1` (`PLUGIN_API_VERSION`); any other value is refused, so an old plugin never meets a newer host by accident |
| `title`, `description` | optional, 60 and 300 characters |
| `requires`, `provides` | service ids (`a.b`); no duplicates; never both for one id. Order and missing or cyclic providers are checked at boot (below) |
| `events` | `{ <name>: zod schema }` typed events the plugin may emit (below) |
| `permissions` | capabilities the plugin adds: `{ id: '<plugin-id>.<name>', description, roles? }`. Unique, not a core id. `roles` are the roles that hold it by default (the owner always does) |
| `resources` | ACL kinds the plugin owns: `{ <kind>: { class, defaultMode? } }`, the same checks as `core.kinds.register` (`acl.md`) |
| `config` | a zod object: the plugin's settings (form per ADR-0007). Later |
| `operations` | at least one (below) |
| `start(ctx)` | boot, once per process; may return a stop function |
| `storage` | `{ migrations: <folder> }`: where the generated migrations of the plugin's tables live (`${import.meta.dir}/migrations`); omit when the plugin keeps no tables (`db.md`, "Plugin storage") |
| `tui` | `{ menu?: [{ id, label, view, permission?, audience? }], views?: { <key>: () => import(...) } }`: terminal views (ADR-0018, `plugin-views.md`). Validated by `TuiSlotSchema` plus: a menu `view` is a key of `views`, ids unique, `permission` known |

`defineKeithPlugin` throws `PluginDefinitionError` (with `problems`, one line each, none built from user data) and returns a frozen `KeithPlugin`
`{ kind, id, manifest, operations, operation(name) }`. It does no I/O and touches no core state.

## Operation (`OperationDef`)

```ts
defineOperation({
  name: 'create',                       // snake_case, at most 32 characters; the model sees `<plugin>_<name>`
  description: 'Create a note.',        // 1 to 500 characters (model and OpenAPI)
  input: z.object({ ... }),             // zod; the guard parses it, `run` sees the parsed value
  output: z.object({ ... }),            // zod; the guard parses the result, so undeclared fields never leave
  permission: { capability: 'notes.use', resource?: { kind, bits, id?(input) } },
  audience: 'user' | 'public',          // default 'user'
  risk: 'read' | 'write' | 'dangerous', // default 'write'
  expose: { ai, http, call, guest },    // ai, http, call default true; guest defaults false; at least one must be true
  rateLimit: { max, windowMs },         // per actor and operation; windowMs >= 1000
  run(input, k) { ... },
})
```

- **Names.** The AI tool is `<plugin>_<name>` (at most 57 characters), the route is `POST /plugins/<plugin>/<name>`. Plugin ids hold no underscore, so the first
  underscore splits a tool name uniquely; two operations of one plugin with the same name are a definition error, and two plugins cannot share an id (loader).
- **`permission.capability`** is required (fail closed): `authenticated` (any signed-in actor the audience allows), a core capability (`permissions.md`) or one declared in
  the plugin's own `permissions`. `permission.resource` makes the guard check the ACL on the stored resource before `run` (`kind` must be in `resources`; `id` reads the
  resource id from the validated input; omit `id` when `run` filters itself, as a list or a search does with `visibleIds`).
- **`expose.guest`** (P17): offers an operation to the model of a **guest** session. It needs `audience: 'public'` (a definition error otherwise). The AI surface is two decisions: a person's agent is offered `expose.ai` operations, a guest's agent only `expose.guest` ones (a guest never sees an operation that does not say `guest: true`, whatever `ai` says; a person never sees a guest-only one, so Notes marks `public_get` and `public_list` `ai: false, guest: true`). The compiled plugin's `tool.approve` denies a tool the session's kind is not offered (principal id `guest:<id>` = a guest session).
- **`audience`**: `user` reaches only an active person; a guest (P17) and the public reach an operation only when `public` is written. There is no way for a system actor
  to be an audience: work runs as a person or not at all (`acl.md`).
- **`risk`**: `read` is not audited when it succeeds; `write` and `dangerous` write one audit row. `dangerous` makes `tool.approve` ask the person when the model calls it.
- `ResolvedOperation` (`KeithPlugin.operations`) is the one record every projection reads: `pluginId`, `name`, `toolName`, `route`, schemas, `permission`, `audience`,
  `risk`, `expose`, `rateLimit`, `run`. The tool catalog, the HTTP routes, OpenAPI and `k.call` are functions of it.

**Source (ADR-0036 §3).** `OperationDef.source?: 'trusted' | 'outside'` (`ToolSource`, `@keith/contracts`; validated by `defineKeithPlugin`, resolved onto `ResolvedOperation.source`).
Default `outside`: a conversation that read the result can no longer be clean for a risky call. A plugin declares `trusted` only for an operation that returns the person's
own data (Notes' `create`, `update`, `append`, `delete`, `share`, `unshare` and `shares`; Reminders' `create`, `update` and `cancel`); the reads that can return what someone else wrote
(shared and public notes, a reminder addressed to the person) stay `outside`.

## The guard (`createGuard`)

`createGuard({ directory, acl, audit, clock, config?, log? })` returns `{ run(op, rawInput, call), visible(op, facts, surface), catalog(plugins, facts, surface) }`.
`call` is `{ principal: { id } | undefined, session: SessionFacts, signal? }`. Order of `run` (the first refusal ends it):

1. **actor**: `directory.resolve(principal.id)` re-reads the person **now** (status, role, capabilities); a missing, unknown or system principal is refused.
2. **status**: a person who is not `active` (suspended, or removed) is refused, also in a turn that was queued before they were suspended.
3. **capability**: `authenticated`, or the actor's capability set (role table plus grants plus plugin role defaults) must hold it.
4. **audience**: a guest passes only an operation with `audience: 'public'`.
5. **input**: parsed with the operation's `input` (a failure is `INVALID_INPUT`, with zod's field messages and no data echo). Done after the four checks above so a caller who may not
   use the operation learns nothing about its shape.
6. **ACL**: when `permission.resource` has an `id`, `acl.check(aclActorOf(actor), kind, id, bits)`; a denied and a missing resource are the same refusal.
7. **rate limit**: fixed window per (actor, operation) with the injected clock; `RATE_LIMITED` carries `retryAfterMs`.
8. **audit**: a `write` or `dangerous` call that reaches `run` writes `plugin.<id>.<name>` with `{ outcome: 'ok' | 'error' }`; a refusal at steps 1 to 4 and 6 writes `plugin.denied`
   (kind `plugin.denied`, detail `{ plugin, operation, reason }`), at most once per (actor, operation, reason) per 10 minutes. Details never hold input or output.
   A resource-level refusal of `k.access` (missing or not theirs) is not a `plugin.denied`: it is counted as `acl.deny` (`acl.md`, "Audit").
9. **run**, then the output is parsed with `output`.

**Every refusal at steps 1 to 4 and 6 is the same error**: `GuardError` with `code: 'NOT_FOUND'` and the message `not found or not permitted`, so a caller cannot tell a hidden
operation, a missing capability and a missing resource apart. The internal `reason` (`actor`, `status`, `capability`, `audience`, `acl`) is for the audit row only and is
not enumerable on the error. Other codes: `INVALID_INPUT` (400), `RATE_LIMITED` (429), `FORBIDDEN` (403; from `OperationError`), `CONFLICT` (409), `INTERNAL` (500, the
message is `the operation failed` and the cause goes to the log). A `run` that throws `OperationError(code, message)` shows that message (the plugin vouches that it is safe);
an `AclError` maps by code (`NOT_FOUND` stays the same refusal); anything else is `INTERNAL`.

### Visibility of the tool catalog

`guard.visible(op, facts, surface)` is a pure function of **actor facts** (status, capabilities, guest or user) and the static declaration (`expose`, `audience`, `capability`); it never
reads ACL state or any resource, so the list of tools of a session does not change when a note is shared (prompt-cache stability). `run` re-checks everything; the model naming a
hidden operation gets the same refusal as any other.

## Context `k` (`KeithCtx`)

Built **inside every execute call** from the live principal, never at resolve or session-open time (the actor is re-read each time). Fields now: `actor`, `session`
(`{ id, kind: front | worker | wake | schedule | api, method, elevated }`; recorded by the caller of the guard, never read from the durable principal), `plugin`, `acl`, `caps`,
`audit` (`record(kind, detail)`, bound to the actor), `clock`, `config`, `signal`, `db` (the plugin's own tables, scoped Drizzle handle), `kv` (`get`, `set`, `delete`, `list`), `transaction(fn)` (one synchronous write transaction, below), `services`, `call`, `notify`, `emit`, `review`, `schedule`, `access`, `people`, `protocols` and `aclActor` (below). `db`, `kv`, `services`, `schedule`, `access`, `people` and `protocols` throw when the host was given no such port (a test without it). `k.protocols` (`upsertTime(input)`, `cancel(key, owner)`) sets a timed protocol of the actor's own, see `plugins/reminders.md`, "Internals". `k.audit.ownerAccess(kind, ids)` records the instance owner's root reads (`acl.owner-access`).

**One connection (verified in P24.6.0, Nov 10).** The ACL store and the plugin storage are made over the same `bun:sqlite` handle: `compose-identity.ts` builds `sqliteAcl(sqlite, …)`, `compose-plugins.ts` builds `createPluginStorage(sqlite)` from the handle that `openKeithDatabase` returned once. So a plugin's `k.db` writes and its `k.acl` writes can share one transaction. The design chosen for P24.6.1 is the shared primitive `k.transaction(fn)`: a synchronous `fn` runs as one `BEGIN IMMEDIATE` on that handle (nested calls and the ACL's own writes become savepoints, a throw rolls all of them back, and the audit rows written inside roll back with them). Compensation plus an orphan sweep was the fallback and is not needed. A test host without the port (`memoryHost` keeps its ACL in memory) throws from `k.transaction`.

## Services, calls, events and notices (P16 step 6)

- **Services.** `provides: ['notes.read']` and `requires: [...]` in the manifest. A provider hands its implementation over in `start(ctx)`: `ctx.provide('notes.read', impl)` (only ids of its `provides`, all of them, once);
  a consumer reads it with `ctx.services.get(id)` in `start` and `k.services.get(id)` in an operation; only ids of its `requires` answer. A service runs **with the provider's authority, not the caller's**: its methods must take
  the caller's `Actor` and authorize like an operation does (the guard does not stand between). Boot order (`planBoot`, `@keith/host`): a provider before its consumers, otherwise list order. A plugin **fails with a one-line reason** when:
  a service is already provided by another ("service \"x\" is already provided by a"), no plugin provides what it requires (or the provider is off, or cannot load), it sits on a cycle ("dependency cycle: a -> b -> a"), its provider failed to start
  ("whose provider did not load") or it did not provide all of `provides`. The core keeps booting.
- **`k.call('<plugin>.<operation>', input)`.** Runs the other operation through **the same `guard.run` as the caller's actor** with the caller's session facts: the callee re-reads the person, checks status, capability, audience, ACL and rate limit,
  so a call cannot elevate (a member calling an owner operation gets the standard `NOT_FOUND`; a suspended person is refused). Only operations with `expose.call` are callable; an unknown plugin or operation, a plugin that is not loaded and an
  operation hidden from calls are one refusal. Depth is limited to `MAX_CALL_DEPTH` = 4: a fifth link throws `CONFLICT` "calls are nested too deep". The callee's audit row (a `write` or `dangerous` operation) carries `from: <plugin>.<operation>`.
- **Events.** The manifest declares `events: { <name>: zod }` (snake_case, at most 32 characters, not `notice`). `k.emit(name, data, to?)` (and `ctx.emit(name, data, to)` at start, where `to` is required) validates `data` against the schema (the parsed value is
  published, so undeclared fields never leave), caps it at 8 KB and 50 recipients, and limits 60 events a minute per (plugin, event) (an overrun is dropped and logged, never thrown). `to` defaults to the actor alone; name people to tell them too, or `'public'`.
  The core writes **one activity record per recipient**: type `plugin.<id>.<name>`, payload `{ plugin, event, to, data }` with `to` the person (or `*` for public), so a record never lists another person. The feed filter (`activityFilter`) passes a plugin record
  only to its `to` (and `*` to everyone): the owner reads no one else's events, and a guest reads nothing unless the event is public (guests get a feed in P17). A plugin event needs no ACL: the plugin decides the audience, as it does for its data.
  Typed on the client side: `parsePluginEvent` (`@keith/contracts`), `pluginEventOf` (`@keith/client`).
- **`k.notify(text)`** tells the actor (and only the actor) something: 1 to 500 characters, 20 a minute per plugin and person, delivered as the event `notice` (`{ text }`) of that plugin on the person's own feed. A plugin cannot choose another recipient:
  telling someone else goes through the owner review queue (step 7), where the owner is the recipient of the host's own notice. A guest or system actor cannot be notified.

## Access, people and root reads (P16 step 8)

- **`k.access`** (`show`, `share`, `unshare`) changes who may use the plugin's **own** resource kinds, **as the caller**: the port is the core's access service (the one behind `acl.share` and `keith-core acl`), so the rules and audit rows are the same (only the resource's owner or the instance owner;
  a user target must be an active person; a group must exist; one transaction; `acl.share|unshare`). `confirmed` is `k.session.elevated`: widening to `@users` or `@public` is refused (`FORBIDDEN`) unless the call is elevated (a step-up over HTTP), and a chat turn never is. A kind the plugin does not own, and a missing or denied resource, are the one `NOT_FOUND`.
- **`k.people`**: `find(query)` resolves a name or username to an **active** person (`{ id, name, username }`; anyone else is `undefined`), `name(id)` shows a display name of any status. Nothing more of a person is exposed.
- **`k.aclActor`**: the caller as the ACL sees them, for `k.acl.visibleIds(k.aclActor, kind, bits)` (the filter a list or a search applies before its limit). The ids are best passed to SQL as one JSON parameter (`id IN (SELECT value FROM json_each(?))`).
- **`k.audit.ownerAccess(kind, ids)`**: pass the ids of resources the call showed. For the instance owner the host keeps the ones the rules alone would not have shown (root access made the difference) and writes `acl.owner-access` (`acl.md`, "Audit"); for anyone else it does nothing.
- **FTS5.** A plugin migration may create its own full-text index: `CREATE VIRTUAL TABLE plg_<id>_... USING fts5(...)` (a **custom** drizzle-kit migration: `bun run plugin:db:generate <id> --name <label> --custom`, then write the SQL). Every other virtual table is refused. The plugin keeps the index in step (triggers are refused).

## Schedules and wake (P16 step 9)

A plugin that needs a timer declares `onSchedule(fire, ctx)` in its manifest and calls `k.schedule` from an operation. The host owns the clock, the store and the delivery: a plugin never sees the scheduler, a session or an agent.

- **`k.schedule`** (`set(key, { when, catchUp, payload? })`, `get(key)`, `cancel(key)`): one timer per `(plugin, key)`; `set` replaces. `when` is `{ kind: 'once', at }` (epoch ms) or `{ kind: 'cron', expr }` (five fields, evaluated in the **core's local time zone** with `Bun.cron.parse`; a cron whose next two slots are less than 15 minutes apart is refused). `catchUp` is `'once'` or `{ max: n }`: **there is no `skip`**,
  because the scheduler's default drops a slot that came due while the core was down without a trace. `payload` is JSON up to 4 KB (identifiers and short text). A bad key (`[A-Za-z0-9_.-]{1,64}`), time, cron or payload is `INVALID_INPUT`.
- **Storage.** `eharness/scheduler` over the core table `eh_schedules` (migration 0012; `sqliteSchedules` in `packages/db`). The schedule id is `<plugin>:<key>`, its session `plugin:<id>`, its payload `{ plugin, key, data }`. A schedule survives a restart; two cores on one file never fire a slot twice (claims).
- **Ticking.** `createScheduleService` (`modules/plugins/schedule.ts`) ticks every `CoreTiming.scheduleTickMs` (15 s) after boot **and once immediately at start**: a slot that came due while the core was down fires there (late, once, with its original `scheduledAt`). A slot dropped by catch-up (several missed cron slots) is audited by the host as `plugin.<id>.schedule.skipped` with `{ key, scheduledAt, reason }`.
- **Superseded cron slot (F-020, ADR-0027 §16).** For a cron timer, a slot whose next slot is already due is declined by the host before the plugin runs: audit `plugin.<id>.schedule.skipped` with `{ key, scheduledAt, reason: 'superseded' }`, returns `{ fired: false }`. So a boot tick fires at most the latest slot of a cron, and the scheduler fires that one in the same tick. A superseded slot is **not** kept for catch-up (it never enters `plugins.catchup.<id>`), even when the plugin is off. Once timers are unaffected, and a catch-up replay (`late: true`) never goes through this check.
- **Declined while off (P24.6.3, ADR-0027 §17).** A slot that came due while the plugin was not loaded is declined (`plugin-off`) and **kept**: the host writes the latest declined slot per timer key into the settings key `plugins.catchup.<id>` (a JSON list, at most 100 keys). The scheduler cannot leave it unconsumed: a `fire` that resolves `{ fired: false }` still advances `nextFireAt`, and a once timer has no next slot (eharness spec 29 §3). When the plugin loads again, the boot replays each kept slot once with `late: true` and the original `scheduledAt`, after the first tick, then drops it. A cron timer replays only its latest declined slot; a timer cancelled while off is dropped without a replay.
- **`onSchedule(fire, ctx)`** gets `fire = { key, scheduledAt, fireId, payload, late }` and `ctx = { plugin, clock, db, kv, acl, schedule, person(id), wake(request), audit }` (`audit.record(kind, detail, actor?)`, actor `system` by default). It returns `{ fired: true }` or `{ fired: false, reason }` (the plugin audits why; the schedule advances either way). A plugin that is not loaded
  (disabled) declines its slots with an audit row `plugin.<id>.schedule.skipped` (`plugin-off`); a throw is logged, audited (`schedule.failed`) and the slot is **dropped** (a retry loop every tick would be worse).
- **`ctx.person(id)`** reads a person **now** (`{ active, role, has(capability) }`), never cached: the check "is the creator still allowed" belongs in `onSchedule`.
- **`ctx.wake({ to, billTo?, name, text, data?, id, immediate?, failureNotice? })`** hands the wake to the core's delivery service (`docs/specs/delivery.md`), which starts a turn in `front:<to>`: `session.inject('eh.event', { name, text, data }, { wake: true, deliver: 'next-turn', principal, key: id })` with `principal = { id: to }`, plus `billTo` when somebody else pays. The inject `key` is the run id `id`, so the same `id` is delivered once: a repeat call (a retry, a restart) answers the stored result and starts no second turn. The turn **acts as the recipient** (their tools, their ACL; session kind `wake`); `billTo` moves only the cost
  (`budget.md`: the ledger charges `person:<billTo>`). Before it, the recipient must be `active` (the one rule of `people.md`, `countsFor('route', …)`, ADR-0027 §15; a suspended or removed person gets `{ delivered: false, reason: 'recipient-gone' }`, checked first, for every plugin and not only reminders: F-037), and the payer must have at least one front turn left (`FRONT_TURN_BUDGET_USD`, 0.5) in their cap and the global limit, else the result is `{ delivered: false, reason: 'budget' }`. In both cases no turn starts and both are terminal.
- **Results.** `WakeResult` is `{ delivered: true }` (the turn started), `{ delivered: true, queued: { nextAttemptAt } }` (the front agent was briefly unreachable: the core queues the message and retries it at 1, 5 and 30 minutes; the plugin counts it as fired, and a transient outage is never a failure to the plugin), or `{ delivered: false, reason }` with `reason` `budget`, `recipient-gone`, or `unavailable` (the core gave up: no route, or every retry ran out).
- **`immediate`** (optional, default false): the wake is time-sensitive, the person set it for now (a reminder). It is stored with
  `needs.immediate`, so the reach ladder never holds it for the return digest while the person is busy or away (ADR-0034 §6).
- **`failureNotice`** (optional) `{ to, text, key }` (`DeliveryFailureNoticeSchema`): when the wake finally cannot reach the recipient, the core stores `text` as a note for `to` (the creator), once per `key`, with no turn and no cost. The plugin frames the text. Without it a failure is only audited (`delivery.failed`).
  The model reads `<event name="...">text</event>` (eharness neutralises those tags inside `text`).
- **Testing.** `memoryHost` has `host.schedules` (the timers by `<plugin>:<key>`), `host.tick()` (fires what is due on the fake clock, once and cron) and `host.wake` (the requests, `host.wake.result` to simulate an empty budget or a queued wake); the real scheduler, restart and scripted-model tests are in the core (`modules/plugins/schedule.test.ts`, `plugins-reminders.e2e.test.ts`).

## Owner review queue (P16 step 7)

A host facility: an operation can wait for the owner instead of running. Code: `packages/host` (the `review` flag, the guard step, `k.review.request`), `apps/core/src/modules/plugins/reviews.ts` (service), `packages/db/src/repos/reviews.ts` (table `owner_reviews`).

- **Declaring it.** `review: 'owner'` holds every call from a person who is not the owner; `review: { by: 'owner', when(input, actor) }` holds the calls for which `when` is true (a reminder for yourself runs at once, for someone else it waits). The owner is never held by their own review.
  `k.review.request(operation, input, reason?)` files a review of another operation of the same plugin by hand (for a rule only `run` can decide); it throws `CONFLICT` for the owner.
- **Guard step.** After ACL (actor, status, capability, audience, **input parsed**, ACL): the validated input is stored, `run` does not run, and the caller gets a `ReviewTicket` `{ review: { id, status: 'pending', message: 'sent to the owner for review' } }` instead of the operation's output
  (over HTTP: `202`; to the model: the tool result). Audit `plugin.<id>.review.requested` with `{ operation, review }`. A guest, or a host without a queue, is refused as an audience (nothing runs unreviewed). A person has at most **20** pending reviews (`reviews.maxPending`, a setting; `RATE_LIMITED` beyond that), and they expire after **7 days** (`reviews.expiryDays`).
- **The owner** lists and decides through `admin.reviews.list|approve|deny` (`reviews.decide`, owner only, step-up over TCP; the oRPC layer checks it before the handler) and `keith-core reviews list|approve|deny` (`core-cli.md`). This is a separate data flow from eharness' `/attention` list (that one holds agent approvals); the TUI shows the review queue in its own Reviews section of `keith manage` (list, show the request, approve, deny; see "Operator surface"). The payload is shown as **data**.
- **Retention.** A decided review (approved, denied or expired) and its payload are deleted 30 days after the decision: `purgeDecided()` runs in the prune tick (`compose-timers.ts`, P24.6.2, ADR-0027 §19). The purge judges `decided_at`, so a request asked long ago and decided yesterday stays; pending rows are never deleted.
- **Approval** decides the review atomically (`pending` to `approved`, once), then replays the operation through `guard.run` **as the requester** with `approvedReview: <id>` (the review step is skipped, every other check runs): the requester is re-read now, so a suspended or gone requester is refused up front and the review stays pending (the owner can deny it), a lost capability or ACL right is the usual `NOT_FOUND` recorded as `outcome: 'error:NOT_FOUND'`, the input is parsed again, the session is `api` and **never elevated**. The outcome (`ok` or `error:<code>`) is stored on the review; the callee's audit row carries `review: <id>`. A plugin that is not loaded cannot be approved (deny it).
- **Audit and notices.** `plugin.review.approved|denied|expired` (actor the owner, or `system` for the sweep) with ids and the names of plugin and operation, **never the payload**. The owner and the requester get short typed events on their own feed (`plugin.reviews.review_requested|review_decided|review_expired`, `{ review, plugin, operation, ... }`, no payload). The id `reviews` (and `review`) is reserved.
- **Expiry sweep.** `sweep()` runs with the core's prune timer, on every list and before every decision; a pending review past its expiry becomes `expired`, audited, and approving it is `CONFLICT`.

## Testing kit (`@keith/host/testing`)

`alphaPlugin()` and `betaTwoPlugin()` (fixtures that keep tables: the storage tests of the host and the core), `fakeActor(over?)`, `fakeGuest(id?)`, `fakeClock()` (`advance`, `set`), `recordingAudit()` (`rows`, `kinds()`), `frontSession(over?)` and `memoryHost({ plugins })` (with `host.reviews`, `host.approve(id)` and `host.deny(id)` for the review queue) (also an in-memory SQLite with the plugins' migrations applied and `plugin_kv`, as `host.sqlite`; recorded `host.events` and `host.notices`; `host.boot()` runs the plan and each `start`): an in-memory people
directory (`add(id, role?)`, `suspend`, `remove`, `restore`, `grant`, `addGuest`), the in-memory ACL (`memoryAcl`, the plugins' kinds registered), a recording audit, a fake clock and the
real guard (`call(plugin, operation, input, personId, session?)`, `plugin(id)`). `openTestView(host, plugins, { viewId, as, cols?, rows? })` mounts a plugin's terminal view as one viewer over the memory host (the real `ViewHost`, the viewer as principal, never elevated) and gives `screen()`, `key`, `type`, `until`, `resize`, `frames` and `ended()`: how a plugin proves that its view shows a person only what they may see. `hostilePlugin` and `HOSTILE_BYTES` are the hostile-view fixture of P18 (`hostile.raw` prints OSC 52, a title, a hyperlink, device-report requests, a screen reset, DCS, APC, a C1 introducer and a bidi override raw into its frames; `hostile.flood` draws a frame over the cap; `hostile.greedy` prints what `useKeith()` offers): test only, never in `BUILTIN_PLUGINS`. `echoPlugin()` is the one tiny fixture that proves the pipeline (a capability-gated read, a public
operation, a resource with an ACL rule, a rate limit, a failing one, one that reports the actor it saw, a dangerous one, one hidden from the model, one that returns undeclared fields).
A plugin's tests import only this. The staleness test (two principals through one session-resolved tool get two actors) lives in `guard.test.ts` and, against a real eharness session, in the core adapter's tests.

## Compile to eharness and load (core)

`apps/core/src/modules/plugins`:

- `compilePlugin(plugin, deps)` returns one eharness plugin named `k-<id>` that contributes **one tool source** (`defineToolSource({ id: 'keith:<id>', refresh: 'turn' })`).
  `list(ctx)` resolves the actor from `ctx.principal.id` (people directory, now) and returns only the operations `guard.visible(op, facts, 'ai')` allows, as AI SDK tools (`inputSchema` =
  the operation's `input`, `metadata: { risk, source }`; an `outside` operation also gets a `toModelOutput` that puts its result, as JSON text, inside eharness `untrustedContent(text, { source: 'plugin', name: <tool name> })`, ADR-0036 §6). Each tool's `execute` reads **`ctx.principal` at call time** and calls `guard.run`; nothing about a person is captured when the tool is listed.
  Session facts come from the context (`front`, `worker` for a child session, `wake` for a wake turn) and are never elevated.
- `tool.approve` decides from the tool **name** and static tables only (it is re-run on re-validation): a `dangerous` operation asks the person (`user-approval`); a tool name of the plugin that is
  not an operation exposed to the AI is denied. Audience and capability are **not** decided there: they depend on the live actor, so they are enforced by the catalog and by the guard in `execute`.
- `createPluginHost({ plugins, ... })` is the loader. The list is **static** (`BUILTIN_PLUGINS`, built in; no discovery, no install flow). Boot, in list order, per plugin and isolated: enabled
  setting (`plugins.<id>.enabled`, default true, read at boot) -> register capabilities -> register resource kinds -> `start(ctx)` -> compile. An error in any of them is logged
  (`plugins: <id> failed: ...`), the plugin is marked `failed` with a short reason, what it registered is withdrawn where possible, and the core keeps booting. `host.status()` lists
  `{ id, version, state: 'loaded' | 'disabled' | 'failed', reason? }`. Two plugins with one id: the second is `failed`.
- Wiring: `createPlugins` (`compose-plugins.ts`) builds the host from the people directory (`createPeopleDirectory`: person row and capabilities read per call), the core ACL and kind table, the capability
  registry, the audit and the settings; `createCore` hands `pluginHost.harnessPlugins()` to the front agent (workers do not get plugin tools yet) and exposes `core.plugins`. `start` that does not settle in 10 s fails
  the plugin. `CoreOptions.plugins` replaces the built-in list in tests.
- The directory returns the most restrictive session defaults in `ctx.actor` (not elevated, zone `public`); the facts of a call are in `k.session`.
- Enabling and disabling are operator steps ("Operator surface"): the setting is saved at once and read at the **next boot** (no live toggling: ADR-0016 said live, this is the simpler restart-only rule). Installing and updating stay out of scope.

## HTTP and OpenAPI (core)

- `createPluginRoutes({ host })` (`modules/plugins/http.ts`) is mounted by thalamus (`createApp({ plugins })`), which resolves the principal once and hands over `{ principal, via }`.
- `POST /plugins/<id>/<op>`: the usual bearer (`auth.md`); body is the JSON input (at most 64 KB, `413` otherwise and for every path alike); the answer is the parsed output as JSON. The route runs **the same `guard.run`** with
  `session: { kind: 'api', method, elevated }` taken from the resolved credential. Errors are `{ error: { code, message } }` with the status above; `401` without a principal. An unknown plugin,
  an unknown operation, a disabled plugin, an operation not exposed over HTTP, a method other than `POST` on an operation path and a denial are one `404` with the same body. A body that is not JSON is handed to the
  guard as "no input": a caller who may not use the operation gets the `404` first, only an allowed caller learns the input is bad (`400`). `Retry-After` (seconds) accompanies `429`.
- `GET /plugins/openapi.json`: an OpenAPI 3.1 document of the operations **visible to the caller** (`guard.visible(op, facts, 'http')`), schemas from zod `toJSONSchema` (input and output, the
  `$defs` hoisted). Different callers get different path sets. `buildOpenApi(operations, options?)` (`@keith/host`) is pure; a schema that refers to itself (`$ref: "#"` in zod's output) and every `$defs` are hoisted into `components.schemas` under names unique to the
  operation. A golden-file test (`packages/host/src/__golden__/echo.openapi.json`) pins the output for the fixture plugin; `x-keith-risk`, `x-keith-audience` and `x-keith-capability` carry the declaration.

## Capabilities (closed set at runtime)

`permissions.md` keeps the closed list for oRPC procedures (`CAPABILITY_IDS`). A plugin's `permissions` are **registered into the same set at load** through the capability registry
(`createCapabilityRegistry`, `@keith/contracts`): an id may not clash with a core id or another plugin's; role defaults are the manifest's `roles`; the owner role holds every registered id.
`Capabilities.of(principal)` is the role table plus registered role defaults plus the person's grants that are registered ids. Tests walk every procedure (`packages/contracts`) and every operation of the loaded plugins (`packages/host/src/capabilities.test.ts`, `apps/core/src/plugins.e2e.test.ts`) and fail on an
unknown capability: the plugin ids come from manifests (`core.plugins.capabilities()`), not from a hand-written list. A plugin capability can also be **granted to one person**: `admin.people.grant` takes any string and the grants service checks it against the live registry
(`BAD_REQUEST` for an unknown id, or one whose plugin is not loaded); `auth.whoami` lists every id the person holds, core or plugin. A stored grant of an id nobody registers now (plugin off) is kept and not reported or applied.

## Layout of a plugin (`plugins/<id>/`)

`plugin.ts` (the only file the loader imports, default export from `defineKeithPlugin`), `operations/*.ts` (one file per operation keeps files short), `schema.ts`, `migrations/` (generated),
`config.ts`, `*.test.ts`, `README.md`, `package.json` (a workspace package, `catalog:` versions). Imports: only `@keith/host` and `@keith/contracts` (`check-imports`).

## Built-in plugins

`BUILTIN_PLUGINS` (`modules/plugins/builtin.ts`): **Notes** (`plugins/notes.md`) and **Reminders** (`plugins/reminders.md`), both **enabled by default**; the owner turns one off with `keith-core plugin disable <id>` (the setting `plugins.<id>.enabled = false`, read at boot). A plugin with tables ships migrations that `bun run db:migrate` applies.
The testing kit re-exports the ACL kit (`leakCheck`, `SHARING_CASES`, `CASE_*`) so a plugin's tests import only `@keith/host/testing`.

## Operator surface

Code: `apps/core/src/modules/plugins/admin.ts` (`createPluginAdmin`), `procedures.ts` (`pluginProcedures`), `apps/core/src/cli/plugin-command.ts`, `apps/tui/src/features/manage/plugins` and `reviews`.

- **Authority.** New owner-only capability `plugins.manage` (in `OWNER_ONLY_CAPABILITIES`: a grant is refused). `admin.plugins.list|show` are reads; `admin.plugins.enable|disable` are `sensitive` (a step-up over TCP) and audited (`plugin.enabled`, `plugin.disabled`, detail `{ plugin, changed, effective: 'next-boot' }`).
- **Status.** `state` is what this process did at boot: `enabled` (loaded), `disabled` (setting off) or `failed` (with a short `reason`). `nextBoot` is what the setting says now; `restartPending` is true when the two differ. **Enable and disable take effect at the next boot**: nothing is unloaded or loaded live (the tools and routes of a plugin switched off stay until the core restarts, and a disabled plugin declines its due timers with an audit row, as before). A failed plugin is not toggled (the cause is fixed first). Data of a disabled plugin is kept.
- **`show`** adds the description, the capabilities the manifest declares (id, text, default roles), every operation (name, capability, audience, risk, whether it can be held for review, exposed to the AI and HTTP), the timers the plugin has waiting (count and next slot, read from the schedule store; `null` when not loaded) and the reviews waiting. A disabled plugin still shows its declared operations (from the static list).
- **CLI** `keith-core plugin list|show <id>|enable <id>|disable <id>` (`core-cli.md`), over the socket; the output of enable and disable says the change applies at the next boot.
- **TUI** (`keith manage`, owner only, after Groups): **Plugins** (rows `PLUGIN STATUS VERSION REVIEWS`; actions Show details (a read-only note), Disable or Enable (confirm; a step-up goes through the usual PIN prompt)) and **Reviews** (pending reviews as `REQUESTER OPERATION ASKED PAYLOAD (data)`; actions Show the request (the full input, labelled as data from the requester, never an instruction), Approve (confirm; runs as the requester), Deny (optional reason)). The sections follow the Groups and People patterns (`tui.md`).
- **Grants.** `admin.capabilities.list` (`people.manage`) lists every capability a person can hold now (core ids and the loaded plugins', with the owner plugin id and the owner-only flag): the TUI grant picker uses it, so a plugin capability appears while its plugin is loaded.

## Later

The `tui` slot is specified in `plugin-views.md` (P18).

## Guests in the guard (P17 step 6)

A guest is an actor of the guard only while its session lives: the core's directory is `withGuests(peopleDirectory, live)` (`modules/guests/actor.ts`). A principal `guest:<id>` resolves to `{ kind: 'guest', personId: null, role: null, zone: 'public', elevated: false, via: 'tcp' }` with **no capability** and status active when the registry holds the session, to nothing otherwise (an ended or made-up id is the one refusal). The guest agent's session is opened with `{ principal: { id: 'guest:<id>' } }` (`GuestSession.session()`), no lock. Consequences, each tested:

- only `audience: 'public'` operations pass (`authenticated` capability), and only the ones with `expose.guest` are offered to the model; the guest agent holds only the compiled plugins that own an allow-listed tool, and its static allow-list (`GUEST_TOOL_ALLOWLIST`: `notes_public_get`, `notes_public_list`) is what `turn.prepare` offers and `tool.approve` enforces;
- the ACL actor is `{ kind: 'guest', id }` (guest ceiling, `acl.md`); `k.session.elevated` is false whatever the caller of the guard says, so a widening is refused;
- an operation with a `review` rule is refused for a guest (`NOT_FOUND`), never queued;
- `k.people.find` and `k.people.name` answer nothing; `k.access.show|share|unshare` throw the one refusal; `k.notify` throws (only a person can be told); `k.emit` defaults to no recipient;
- audit rows of a guest name `guest:<id>` (the random session id), never an address.
