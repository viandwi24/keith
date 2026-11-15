# Parietal: clients and presence

Code: `apps/core/src/modules/parietal/` (built in P27 phase 2 to 5: `compute.ts`, `overlay.ts`, `index.ts`, `service.ts`,
`procedures.ts`, `disclose.ts`, `tool.ts`, `planner.ts`, `capabilities.ts`, `client-route.ts`, `removal.ts`). Tables:
`packages/db/src/schema/presence.ts` and the repos `clients.ts`, `presence-signals.ts`, `presence-disclosure.ts` (`db.md`). Contracts:
`packages/contracts/src/presence.ts` (exported from `area-runtime.ts`). Client side: `packages/client/src/presence.ts` (P27.3.1).
Decisions: ADR-0025 (presence and ecosystem context), ADR-0023 §5 (clients are nodes for a person), ADR-0020 §2 and §3 (isolation,
one principal per turn), ADR-0027 §9 (nodes are Keith's self layer, clients are the person's ecosystem layer).

Status: the contracts, the tables, the computation, the service, the disclosure rule, the client and disclosure procedures and
the client route with its planner exist (P27.1 to P27.5.1). The owner's `admin.presence.read` is built in P27.2.4.

## Purpose

Keith knows which of a person's clients are connected and in use, computes whether the person is active, idle, away, busy or
offline, and answers "is Duta free?" with exactly what Duta chose to share. A notification or a visual goes to the client the
person is looking at. Presence reaches a model context only as a line that a disclosure rule released.

Layer (ADR-0020): the ecosystem layer of one person. Its data belongs to that person; others see it only through the disclosure
rule below, and the owner's raw read is audited.

## Service

`modules/parietal/service.ts` (`createParietalService`) is the one writer of the presence tables. `compose-parietal.ts` builds it
over the repos and registers its removal part (`removal.ts`, "Settings, audit, errors").

- `register`: a client id of another person is `CONFLICT`; the 21st client of a person is `CONFLICT`; more than 10 registers a
  minute per person is `TOO_MANY_REQUESTS`. A register writes `client.connected`. Only the first register of an id is audited
  (`client.registered`).
- `heartbeat`: an id the caller does not own, or an unknown id, is `NOT_FOUND`. A heartbeat sooner than 5 seconds after the last
  one of the same client is ignored (nothing is written). `active: true` writes `client.active` (the repo keeps one a minute).
- `goodbye` writes `client.disconnected` and the client is offline at once (no wait for `clientTimeoutMs`): it leaves the online clients, the "Where the person is now" block and `client_call`'s choice. Offline is derived from the signal, so no column is stored: a client is online when its last heartbeat is within the timeout and no goodbye is at or after that heartbeat (`isClientOnline`, `compute.ts`). A heartbeat or register after the goodbye brings it back. `remove` deletes the client (audited `client.removed`); an unknown or foreign id is `NOT_FOUND`.
- `setStatus`: a stated status (ADR-0034 §5) or free (`/free`, `busy: false`, nothing kept). The kind is `busy` (default; do not
  disturb) or `out` (away from the desk, reachable on a phone or chat). `from` (epoch ms, at most 7 days ahead; default now) is the
  start, `until` the end, or `minutes` (1 to 1440) from the start; with neither the status lasts 24 hours. A `busy` status lasts 24
  hours at most, an `out` status 7 days; an end that is not after the start, or already past, is `BAD_REQUEST`. A status whose `from`
  is in the future does nothing until then (the timer recomputes it); one whose `until` passed is cleared (retention prunes the
  row). A `busy` status is the first overlay source (`manual`); `out` is read separately (`outOf`). Audited `presence.status.set`
  (`busy`, `kind`, `minutes`; never the note). `status()` answers `{ busy, note, until, kind, from }`: `busy` is true only while a
  busy status holds now, `kind` names the stored status (a scheduled one too), null when none.
- `recordActivity` (the thalamus `chat.validate` hook, P27.2.3) writes one `activity` signal. A failure is warned, never thrown.
- `recomputeAll` runs every `CoreTiming.presenceEveryMs` and at boot over every person. A change of state emits
  `brain.parietal.presence` once on the person's front session; the first computation has `previous: null`. Every register,
  heartbeat, goodbye, remove, status change and activity recomputes that person as well.
- The windows are `CoreTiming.clientTimeoutMs`, `activeWindowMs` and `awayAfterMs`; the computation takes the service's clock.

## Contracts

`packages/contracts/src/presence.ts` (zod):

- `ClientKindSchema`: `tui`, `web`, `mobile`.
- `ClientCapabilitySchema`: `^[a-z]+(\.[a-z]+(-[a-z]+)?)?$`, the ids of ADR-0023 §5 (`chat`, `notify`, `open.view`, `location.share`) and the
  rendering ids of ADR-0029 §5 (`render.markdown`, `render.speech-only`), never prefixed with `client.`.
- `RenderCapabilitySchema`: the closed set `render.markdown`, `render.speech-only` (`RENDER_CAPABILITY_IDS`). A client declares them on
  register; the core never asks a client for them. `render.table` and other render names are refused by this schema.
- `ClientRegisterSchema`: `id` (uuid, kept by the client), `kind`, `label` (at most 40), `capabilities` (at most 10), `version`
  (at most 40), `environment` (optional, see below). `ClientRecordSchema` adds `personId`, `firstSeenAt`, `lastSeenAt`, `lastActiveAt` (null until
  one input), `online`, and `environment` and `network` when known (ADR-0033).
- `ClientEnvironmentSchema` (ADR-0033 §1): `host` (60), `os` (`macos`, `linux`, `windows`, `other`), `osVersion` (40, optional), `arch` (20,
  optional), `device` (`laptop`, `desktop`, `phone`, `unknown`), `timezone` (an IANA name the platform knows, 60), `locale` (20, optional). Every text
  loses its control characters. `ClientNetworkSchema`: `local-socket`, `loopback`, `lan`, `tailscale`, `public` (derived by the core, never sent).
- `SignalTypeSchema`: `client.connected`, `client.disconnected`, `client.active`, `device.location`, `node.event`, `activity`.
  `device.location` is listed; the core refuses it until a mobile client exists.
- `PresenceStateSchema`: `active`, `idle`, `away`, `busy`, `offline`. `PresenceSchema`: `personId`, `state`, `reachableOn`
  (online client ids, most recently active first), `activeClient`, `note` (at most 200), `asOf`, and optional `where` (`PresenceWhereSchema`: `desk`,
  `mobile`, `out`, `unknown`) and `until` (epoch ms of the status that holds). `PresenceStatusSetSchema`: `busy` (false clears), optional
  `kind` (`busy`, `out`), `note`, `minutes` (1 to 1440), `from`, `until` (epoch ms); `PresenceStatusViewSchema` adds `kind` and `from`.
- `DisclosureLevelSchema`: `none`, `state`, `detail`. `DisclosureAudienceSchema`: `owner`, `@users`, `group:<id>`.
  `DisclosureRowSchema` and `DisclosureSetSchema`: `{ audience, level }`.
- `PresenceStatusSetSchema`: `{ busy, note?, minutes? }` (minutes 1 to 1440). `PresenceStatusViewSchema`: `{ busy, note, until }`.
- `ClientHeartbeatSchema` `{ id, active }`, `ClientRefSchema` `{ id }`, `ClientAckSchema` `{ id, deliveryId, ok, result? }` (result
  text, at most 4000).
- `PresenceMineSchema`: `{ presence, clients, status, disclosure }` (`presence.mine`). `PresenceRawInputSchema` `{ person }`,
  `PresenceRawSchema` `{ presence, clients, status }` (`admin.presence.read`).

Procedures (P27.1.3 declares them in `contract.ts`; capability `chat`, so every signed-in person; a guest has no person):
`presence.clients.register`, `presence.clients.heartbeat`, `presence.clients.goodbye`, `presence.clients.ack`,
`presence.clients.list`, `presence.clients.remove`, `presence.mine`, `presence.setStatus`, `presence.disclosure.set`.
There is no client-context procedure (ADR-0033 amendment, Nov 12, 2026). The owner's
`admin.presence.read` uses `audit.read` (owner only, `OWNER_ONLY_CAPABILITIES`) and is audited as `presence.read`.

Rules of the procedures (enforced in the service, P27.2.2):

- A client id registered by another person is `CONFLICT` (no hijack). At most 20 clients per person (`CONFLICT` for the 21st). A terminal keeps one id per person (client.md, "Presence reporter"), so a second person on the same terminal registers a new client.
- A heartbeat sooner than 5 seconds after the last one is ignored. Register is limited to 10 a minute per person.
- A heartbeat, goodbye or ack for an id the caller does not own is refused exactly like an unknown id (no existence leak).

Brain events (`packages/contracts/src/brain.ts`, region `parietal` added to `BrainRegionSchema`):

- `brain.parietal.presence` `{ region, personId, state, previous }`: a state changed. Emitted on the person's front session id, so
  only that person's feed carries it. `previous` is null on the first computation.
- `brain.parietal.deliver` `{ region, personId?, clientId, deliveryId, capability, name, text? }`: a client was asked to do a
  capability (`notify`, `open.view`). `text` is the text it shows, clipped to 200 characters. Visible to the person only; the TUI
  of that client reads it.

## Ports

Exported by `modules/parietal/index.ts`. They are the only entry points other regions may use; nobody reaches into the computation.

- `lastSign(personId): Promise<number | null>`: the newest `activity`, `client.active` or `client.connected` signal of the person
  (after a sign-in). Never `node.event`, never a heartbeat without `active`, never an offline command. The actor is always the
  person, so there is no separate "owner-made" flag.
- `disclosedFor(viewer, subject): Promise<{ level, line }>`: the rule in "Disclosure" (async: the people directory and the groups are read
  at call time). Consumed by the `presence` tool and by P28 and P30.
- `PresenceOverlay = { id: string; busy(personId: string, now: number): { note: string | null; until: number } | undefined }`,
  registered with `parietal.addOverlay(overlay)`. The manual status is the first overlay source; P28's agenda implements one and
  registers it. The agenda feeds presence; presence never feeds the agenda.
- `callClient(personId, capability, input, target)` (see "Client capability registry and route"): the one route to a client.

## Client capability registry and route

`modules/parietal/capabilities.ts` holds what a client can be asked to do:

| Id | Risk | Input | Output |
| --- | --- | --- | --- |
| `notify` | write | `{ title?, text (at most 500), level? }` | none (the ack `ok`) |
| `open.view` | write | `{ view: 'plugin:<id>:<view>' \| 'room:<id>' \| 'tasks' \| 'protocols', args? }` | none |
| `location.share` | external | `{ precision: 'city' \| 'coarse' }`, opt-in on the client | the client's answer |

`location.share` is in the registry; no client serves it yet, and the TUI never announces it. The `open.view` delivery record carries the caller's target `name`, so for `open.view` that name is the view to open (`plugin:<id>:<view>` or `tasks`; the TUI, P31.5.4). P31 reuses this registry for `client_call`.

Rendering ids (ADR-0029 §5, P33.1.3) are declared, not asked: `render.markdown` (the client's screen renders Markdown) and
`render.speech-only` (the client's channel is spoken). They are not rows of the table above and `CLIENT_CAPABILITY_IDS` does not
hold them. `modules/parietal/capabilities.ts` exposes `CLIENT_RENDER_IDS` and `isClientRenderId`. The mode of an answer is chosen
from them in code (`prefrontal`, `mode.ts`); a client that declares neither gets plain text in `chat` mode.

`modules/parietal/client-route.ts` (`createClientRoute`, composed into the service) holds the route. `parietal.callClient(personId,
capability, input, target)` is the one route, `target` is `{ clientId, deliveryId, name }` (the planner chooses the client; see
"Routing"):

1. It checks the client: it belongs to the person, is online and announced the capability. Otherwise it is `unavailable` and nothing
   is written. The input must parse against the capability's spec (`notify` text at most 500); otherwise `unavailable`.
2. It writes the feed record `brain.parietal.deliver` on the person's front session (`text` clipped to 200 characters, no message
   body).
3. It waits for `presence.clients.ack { id, deliveryId, ok, result? }` for 10 seconds (`CLIENT_ACK_MS`). The ack is accepted only
   from the same person and the same client id, and only for a waiting call; a second ack is ignored. `result` is kept up to 4000
   characters and returned with `ok: true`. An `ok: false` ack is `unavailable`.
4. It returns `{ ok: true, result? }`, or `{ ok: false, reason: 'unavailable' }` on no ack in 10 seconds, so the caller tries the
   next route. An ack from a client the caller does not own is `NOT_FOUND`, like an unknown id.

The P25 planner (`createPresencePlanner`) and P31's `client_call` tool (`modules/parietal/client-tools.ts`) are the only callers.
`client_call` takes `{ capability, input }`: it lists the person's online clients that announced the capability (the active one first). When the capability has no online app at call time (none announced it, or every one refused), the answer is `no-client` and its message names the capabilities that are online for the person (or `none`) and says not to call that capability again in the turn; the schema keeps every capability (a stable tool shape). A client that said goodbye is offline at once and is never asked.
first, then the most recently active), asks them one by one, and answers `{ ok: true, client: <label>, result? }` from the first ack,
or `{ ok: false, code: 'no-client' }`. It writes `client.call` `{ person, capability, ok }` (no input, no output). Nothing else sends to
a client.

## Signals and computation

Signals are rows of `presence_signals` (see `db.md`): `activity` (written by the thalamus `routed` hook when a message was sent
from any client or script), `client.active` (at most once a minute per client), `client.connected`, `client.disconnected`.
Constants in `CoreTiming`: `clientHeartbeatMs` 20 000, `clientTimeoutMs` 60 000, `activeWindowMs` 120 000, `awayAfterMs` 1 800 000,
`presenceEveryMs` 60 000.

Pure function `computePresence` (`compute.ts`):

```
online     = clients whose last_seen_at >= now - clientTimeoutMs and whose newest client.disconnected (if any) is older than last_seen_at (a goodbye takes it offline at once; a later heartbeat brings it back)
lastActive = max(last_active_at of online clients, newest activity signal)
overlay    = first of [manual busy status that has started and not expired, ...registered overlay sources]   -> busy + note + until
out        = stated `out` status that has started and not expired                                       -> note + until
state      = overlay ? busy
           : out ? away
           : lastActive >= now - activeWindowMs ? active
           : online.length > 0 ? (lastActive >= now - awayAfterMs ? idle : away)
           : offline
reachableOn  = online client ids, most recently active first
activeClient = state is active (or busy with recent activity) ? online client with the newest last_active_at : null
note, until  = those of the overlay, else of `out` (until only when it has an end)
where        = whereOf(client in use, out): `out` while a stated `out` holds; else `mobile` when the client in use is kind `mobile`,
               reports device `phone`, or reached the core over `public`; else `desk` when it is kind `tui` or `web` on `local-socket`,
               `loopback` or `lan`; else `unknown`. The client in use is `activeClient`, else the newest online client of an `idle`
               person; an `away` or `offline` person has none (`tailscale` or an unknown network is `unknown`)
```

`where` is a hint derived from facts, never a place: it is not shown as one, and a wrong hint costs a less suitable route, never a lost
message (ADR-0034). `Presence` carries it (`where`, optional, so an older reader keeps working) with `until`. A busy agenda overlay
cannot say "away", so only a stated `out` makes `where` `out`. The planner reads `parietal.presence(person).where` (P37.4).

It is recomputed on every signal and every `presenceEveryMs`. A change of state emits `brain.parietal.presence` on the person's front
session. A dead client times out after 60 seconds.

## Disclosure

A rule in code (`modules/parietal/disclose.ts`), not a prompt (ADR-0025 §4, ADR-0020 §2).

- Levels: `none` (no line), `state` (`busy` or `available`: active and idle read `available`; away and offline read
  `not available`, so the line never separates away from offline), `detail` (the state as computed, the note and the until time;
  never client ids, counts or kinds). A line reads `Ana is busy (in a meeting), until <ISO time>.` or `Ana is not available.`
- Audiences of a viewer: the instance owner is in `owner` only; every other active person is in `@users`; a viewer is in each
  `group:<id>` whose membership holds now (`acl.members`). The owner is not in `@users`, so a member's `owner` none really hides
  the presence from the owner, and a `@users` none does not hide it from the owner either.
- Defaults (no stored row): `owner` gives `detail`, `@users` gives `state`, a group gives `none`. A viewer gets the **highest** level
  over his audiences; a stored row replaces the default of its audience.
- `presence.disclosure.set { audience, level }` stores the row. `group:<id>` must name an existing group (`BAD_REQUEST` otherwise).
  `presence.mine` returns `owner`, `@users` and every existing group with the effective level (stored or default).
- A person always sees their own full presence (`detail`, whatever the rows say).
- A subject that is unknown, suspended or removed, or a viewer that is not an active person, releases `none`.
- The owner reading `detail` of a member writes `acl.owner-access` `{ kind: 'presence', id: <member>, owner: <member>, bits: 4 }`,
  at most one row per viewer, target and hour (kept in memory per process; a restart may write one more). The row names the member
  as `owner`, so the member reads it under `audit.mine` ("the owner read your presence in detail"). The listener is recorded as `tcp`,
  because a model turn is not tied to one listener.
- The rule decides what a model may say. The owner's CLI `keith-core presence <username>` and `admin.presence.read` return the raw
  record, audited as `presence.read`: a member cannot hide from the owner's own console, but the front agent cannot quote it. The
  raw record's clients are `RawClientRecordSchema`: the client record without `environment` and `network` (ADR-0033 §3), stripped by
  `service.raw`; the CLI prints id, kind, label, state and times only.

## The `presence` tool (front agent)

`modules/parietal/tool.ts` is a plugin, like `nodesStatus` (`modules/motor/status.ts`), in the front agent's plugin list
(`modules/wernicke-broca/agent.ts`). Tool `presence({ person })`: `person` is a username, a name or `me`. The viewer is the turn's
principal (`ctx.principal`), never an argument. Output `{ disclosed: boolean, line? }`. An unknown person, a suspended person and a
refusal all answer `{ disclosed: false }`. A worker does not get the tool. The instruction sentence in the front prompt is a courtesy;
the control is the released line.

`resolvePerson`: `me` (the viewer), a username or id, else a display name that exactly one person has (an ambiguous name answers
nothing). The tool calls `disclosedFor(viewer, subject)` only for a resolved person and an active viewer; a guest has no tool path.
Code: `modules/parietal/tool.ts` (`presenceTool`, `presenceToolOf`, `resolvePerson`, tests in `tool.test.ts`).

### The `presence_status_set` tool (ADR-0034 §5, ADR-0036)

`modules/parietal/status-tool.ts` (`presenceStatusSetToolOf`), added by the same plugin (`presenceTool`) when the parietal service is
passed, so the front agent has it with no change to its plugin list. Input `{ kind: 'busy' | 'out' | 'clear', from?, until?, note? }`:
`from` and `until` are an ISO time with a zone offset (`2026-11-14T15:00:00+07:00`) or a number of minutes from now (a time with no
zone is refused with a hint); `note` at most 200 characters. It changes the status of the turn's principal only (`ctx.principal`,
never an argument; a guest or no principal is refused) through `setStatus`, so every rule above applies; a refusal comes back as
`{ ok: false, reason }`. Answer `{ ok: true, status: 'busy' | 'out' | 'cleared', from, until }` (ISO times). Audited
`presence.status.set` with `{ subject, busy, kind, minutes }`, never the note. Disclosure is unchanged: `lineOf` shows a stated `out`
as `away` (a member at the `state` level reads "not available" and never the note). `/busy` and `/free` stay.
Tests: `status.test.ts`.

Isolation proof (ADR-0020 §2): a scripted-model test where a member asks about the owner and about another member at each level, and
the stored session of the viewer holds no raw field (client ids, labels, signal times).

**Consent and undo (ADR-0036).** `presence` is `{ risk: 'read', source: 'trusted' }`; `presence_status_set` is `{ risk: 'write', reversible: true, source: 'trusted' }`: in a
clean conversation it runs with no approval; after outside content it waits in conversation (`amygdala.md`, "Consent"). `PresenceStatusToolOptions.undo` (an `UndoLog`)
and `parietal.status` let the tool record the status before the change; the undo sets it back (`busy: false` when there was none, otherwise kind, note, `from` and
`until` as they were) and writes the same `presence.status.set` audit row. `client_call` is `{ risk: 'write', source: 'trusted' }` (the person's own signed-in app).
Tests: `parietal/status.test.ts`.

## Routing (P25 seam)

`modules/parietal/planner.ts` (`createPresencePlanner({ parietal, front, push? })`, `push(person, needs)` returns the person's push routes) implements the `RoutePlanner` of `delivery.md`,
composed in `compose-delivery.ts` in place of the single front route. `plan(person, needs)` first applies the reach ladder (ADR-0034 §6) to `presence(person).state` and `needs.urgency` (`high` is urgent):

| State | `normal` wake | `high` |
| --- | --- | --- |
| `active`, `idle` (desk or mobile) | the routes below | the routes below |
| `busy` | `{ hold: { reason: 'busy', until? } }` (`until` = the status end) | the routes below, the front route asks the agent to open with why it interrupts |
| `away`, `offline` | `{ hold: { reason: 'away' \| 'out' \| 'offline' } }` (`out` when `where` is `out`) | the same as busy |

A `note` delivery and one with `needs.immediate` are never held (routes below). A hold is kept by the delivery service and released as the return digest
(`delivery.md` "Hold and digest"). The routes of a reachable (or urgent) person:

- No capability needed (the default wake): `[front]`.
- `needs.capabilities` non-empty and each one deliverable (`notify`; `open.view` and `location.share` have no delivery input yet):
  client routes in order: the `activeClient` first, then the online clients by `lastActiveAt` descending, each only if its
  capabilities include every requested one. Each route is one `callClient` per capability, with the delivery's text (`notify`
  `{ text }`, clipped to 500). A route is `unavailable` when its client does not ack, so the next route is tried. With
  `fanout: 'all'` every such client is asked (P29).
- `push` routes (the Web Push of `push.md`, `compose-delivery.ts`): asked for only when `pushWanted(presence, needs)` is true and the person has a subscription (an
  empty list otherwise). `pushWanted`: an urgent delivery (`needs.urgency: 'high'`, the urgent bypass) always; a `note` never (stored quietly); any other when the
  person is `away` or `offline`, or `where` is `mobile` or `out` (a non-desk path, ADR-0034 §6). A person at a desk (`active` or `idle`, `where` `desk` or
  `unknown`) is reached by the clients and the front session, so no push. A held delivery (a `hold` plan) has no routes and so no push; the return digest is
  the way back. The push route is a companion (`delivery.md`, "Service"): it sits after the client routes and before the front session and never replaces it.
- The front-session route is always last, so the message is stored in the person's chat. A capability no client of the person
  has leaves only the `push` routes and the front session. A plain wake (no capability) is `[...push, front]`.
- Route ids are `client:<clientId>`, `push` and `front`. The feed record text is clipped to 200 characters; the chat keeps the full text.

## Settings, audit, errors

- No new core settings: the constants live in `CoreTiming`.
- Audit kinds: `client.registered` (first time only), `client.removed`, `presence.status.set` (also written by the `presence_status_set` tool), `presence.disclosure.set`
  (`{ subject, audience, level }`, the subject is the person who changed their setting), `settings.client-context` (history only: written before the
  switch was removed, Nov 12, 2026, and still summarised by `audit.mine`; no code writes it now), `presence.read` (the owner's raw read),
  `acl.owner-access` (a `detail` read). Never a signal's content,
  a location or a message, never an environment (its host and zone are not in any audit row).
- Errors: `CONFLICT` (a client id of another person, the 21st client), `NOT_FOUND` (a client id the caller does not own, the
  same answer as an unknown id), `TOO_MANY_REQUESTS` (more than 10 registers a minute), `BAD_REQUEST` (an unknown group in an audience, a bad capability or
  minutes), `FORBIDDEN` (`admin.presence.read` for a non-owner).

## Retention

Rows: `clients` (forgotten 90 days after last seen), `presence_signals` (7 days), `presence_status` (expired rows), `presence_disclosure` (kept while the person exists; removed with the person through the removal registry,
which keeps and purges them with the clients). The prune tick is `platform/retention.ts`.

## Client context block

Decision: ADR-0033 §5, §6 (and the amendment). Code: `modules/parietal/context-block.ts` (`clientContextBlock`, `clientContextFor`, `activeClientOf`, `localClockOf`),
`modules/parietal/network.ts` (`clientNetworkOf`), `modules/parietal/client-tools.ts` (`clientCallDescription`).

- **Network on register.** The procedure derives `network` from the RPC context (`via`, `ip`, `forwarded`) and the LAN subnets and proxy setting of the
  login (`compose-regions.ts`): the local socket is `local-socket`; otherwise `zoneOf` decides `loopback`, `tailscale`, `lan` or `public`. The service
  stores what it is given (`register(personId, input, network)`); a register without a derivation stores no network.
- **The block** (the front agent's turn reminder, `wernicke-broca/agent.ts`, between the style lines and the mode block). For the person's active
  client (the presence's `activeClient`, else the most recently active online one) it writes `Where the person is now (facts their app reported; a
  host name is not a place, and this is not a location): ...` and one line each for the app (kind, label, host, OS, device), the network and the local
  time in the client's zone. When no online client announced `location.share`, one line says no location sensor is online, that the answer comes from
  what the host, the network and the time zone show (a time zone may name its region), that no city, address or building is named as a fact, and
  that the exact place is not known (ADR-0033 amendment, Nov 13, 2026). A sixth line carries the `where` hint when it is not `unknown`
  (`WHERE_HINT`): worded as a guess ("probably at a computer", "probably on a phone", "said they are out"), never a place. No online client: no block. The texts are cleaned (control characters, quotes and angle brackets removed; the host at 60, the label at 40).
- **No setting.** The block is always written for the active client (ADR-0033 amendment, Nov 12, 2026: client context is always on, there is no switch).
- **Scope.** A person's block holds only that person's clients. A member's clients never reach the owner's reminder, and the block is never in the
  system prompt (test: `wernicke-broca/client-context.test.ts`).
- **The `client_call` description is fixed** (`CLIENT_CALL_DESCRIPTION`, audit F9): the same text for every person and every presence, so the tools of
  the prompt do not change when a client connects or disconnects (a change would bust the prompt cache after the system block). It says that the
  capabilities online for the person are in the turn reminder line `Apps online now` and that a capability not listed there is unavailable.
- **The `Apps online now` line** is the front agent's turn reminder entry, written at each turn after the block (`appsOnlineLine`, `wernicke-broca/agent.ts`,
  only when `client_call` is wired). It names the capabilities an online app of the person has now (`notify`, `open.view`, `location.share`) with their
  input shapes, and says that a capability not listed is unavailable. With no app online it reads `Apps online now: none.` and says every
  capability is unavailable. Test: `wernicke-broca/apps-online.test.ts` (the description is byte-identical with 0, 1 and 2 apps online; the line follows presence).

## Invariants

- A model context holds only the line that `disclosedFor` released (test: P27.4.3).
- Presence is advice for routing, never an authority: no permission check reads it.
- A client receives only deliveries of its own person; an ack from another person or client is ignored.
- Presence never reaches a log line with a note, a location or a message.

## Tests

`packages/contracts/src/presence.test.ts` (schemas, capability ids, uuid ids), `brain.test.ts` (parietal events parse). Later steps:
`compute.test.ts` (table-driven on a fake clock), `service.test.ts`, `disclose.test.ts`, `tool.test.ts`, `planner.test.ts`,
`client-route.test.ts`, `presence-isolation.e2e.test.ts`.
