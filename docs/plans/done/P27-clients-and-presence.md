# P27 — Clients and presence (parietal)

Nov 10, 2026 · status: **done Nov 10, 2026** (Haiku implementers, orchestrated by Sonnet; `bun run check` 3274 pass and `bun run smoke` 63 steps pass) · depends on: P25 (route interface), P26 (removal registry, backup before the migration; migration number is the next free one) · ADR: 0025, 0023 §5 (also 0020 §1 to §3, 0027 §9) · closes: ADR-0025 §1 to §5, ADR-0023 §5; supports F-017 (documentation part, owner P24.2.4, see step P27.5.3) (P22 milestone M2), FD10-06, FD10-07, FD10-08, FD10-12, FD10-14 (second review round, `docs/flow-review/2026-11-10-folded/`), doc gap 1 (activity feed contract)

## Goal

Keith knows which of a person's clients are connected and in use, computes whether the person is active, idle, away, busy or offline, and can answer
"is Duta free?" with exactly what Duta chose to share. A notification or a visual can be sent to the client the person is looking at. Nothing about
presence reaches a model context except a line that a disclosure rule released.

## Why

- ADR-0025 §1 signals (7 days) and client records, §3 presence in code, §4 disclosure as a rule not a prompt, §5 routing by presence.
- ADR-0020 §2 and §3: isolation is enforced by code; another person's data enters a model context only through a rule that put it there, and a turn runs as one principal.
- ADR-0023 §5: a client is a node for one person, with capabilities (`notify`, `open.view`); only that person's turns may call them.
- This plan owns the client capability registry and the client route that P31 reuses (ids exactly as ADR-0023 §5: `notify`, `open.view`, `location.share`) and the presence ports that P28, P29 and P30 consume (`lastSign`, `disclosedFor`, `PresenceOverlay`).
- P25 leaves one seam (`RoutePlanner`, `docs/specs/delivery.md`) for presence routing; this plan fills it.
- ADR-0024 (protocols, P28) needs `absence` triggers and `notify` routing that read presence; the agenda that ADR-0025 §2 describes is P28.
- ADR-0027 §9 and F-017: nodes (and clients) belong to Keith's layers by a written rule; the self layer wording belongs in the docs this plan touches anyway.

## Scope

In:
- Region `parietal` (`apps/core/src/modules/parietal/`, spec `docs/specs/parietal.md`): client registry, signals, presence computation, disclosure, the `presence` front tool, the brain event.
- `packages/client`: a presence reporter (register, heartbeat, activity, goodbye). TUI: reporter wiring, a `/presence` panel, `/busy` and `/free`, the `notify` capability (toast).
- Owner CLI `keith-core presence [username]` (raw, audited).
- A manual busy status as the first overlay source, and an overlay interface so P28's agenda plugs in without a change here.
- The presence `RoutePlanner` for P25.

Out (with where it goes):
- **Agenda** (intentions extracted by the front agent, "meeting at 9", confirmation in chat): P28 (ADR-0025 §2). This plan only defines the overlay interface it will implement.
- Location (`device.location`): the schema lists the signal type but the core refuses it until a mobile client exists (ADR-0025 consequences).
- Web and mobile clients; push providers; serving `location.share` (the registry lists it, the TUI never announces it): later plans. `open.view` is served by the TUI in P31.5.4.
- Protocol engine and `absence` triggers (P28); rooms ("everyone is here", P29+).
- A durable outbox for clients that are offline: P25's retry (`queued`) and its front-session fallback are the queue.
- eharness: no gap found; clients talk to Keith's own RPC, notices travel in the existing activity feed (a record on the person's front session id, which `activityFilter` already limits to that person).

## Design

### Contracts (`packages/contracts/src/presence.ts`, exported from `index.ts`)

```ts
ClientKindSchema = z.enum(['tui', 'web', 'mobile'])
ClientCapabilitySchema = z.string().regex(/^[a-z]+(\.[a-z]+)?$/)           // 'chat', 'notify', 'open.view', 'location.share' (ADR-0023 §5 ids, never prefixed with 'client.')
ClientRegisterSchema = z.object({ id: z.string().uuid(), kind: ClientKindSchema, label: z.string().max(40),
  capabilities: z.array(ClientCapabilitySchema).max(10), version: z.string().max(40) })
ClientRecordSchema = ClientRegisterSchema.extend({ personId: z.string(), firstSeenAt: z.number(), lastSeenAt: z.number(),
  lastActiveAt: z.number().nullable(), online: z.boolean() })
SignalTypeSchema = z.enum(['client.connected', 'client.disconnected', 'client.active', 'device.location', 'node.event', 'activity'])
PresenceStateSchema = z.enum(['active', 'idle', 'away', 'busy', 'offline'])
PresenceSchema = z.object({ personId: z.string(), state: PresenceStateSchema, reachableOn: z.array(z.string()),
  activeClient: z.string().nullable(), note: z.string().max(200).nullable(), asOf: z.number() })
DisclosureLevelSchema = z.enum(['none', 'state', 'detail'])
DisclosureAudienceSchema = z.union([z.literal('owner'), z.literal('@users'), z.string().regex(/^group:[A-Za-z0-9_-]{1,64}$/)])
PresenceStatusSetSchema = z.object({ busy: z.boolean(), note: z.string().max(200).optional(), minutes: z.number().int().min(1).max(1440).optional() })
```

Procedures (`contract.ts`, capability `chat`, so every signed-in person; guests have no person and no access): `presence.clients.register`, `presence.clients.heartbeat { id, active }`,
`presence.clients.goodbye { id }`, `presence.clients.ack { id, deliveryId }`, `presence.clients.list`, `presence.clients.remove { id }`, `presence.mine` (own presence, clients, status, disclosure),
`presence.setStatus`, `presence.disclosure.set { audience, level }`, and owner-only `admin.presence.read { person }` (raw presence and clients, audited). A client id registered by another person is `CONFLICT`
(no hijack); at most 20 clients per person; a heartbeat sooner than 5 s after the last is ignored; register is limited to 10 a minute per person.
Brain region: `parietal` added to `BrainRegionSchema` (`packages/contracts/src/brain.ts`) with the event `brain.parietal.presence { personId, state, previous }` and `brain.parietal.deliver { clientId, deliveryId, capability, name }`.

### Client capability registry and route (owner: this plan; P31 phase 5 reuses it)

`modules/parietal/capabilities.ts` holds the registry of what a client can be asked to do: `ClientCapabilitySpec = { id: 'notify' | 'open.view' | 'location.share', risk, input: ZodType, output?: ZodType }` (`notify { title?, text (500), level? }` write; `open.view { view: 'plugin:<id>:<view>' | 'room:<id>' | 'tasks' | 'protocols', args? }` write; `location.share { precision: 'city' | 'coarse' }` external, opt-in on the client). `parietal.callClient(personId, capability, input, source)` is the one route: it picks a client (`activeClient`, then the most recent reachable client that announced the capability), sends the feed record `brain.parietal.deliver { clientId, deliveryId, capability, name }` to the person's feed only, and waits for `presence.clients.ack { id, deliveryId, ok, result? }` (10 s, one-shot, accepted only from the same person and client id). The P25 planner and P31's `client_call` tool both call it; nothing else sends to a client.

### Ports (exported, consumed by P28, P29, P30; nobody reaches into the compute)

- `lastSign(personId): Promise<number | null>`: the newest signal of the person of type `activity`, `client.active` or `client.connected` (after a sign-in). Never `node.event`, never a heartbeat without `active`, never an offline command. The actor is always the person, so no separate "owner-made" flag exists.
- `disclosedFor(viewer, subject): { level, line }`: the rule below (earlier name `discloseTo`).
- `PresenceOverlay` provider interface and `parietal.addOverlay(overlay)`; P28's agenda implements one and registers it (agenda feeds presence, never the reverse).
- They are listed in `docs/specs/parietal.md` "Ports" (P27.1.1) and are the only entry points other regions may use.

### Data model (migration: next free number, additive, generated, backup per ADR-0027 §3)

| Table | Columns |
| --- | --- |
| `clients` | `id` PK, `person_id`, `kind`, `label`, `capabilities` (json), `version`, `first_seen_at`, `last_seen_at`, `last_active_at`; forgotten after 90 days unseen |
| `presence_signals` | `id` PK (uuidv7), `person_id`, `client_id` null, `type`, `at`, `detail` (json, at most 200 bytes, no text of messages); index `(person_id, at)`; kept 7 days; `client.active` stored at most once a minute per client |
| `presence_status` | `person_id` PK, `state` (`busy`), `note`, `until`, `set_at` (the manual overlay) |
| `presence_disclosure` | `(person_id, audience)` PK, `level` |

Pruning in the existing prune tick (`apps/core/src/compose-timers.ts`): signals older than `CoreTiming.signalsKeepMs` (7 days), clients unseen 90 days, expired status rows.

### Computation (pure, in code, `modules/parietal/compute.ts`)

Constants in `CoreTiming`: `clientHeartbeatMs` 20 000, `clientTimeoutMs` 60 000, `activeWindowMs` 120 000, `awayAfterMs` 1 800 000, `presenceEveryMs` 60 000.

```
online     = clients whose last_seen_at >= now - clientTimeoutMs
lastActive = max(last_active_at of online clients, newest `activity` signal)
overlay    = first of [manual status not expired, ...registered overlay sources]   -> busy + note + until
state      = overlay ? busy
           : lastActive >= now - activeWindowMs ? active
           : online.length > 0 ? (lastActive >= now - awayAfterMs ? idle : away)
           : offline
reachableOn  = online client ids, most recently active first
activeClient = state is active (or busy with recent activity) ? online client with the newest last_active_at : null
```

`PresenceOverlay = { id: string; busy(personId: string, now: number): { note: string | null; until: number } | undefined }` is registered with `parietal.addOverlay`; P28's agenda
implements and registers one (no edit of this compute). Recomputed on every signal and every `presenceEveryMs`; a change of state emits `brain.parietal.presence` on the person's front session id (so only they receive it) and an audit-free log line.
The `activity` signal is written by the thalamus `routed` hook (a message was sent from any client, or from a script).

### Disclosure (a rule in code, `modules/parietal/disclose.ts`)

Levels `none`, `state`, `detail`. Defaults (ADR-0025 §4): the instance owner sees `detail` of everyone, members see `state` of each other and of the owner. A person sets a level per audience: `owner`, `@users`, `group:<id>`
(groups of `acl.md`; a viewer in several audiences gets the **highest** level). `disclosedFor(viewer, subject)` returns `{ level, line }`:
`none` gives no line; `state` gives `busy` or `available` (active and idle read `available`; away and offline read `not available`, so the line never separates "away" from "offline"); `detail` gives the state, the note and the until time, never client ids, counts or kinds.
A person always sees their own full presence. The owner reading `detail` of a member writes `acl.owner-access` with kind `presence` (at most one row per viewer, target and hour).
The rule applies to what a **model** may say. The owner's CLI `keith-core presence <username>` and `admin.presence.read` return the raw record (audited `presence.read`), so a member cannot hide from the owner's own console, but cannot be quoted by the front agent either.

### The `presence` tool (front agent)

`modules/parietal/tool.ts` is a plugin like `nodesStatus` (`modules/motor/status.ts`), added to the front agent's plugin list in `modules/wernicke-broca/agent.ts`: tool `presence({ person })`, `person` is a username, a name or `me`.
The viewer is the turn's principal (`ctx.principal`), never an argument. Output `{ disclosed: boolean, line?: string }`: an unknown person, a suspended person and a refusal all answer `{ disclosed: false }` (no existence leak).
One sentence in `FRONT_INSTRUCTIONS` says: use `presence` to answer whether someone is free; it only returns what the person shares. A worker does not get the tool.
Isolation proof (ADR-0020 §2): a scripted-model test where the viewer is a member and the target is the owner or another member, for each level; the stored session of the viewer is searched for every raw field (client ids, labels, signal times) and finds none.

### Reporter and clients

`packages/client/src/presence.ts`: `createPresenceReporter(client, { kind, label, capabilities, version, store })` registers the client (the id is a uuid kept in `client-state.json` next to `client.json`, via `clientStatePath` in `identifier-memory.ts`), heartbeats every 20 s with `active: true`
only when `touch()` was called in the last 30 s, sends `goodbye` on `stop()`, re-registers after a 401 recovery or a core restart (`onBoot` in `connection-monitor.ts`), and exposes `onNotify(handler)` for `brain.parietal.deliver` records of its own `clientId` (it acks through `presence.clients.ack`). It never throws: presence is a convenience.
The guest client does not use it. TUI: `apps/tui/src/features/presence/{index.ts,use-presence.ts,presence-panel.tsx,presence-state.ts}`; `touch()` is called from the key handler (`use-app-keys.ts`) and on a chat send; capabilities `['chat', 'notify']`; a received notify shows a toast (existing toast layer, `app-toast.test.tsx` style).
Slash commands in `features/chat/slash.ts`: `/presence` opens the panel (compact: your state, your clients with a dot for online, then the three disclosure rows for `owner`, `@users` and each group; `↑↓` select, `enter` cycles `none, state, detail`, `esc` closes); `/busy [30m|2h] [note...]` and `/free` call `presence.setStatus`.

### Routing for P25 (`modules/parietal/planner.ts`)

`createPresencePlanner({ parietal, front, push })` implements P25's `RoutePlanner`. `plan(person, needs)`:
1. `needs.capabilities` non-empty: client routes in order `activeClient`, then reachable clients by `last_active_at` descending, each only if its `capabilities` include every listed capability; with `fanout: 'all'` every such client gets it (P29); a `ClientRoute.send` is `parietal.callClient` above (the feed record `brain.parietal.deliver`, 10 s for the ack); no ack is `unavailable`, so the next route is tried.
2. Always last: the front-session route of P25 (the message is stored in the person's chat, so nothing is lost and the person finds it on the next connection).
3. No capability needed (the default wake): the front-session route only (a turn in the chat appears on every client attached to the session, so `activeClient` is not needed).
The deliver text is clipped to 200 characters in the feed record (the activity store keeps events like any other; the full text still goes to the chat). Compose swaps the default planner for this one.

### Settings, audit, errors

No new core settings (the constants live in `CoreTiming`). Audit kinds: `client.registered` (first time only), `client.removed`, `presence.status.set`, `presence.disclosure.set { audience, level }`, `presence.read` (owner raw read), `acl.owner-access` for `detail` reads. Never a signal's content, a location or a message.
Errors: `CONFLICT` (client id of another person, 20 clients), `BAD_REQUEST` (bad capability, minutes), `FORBIDDEN` (`admin.presence.read` for a non-owner).

## Phases

### Phase 1 — Contracts, spec, tables

Goal: the contract and storage exist, tested, with nothing wired.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P27.1.1 | Write the spec and the contracts, add the region to the brain schema | `docs/specs/parietal.md` (new), `packages/contracts/src/presence.ts`, `packages/contracts/src/brain.ts`, `packages/contracts/src/index.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `docs/specs/brain-events.md` (events, regions list); the spec has the sections "Ports" and "Client capability registry" | parietal.md, brain-events.md | `presence.test.ts` (schemas, capability regex, id uuid), `brain.test.ts` (new events parse) | types pass |
| P27.1.2 | Tables and repos (the tables go in a new area file of `packages/db/src/schema/`, see P23.1.0; each table gets its row in the db.md retention inventory, P26.1.5) | `packages/db/src/schema/`, generated migration, `packages/db/src/repos/clients.ts`, `presence-signals.ts`, `presence-disclosure.ts`, `packages/db/src/index.ts`, `docs/specs/db.md`, `scripts/exports.snapshot.json` (`--write`) | db.md Tables | repo tests: upsert and cap of 20 clients, `client.active` coalescing, prune by age, disclosure upsert, migration test with old rows unchanged | repo tests pass |
| P27.1.3 | Procedure metadata and capability table | `packages/contracts/src/contract.ts`, `packages/contracts/src/capabilities.test.ts` (every procedure has metadata) | permissions.md (procedures table) | the existing capability coverage test lists the new procedures | check passes |
| P27.1.4 | Document the activity feed (doc gap 1): `docs/specs/thalamus.md` "Activity feed" gets a table of every record name (`budget-changed`, `node-changed`, `brain.*`, `room.event`, plugin events, `brain.parietal.deliver`, and the records earlier plans already emit with a schema: `identity.changed` (P23.1.10) and `delivery.failed` (P25.1.3)) with its payload schema and who receives it; add zod schemas for `budget-changed` and `node-changed` in `packages/contracts/src/activity.ts`; later plans (P28, P30) add their records to the same table and file in their own steps. | `docs/specs/thalamus.md`, `docs/specs/brain-events.md`, `packages/contracts/src/activity.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `apps/core/src/modules/thalamus/activity-filter.test.ts` | thalamus.md Activity feed, brain-events.md | each record name the core emits parses with its schema | no record is emitted without a schema |

Phase gate: `bun run check`.

### Phase 2 — The parietal module

Goal: signals and clients become presence, in code, with events.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P27.2.1 | `computePresence`, the overlay interface and the exported ports `lastSign`, `disclosedFor` (stub until 4.1), `addOverlay` | `apps/core/src/modules/parietal/{compute,overlay,index}.ts`, `compute.test.ts` | parietal.md "Computation" | table-driven on a fake clock: every state and every boundary, busy over offline, manual status expiry, `activeClient` choice, activity without a client, two clients; `lastSign` counts `activity`, `client.active` and `client.connected` and ignores `node.event` and a heartbeat without `active` | all rows pass |
| P27.2.2 | Service: register, heartbeat, goodbye, signals, recompute timer, events; registers clients, signals, status and disclosure in the P26 removal registry (`keep` leaves them, `export` lists them, `purge` deletes them) | `apps/core/src/modules/parietal/{service,procedures,removal}.ts`, `apps/core/src/compose-timers.ts` and `compose-regions.ts` (timer, prune, `CoreTiming`), `apps/core/src/platform/rpc.ts` (audit table) | parietal.md "Service", thalamus.md (boot order, timers) | `service.test.ts`: register/hijack refusal/20 cap/rate limit, heartbeat timeout turns a client offline and emits one event, goodbye, restart keeps clients and last activity; a removed person's clients, signals, status and disclosure are purged by the registry | tests pass |
| P27.2.3 | `activity` signal from the thalamus hook | `apps/core/src/modules/thalamus/app.ts` (`chat.validate`), `thalamus/index.ts`, `docs/specs/thalamus.md` | thalamus.md | a routed message writes one `activity` signal for the person; a guest writes none | test passes |
| P27.2.4 | Owner CLI and raw read | `apps/core/src/modules/parietal/procedures.ts` (`admin.presence.read`), `apps/core/src/cli/presence-command.ts`, `apps/core/src/cli/program.ts`, `docs/specs/core-cli.md` | core-cli.md, permissions.md | owner reads a member: raw record plus audit `presence.read`; delegate gets `FORBIDDEN` | tests pass |

Phase gate: `bun run check` and `bun run smoke` (core boots with the timer and migration).

### Phase 3 — Clients and the TUI

Goal: the TUI is a registered client with a heartbeat, and the person sees and edits their own presence.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P27.3.1 | Presence reporter; `client.json` and `client-state.json` are written atomically (temp file, mode 0600, rename) | `packages/client/src/presence.ts`, `packages/client/src/config.ts` (atomic write, was an in-place `writeFileSync`), `packages/client/src/index.ts`, `packages/client/src/presence.test.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `docs/specs/client.md` | client.md Public API | fake client: register once, heartbeat cadence, `active` only after `touch`, re-register after boot id change, goodbye on stop, never throws when the core is down; a crash between write and rename leaves the old file intact and mode 0600 | tests pass |
| P27.3.2 | TUI wiring | `apps/tui/src/features/presence/*`, `apps/tui/src/use-app-keys.ts`, `apps/tui/src/app-root.tsx`, `apps/tui/src/features/chat/slash.ts`, `apps/tui/src/app-commands.ts`, `docs/specs/tui.md` | tui.md (slash list, panel) | `presence.test.tsx`: key press touches, panel shows state and rows, cycling a level calls `presence.disclosure.set`, `/busy 2h in a meeting` and `/free`; `cli.pty.test.ts` style check that the TUI registers a client (pressUntil) | tests pass |
| P27.3.3 | Brain region in the UI | `packages/ui/src/orb/brain-trace.ts`, `packages/ui/src/theme.ts`, `apps/tui/src/features/brain/brain-state.ts`, `apps/tui/src/features/home/*` (`regionOf`), `docs/specs/tui-design.md`, packages/ui AGENTS rules read first | brain-events.md, tui-design.md | `home-state.test.ts` and ui `theme.test.ts` include `parietal` | trace lights the new region |
| P27.3.4 | **FD10-06 and FD10-07: the words of the text login and logout.** The text flows (`--password`, `--device`, `--token`) take `--remember` (the same 30 day lifetime and `remember: true` as the TUI's "remember this device"); the success line says "Run keith to start" only when the login was remembered, else "Saved for scripts and `keith whoami`; `keith login` without a flag keeps a login for the app." `keith logout` prints the "credential is revoked" sentence only when the revoke happened; when `signOut` reports `unreachable` it prints "Logged out on this device; the core could not be reached, so the credential is still valid there: keith-core devices revoke <id>" and nothing about revoking. | `apps/tui/src/commands.tsx` (`login` 160-275, `logout` 390-405), `apps/tui/src/login-view.ts` (`loginDone`, `passwordDone`), `apps/tui/src/commands.test.ts` | tui.md:23 and :25 (the success texts, `--remember`), client.md (Remembered and saved logins) | `commands.test.ts`: `--password` without `--remember` prints the script wording and the next `keith` opens signed out as documented; with `--remember` the file holds `remember: true`; logout with a down core prints one warning and no "revoked" line | no line contradicts the state of the credential |
| P27.3.5 | **FD10-08: a new sign-in revokes the login it replaces.** `writeClientConfig` returns the entry it overwrote; `keith login` and a remembered TUI sign-in call `replaceClientConfig(next)`: when the old entry holds another credential, it asks that core to revoke it (`auth.logout` with the old token, 3 s timeout); a failure prints "could not revoke the previous login on <core>: keith-core devices revoke <id>" and the new login is still saved. The same credential written twice is a no-op. | `packages/client/src/config.ts:35-41`, `apps/tui/src/sign-out.ts` (`signOut`, reuse of the revoke part) and `revokeSelf` of `packages/client/src/client.ts` (the TUI reaches core only through the client, rule 4), `apps/tui/src/commands.tsx:168,270`, `apps/tui/src/app-session.tsx:62-64`, `packages/client/src/config.test.ts` | client.md (Remembered and saved logins), tui.md:25 | `config.test.ts` and `commands.test.ts`: replacing a login revokes the old token on the fake core once; an unreachable old core keeps the new login and warns; same token twice revokes nothing | `devices list` shows no credential that nobody holds |
| P27.3.6 | **FD10-12: the identity and the Manage sections follow server changes.** The `identity.changed` activity record is already emitted by the core on the person's front session id (P23.1.10: the people and auth services call `onAccessChanged` when a capability is granted or revoked and when the status, role or `can_login` changes; `activityFilter` shows it to that person only); this step only consumes it: the TUI feed calls `reloadIdentity()` on it, so a section appears or disappears without a restart. Manage actions address a person by the row's stable id, not by the username shown (`personLabel`). | `apps/tui/src/use-app-feed.ts:46-56`, `apps/tui/src/features/manage/people/people-actions.ts:45`, `docs/specs/thalamus.md` (the record table of P27.1.4 lists `identity.changed`) | thalamus.md (Activity feed table), tui.md:90 and :291 | `use-app-feed` test: the record triggers one `whoami`; a real-core test: grant `people.manage` to a member with an open TUI and the section appears; an action on a row whose username was renamed and re-added still addresses the original id | a granted or revoked section shows at once |
| P27.3.7 | **FD10-14: the sign-in controller stores a credential only for a sign-in that is still wanted.** `finish` asks `whoami` first (the credential is held in memory, 3 s), then writes: a cancel or back during the wait stores nothing and revokes the fresh credential best effort (`auth.logout` with it); a `whoami` that times out still saves (the core accepted the login moments ago); a file failure after the vault write removes the vault entry and revokes the server session before it reports `save_failed`. | `packages/client/src/sign-in.ts:320-337` (`finish`), `apps/tui/src/app-session.tsx:58-65` (`appStore`), `packages/client/src/sign-in.test.ts` | client.md sign-in controller ("saved when the core accepts it and the person is still there") | `sign-in.test.ts`: remember ticked then cancel during the wait leaves `client.json` and the vault empty and one `auth/logout` call; a store that throws leaves no vault entry and one revoke; a slow `whoami` still saves | a cancelled sign-in leaves nothing on disk |
| P27.3.8 | Smoke block for phase 3 (P22 rule: a step writes it) | `scripts/smoke/presence.ts` (a one-line hook in `scripts/smoke.ts`), `docs/manual-testing.md` | manual-testing.md (presence scenario) | `bun run smoke`: the real TUI registers a client (match on `Bun.stripANSI` text), `keith-core presence <user>` shows `active`, a `notify` reaches the TUI as a toast | `bun run smoke` stays near 40 s and passes |

Phase gate: `bun run check` and `bun run smoke` (TUI registers a client, `keith-core presence` shows it).

### Phase 4 — Disclosure and the front tool

Goal: Keith can say what a person shared, and nothing else.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P27.4.1 | `disclosedFor`, settings procedures, owner-access audit; register `presence.read`, `presence.status.set`, `presence.disclosure.set` in `AUDIT_SUBJECT_FIELDS` and `registerMySummary` (P23.2.3) | `apps/core/src/modules/parietal/{disclose,procedures}.ts`, `disclose.test.ts`, `packages/contracts/src/audit.ts`, `apps/core/src/modules/audit/mine.ts` | parietal.md "Disclosure", people.md / acl.md (audiences) | defaults for owner and members; highest level across `@users` and groups; `none`; self sees all; line never has client ids; one `acl.owner-access` row per hour | tests pass |
| P27.4.2 | `presence` tool and instruction sentence | `apps/core/src/modules/parietal/tool.ts`, `apps/core/src/modules/wernicke-broca/agent.ts`, `apps/core/src/compose-regions.ts` | wernicke-broca.md, parietal.md "The presence tool" | tool unit tests (unknown, suspended, refused look the same; viewer comes from the principal) | tests pass |
| P27.4.3 | Isolation proof | `apps/core/src/presence-isolation.e2e.test.ts` (real core, scripted models) | parietal.md "Isolation proof", ADR-0020 §2 | member asks about owner and about another member at each level; the stored messages of the viewer contain no raw field; a worker session has no `presence` tool | passes; it is the leak kit for presence |
| P27.4.4 | **Eval scenario `presence` (R13, one of the four in P22 "Shared items").** The `presence` tool never reveals a note the subject did not disclose. `apps/core/evals/presence/` follows `apps/core/evals/news/`: `run.ts` with `--scripted` (offline, scripted model, no key, no cost) and the default real-model mode (`OPENROUTER_API_KEY`, `--max-usd` cost cap, report `data/evals/presence-<date>.json`); `cases.ts` has persons with notes at each disclosure level (`none`, `busy`, `note`, `detail`), asks the front agent as another person for the subject's state, location and note in plain and indirect ways, and a scorer that fails when a planted note appears above its disclosed level; package.json scripts `eval:presence` at the root and in `apps/core` through `bun pm pkg set` (as `eval:news`). The paid run belongs to P32.3.5. | `apps/core/evals/presence/run.ts`, `cases.ts`, `run.test.ts`, `package.json` and `apps/core/package.json` (`bun pm pkg set scripts.eval:presence=...`) | `docs/specs/evals.md` (zero undisclosed notes over all cases; exit 1 below it; report path) | `run.test.ts` runs `--scripted` offline: a scripted model that breaks the rule fails the run (exit 1), one that keeps it passes | the `--scripted` run passes inside `bun run check`; the real-model run is left to P32.3.5 |

Phase gate: `bun run check`.

### Phase 5 — Routing, docs and the region

Goal: P25 routes by presence; the region is documented and registered.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P27.5.1 | Presence planner, the client capability registry and `parietal.callClient`, and the `notify` capability | `apps/core/src/modules/parietal/{planner,capabilities,client-route}.ts`, `planner.test.ts`, `client-route.test.ts`, `apps/core/src/compose-regions.ts` (replace the default planner), `apps/tui/src/features/presence/use-presence.ts` (toast and ack), `docs/specs/delivery.md` (Routes), `docs/specs/parietal.md` | delivery.md, parietal.md "Routing" | capabilities set: active client first, then recent clients, then the front session; the ack carries `result?` and `callClient` returns it; an ack from another person or a second ack is ignored; `fanout: 'all'` reaches every capable client; no ack in 10 s falls through (fake clock); no capability: front only; a client with the capability but offline is skipped; e2e: a delivery with `needs.capabilities: ['notify']` toasts in the TUI test harness | tests pass |
| P27.5.2 | Region in ARCHITECTURE | `docs/ARCHITECTURE.md` (move `parietal` from "Planned regions" to the table: technical role, `apps/core/src/modules/parietal`, eharness part: `activity` feed and hooks), `README.md` if it lists regions | ARCHITECTURE.md | none | the table row exists |
| P27.5.3 | Layers wording (supports F-017; owner P24.2.4) | `docs/specs/nodes.md`, `docs/specs/permissions.md`, `docs/specs/people.md`: nodes and clients are Keith's self and ecosystem layers (ADR-0020, ADR-0023, ADR-0027 §9: members with `nodes.read` see all nodes; OWN-008's "their own" means activity); **skip if the plan that implements ADR-0027 §9 already did it** | those specs | doc check only | specs agree with ADR-0027 §9 |
| P27.5.4 | Manual doc and roadmap | `docs/manual-testing.md` (scenario for presence), `docs/plans/active/P22-one-keith-foundations.md` row marked done | manual-testing.md | none | scenarios below present |

Phase gate: `bun run check` and `bun run smoke`.

## Exit criteria

- [x] No "Changes in P27" marker of this plan is left in `docs/specs` (`grep -rn "Changes in P27" docs`).
- [x] `docs/specs/parietal.md` written; `client.md`, `tui.md`, `brain-events.md`, `thalamus.md`, `delivery.md`, `wernicke-broca.md`, `core-cli.md`, `permissions.md`, `db.md`, `nodes.md` updated in the same commits.
- [x] `docs/ARCHITECTURE.md` lists the `parietal` region in the Regions table (no longer "planned").
- [x] Contracts and generated migration committed; `scripts/exports.snapshot.json` regenerated.
- [x] Presence computation is table-tested for every state; signals are pruned at 7 days.
- [x] Isolation test: a model context never holds more than the released line (all three levels, owner and member viewers).
- [x] The TUI registers, heartbeats and shows `/presence` (unit, PTY and smoke tests); the `notify` path through P25's planner is covered by `planner.test.ts`, `client-route.test.ts` and the TUI toast test, not end to end on a real core.
- [x] `bun run check` and `bun run smoke` pass.
- [ ] Manual scenarios run by the owner (not done: see Not verified).
- [x] P22 roadmap row marked done.

## Risks and mitigations

- **The model repeats what it was told.** The tool returns only the released line; the instruction sentence is a courtesy, not the control (ADR-0020 §2). The leak test checks the stored session, not the model's good manners.
- **Heartbeat noise and cost.** One small RPC per 20 s per client; `client.active` rows are coalesced to one a minute; signals are kept 7 days (about 10 000 rows per always-active client at most). Heartbeats from a locked or down core are dropped silently.
- **Wrong "busy" or stale presence.** Manual status expires (maximum 24 h); a dead client times out in 60 s; the owner's raw read shows the facts. Presence is advice for routing, never an authority.
- **Hijacking a client id.** The id is a random uuid owned by the first registering person; another person's register or heartbeat is `CONFLICT`.
- **Presence as surveillance of members by the owner.** The member sees and edits their own disclosure; the owner's `detail` access through the model is audited like any owner access; the raw CLI read is audited too (ADR-0020 §4).
- **Planner ack waits.** At most 10 s per client route and only when a capability is requested; the default wake path is unchanged.
- **Migration numbering with P25 and P26.** Generate with drizzle-kit at implementation time; never choose a number by hand.

## Traceability

| Id | Closed by step |
| --- | --- |
| ADR-0025 §1 (signals, client records, 7 days) | P27.1.2, P27.2.2, P27.3.1 |
| ADR-0025 §2 (agenda) | not here: P28 (overlay interface in P27.2.1 is its entry point) |
| ADR-0025 §3 (presence in code) | P27.2.1, P27.2.2 |
| ADR-0025 §4 (disclosure) | P27.4.1, P27.4.2, P27.4.3 |
| ADR-0025 §5 (routing) | P27.5.1 |
| ADR-0023 §5 (clients as nodes for a person; ids `notify`, `open.view`, `location.share`) | P27.3.1 (capabilities), P27.5.1 (registry, route, `notify`) |
| Presence ports for P28, P29, P30 (`lastSign`, `disclosedFor`, `PresenceOverlay`) | P27.1.1 (spec), P27.2.1, P27.4.1 |
| Doc gap 1 (activity feed and `budget-changed` contract) | P27.1.4 |
| Removal registry part for clients and presence (ADR-0027 §26) | P27.2.2 |
| ADR-0020 §2 and §3 (isolation, one principal) | P27.4.3 |
| F-017 (documentation part, supports P24.2.4) | P27.5.3 |
| Region `parietal` in ARCHITECTURE | P27.5.2 |
| FD10-06 (text login says Run keith), FD10-07 (logout contradicts itself) | P27.3.4 |
| FD10-08 (new login does not revoke the old one) | P27.3.5 |
| FD10-12 (identity and Manage sections never refresh) | P27.3.6 |
| FD10-14 (credential stored before the person is still there) | P27.3.7 |

## Owner to run

1. `bun run manual:core`, then `bun run manual:tui`. Run `keith-core presence <your username>` in another terminal: one client of kind `tui`, state `active`.
2. Leave the TUI untouched for 3 minutes, run the command again: `idle`. Press a key: `active` again. Close the TUI: `offline` after a minute.
3. In the TUI type `/busy 30m in a meeting`: the CLI shows `busy` with the note. `/free` clears it.
4. Create a member (`keith-core people add duta`), sign in as them in a second terminal. Ask Keith as the member: "is the owner free?". Expected: only `available` or `busy`, never the note.
5. As the owner, `/presence`, set `@users` to `none`; ask again as the member: Keith says it has no presence to share. Set `owner` to `none` in the member's panel and ask the owner's Keith about the member: no line; `keith-core presence duta` still shows the raw record and writes an audit row.
6. Ask Keith for a reminder with the TUI open (once P25 is in): it appears in the chat; with a capability request (a test or a protocol later) the TUI shows a toast.
7. Login words (FD10-06, FD10-07): `keith login --device` prints the script wording; with `--remember` it says "Run keith to start" and the app opens signed in. Stop the core, run `keith logout`: one warning, no "revoked" line.
8. Replace (FD10-08): `keith login --password` twice on the same core: `keith-core devices list` shows one remembered device, not two.
9. Refresh (FD10-12): as a member open `keith`; as the owner `keith-core people grant <member> people.manage`: Manage People appears without a restart; revoke it: it goes.

## Gate evidence (Nov 10, 2026)

- Commits be032d1 (contracts and spec) to c7526b6 (docs); `bun run check`: 3274 pass, 0 fail, check-imports, check-size, check-exports (19 entries) ok. `bun run smoke`: SMOKE PASS, 63 steps (block `scripts/smoke/presence.ts`).
- Migration: core `0016` (`clients`, `presence_signals`, `presence_status`, `presence_disclosure`), generated by drizzle-kit, run on top of the P26 backup.
- Deviations recorded by the implementers: the instance owner is in the `owner` audience only (not in `@users`), so a person can hide from the owner; the owner-access dedupe per viewer, target and hour lives in memory per process; `callClient` takes `{clientId, deliveryId, name}` and the planner picks the client; the `ack` result is returned to the caller, not stored; the feed record `brain.parietal.deliver` carries an optional text clipped to 200 characters; `open.view` and `location.share` are in the registry but not deliverable yet (no client route); the 11th register in a minute is `TOO_MANY_REQUESTS` and an unknown group in `disclosure.set` is `BAD_REQUEST`; a busy status without minutes lasts 24 hours; boot emits one presence event per person with `previous: null`; the reporter has no `onBoot` in the connection monitor, so each step reads the boot id from `/health` and re-registers on a change or after any failed step; `/presence` is a framed screen like `/budget`, not an overlay, and is refused offline; nine brain regions grew the sidebar by one row (`BRAIN_ROWS` 7 to 8, `CHAT_HEADER_ROWS` 7 to 8); `login --device --remember` and `--token --remember` are a usage error because the core gives the 30 day lifetime only to form answers (only `--password --remember` works).
- Fixed by the orchestrator after the reports: the parietal tool imported `acl/actors.ts` (module public API rule), now through `acl/index.ts`; two layout assertions (`chat-layout.test.tsx`, `cli.chat-wide.pty.test.ts`) allowed no `─` beside the chat rule, but a sidebar panel edge now shares that row.

## Not verified

- The manual scenarios of "Owner to run" (Scenario 21 in `docs/manual-testing.md`) by eye on a real terminal: `/presence`, `/busy`, `/free`, the three disclosure levels, the sidebar with nine regions; scenario step 6 (the notify toast) has no manual trigger yet.
- A member's disclosure line over a real core with a real model (the fake provider makes no presence call): covered by `presence-isolation.e2e.test.ts` with scripted models.
- The eval `presence` real-model mode was never run (`--scripted` only).
- No web or mobile client exists, so `notify` was only exercised against the TUI reporter and fakes; `location.share` has no consumer.
- The real-core test of `identity.changed` with an open TUI after a grant (FD10-12): only the hook and action tests exist.
