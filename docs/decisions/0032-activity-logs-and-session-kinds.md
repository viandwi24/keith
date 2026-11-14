# 0032. Activity logs: every model call is recorded per session, and a session has a registered kind

Status: Accepted (2026-11-11), design; built in P36. Applies ADR-0020 (one person is one principal; the owner reads another person's data only through an
audited path), ADR-0027 §3 (additive migrations with a backup), §26 (removal keeps a person's data), ADR-0030 (front generations) and ADR-0031 (dream judge
sessions). Uses eharness 0.12.0 `model.call` (spec 12 §7, written for exactly this: "activity logs and generation inspectors"). Region: no new region
(ADR-0004); the capture is a core plugin next to the budget, the store lives in `apps/core/src/modules/audit/` beside the audit log (module `activity-logs`).

## Context

The owner wants one place where everything Keith sends to an AI can be read, with the debugging detail of OpenRouter's Logs > Sessions: a list of sessions
(date range, id, app, primary model, provider), a drawer per session (requests, cost, models, generations) and per generation (latency, throughput, tokens
in and out, cost, finish reason, streaming, fallbacks, the messages sent, the raw request and the raw response). Today:

- The budget ledger sees usage and cost but keeps no request, no response and no per-call row (`eh_budget_record` is a spend record).
- The activity feed (spec 25) is a live stream of turn events, not a stored log of provider calls.
- eharness 0.12.0 already exposes every provider call: the `model.call` hook (steps, the compaction summarizer, the pre-compaction flush, the shared
  judge) and `ctx.observeModel` / `observeModel` for models a plugin calls itself (spec 12 §7). The event holds the request options (the messages), the
  provider body, the response, the output, usage, cost, upstream provider, status and timing. The core keeps none of it and leaves retention to the app.
- The session "type" is only an id convention: `front:<person>[:g<n>]`, `front:<person>[:g<n>]:agent:<task>` (workers), `room:<roomId>:g<n>`,
  `guest:<random>`, `dream-judge:<uuid>`. Helpers read it piecemeal (`personOfSession`, `generationOfSession`, `roomIdOfSession`, `isGuestSession`). A new
  kind of session would need every reader to learn a new prefix.

The content of a log is personal data: prompts hold the person's messages, memory and tool results. ADR-0020 forbids a quiet owner read of it.

## Decision

1. **Capture at the provider boundary, with one hook.** A core plugin `activity-logs` registers `model.call` and is added to every agent the core builds
   (front, room, worker, dream judge, guest). It covers steps (so protocol and wake turns, which are front turns), compaction summaries and flushes. Calls
   made outside an agent turn (the web search model, the permission classifier if one is configured, any later helper) use `ctx.observeModel` or
   `observeModel` and name their session. A call that has no session gets the synthetic id `aux:<name>:<personId>` with kind `aux`. Embeddings: the core
   makes none today; the registry of call kinds has `embedding` reserved and nothing writes it. The hook never throws and never delays a stream: events go
   to a bounded in-memory queue that a writer drains in batches; on overflow the oldest event is dropped and a counter is kept (reported in `logs.status`).
   Capture does not charge budgets and does not change a call.
2. **A session kind is a registered, typed concept, and the id stays the source of truth.** `packages/contracts/src/session-kinds.ts` holds
   `SESSION_KINDS`, a registry of `{ kind, label, appLabel, matches(id), owner(id) }` rows and the pure helpers `sessionKindOf(id)`, `sessionOwnerOf(id)`
   and `sessionRefOf(id)` (kind, person or room, generation, parent). Kinds today: `chat` (`front:<person>[:g<n>]`), `task` (an id with `:agent:`; the
   registry checks it before `chat`), `room` (`room:<roomId>:g<n>`), `guest` (`guest:<random>`), `dream` (`dream-judge:<uuid>`), `aux` (`aux:<name>:<person>`).
   Heartbeat and protocol runs are turns of a front session, so they are not kinds: the kind of the **turn** (`send`, `respond`, `regenerate`, `edit`, `wake`, from eharness
   `TurnInfo`) is stored on each call as `trigger`, and the Logs view can filter by it. Existing ids do not change. A new kind is one registry row plus its
   id rule; a test fails if two rules match one id or if an id written by `platform/sessions.ts` matches no kind. `platform/sessions.ts` keeps its helpers
   and delegates to the registry, so no call site changes. The kind is **also stored** (column `kind` of `llm_sessions`), computed once at the first
   call: listing and filtering by kind must not parse every id, and a later change of an id rule must not move old rows between kinds.
3. **Data model, additive, one migration (generated, backup first).** Three tables, no foreign keys (as `front_generations`): `llm_sessions` (one row per
   session: id, kind, person, room, app label, first and last call time, call count, cost, primary model and provider), `llm_calls` (one row per call:
   ids, kind of call, trigger, turn and step, times, duration, first chunk, status, finish reason, model, provider, upstream provider, token counts, cost
   and source, fallback note, error name and message, byte sizes, `body_state`) and `llm_bodies` (one row per call: gzip blobs of the request, the response
   and the output). Bodies sit in their own table so retention can purge them without touching the figures. `llm_sessions` totals are updated in the same
   transaction as the call insert.
4. **Redaction at write time; no secret is ever stored.** Before storing, a walker redacts: keys matching authorization, api key, token, secret, cookie,
   credential and password (case-insensitive, any depth), headers except a short allow list, and every string for which `looksLikeSecret` of the
   hippocampus secret guard is true (replaced by `[redacted:secret]`). Provider keys are never in `request.options` (eharness redacts headers, rule 3);
   the walker is the second line, and a test builds fake keys at runtime and asserts none reaches a row. Binary data is already a placeholder.
5. **Size limits.** A string field over 64 KB is cut (marked `[truncated N bytes]`), and the whole body of one call over `maxBodyBytes` (default 512 KB
   before gzip) is cut by dropping the longest string fields first; `body_state` is `truncated`. Bodies are stored gzipped (`Bun.gzipSync`).
6. **Settings (owner, instance-wide).** `captureBodies` (default on; off stores figures only), `guestBodies` (default off: guest agents keep nothing else
   on disk, so their text stays out), `bodyRetentionDays` (default 14), `metaRetentionDays` (default 365), `maxBodyBytes`. Stored in the existing settings
   store; changes are audited. A person can purge their own bodies or their whole log (`logs.purge`).
7. **Retention by the existing prune tick.** Bodies past `bodyRetentionDays` are deleted and the row's `body_state` becomes `purged`; calls and sessions past
   `metaRetentionDays` are deleted. One `data.pruned` row per table with counts only (ADR-0027 §28). Removal (ADR-0027 §26): the removal registry part
   keeps a removed person's rows under the same periods (they expire by time), exports them on `people export`, and purges them on a hard purge.
8. **Privacy and rights.** A session belongs to one principal: the person of the session (front, task, dream), the speaker of a room turn is recorded per
   call but the **session** belongs to the room. Rules, enforced in one function `canReadSession(reader, session)` used by every RPC:
   - a person reads their own sessions (kinds `chat`, `task`, `dream`, `aux` of their id): capability `logs.mine`, held by every role;
   - a room session is read by a current room member that has `r` on the room (the room ACL, as `room.read`), through the room's own rules, no more;
   - the instance owner holds `logs.read` for the rest. Reading a session that is not the owner's own is the **owner path**: it writes `logs.owner-read`
     and `acl.owner-access` (`owner` = the session's person; once per window for a list, once per session for a detail or raw read, always for raw
     JSON) so the person finds it under `audit.mine`. A guest session is read only through the owner path;
   - nobody else reads anything; a member's token with `logs.read` does not exist (the capability is owner-only);
   - the list never returns content (no message text, no raw body); the detail returns the messages sent; raw JSON is a separate call.
   Another person's logs are never in a response to a member, in a prompt, or in the activity feed. Removal of access (suspended person, left room) removes
   it at once because every call re-checks.
9. **RPC.** Area `logs` of the Keith contract: `logs.status`, `logs.settings.get|set`, `logs.sessions` (filters: kind, person for the owner, model,
   time range, text on id; cursor paging), `logs.session` (overview and the generations), `logs.call` (one generation: figures, the messages sent, tool
   calls, provider response summary), `logs.raw` (request and response JSON, size-bounded for the wire), `logs.purge`. The client package gains typed
   methods; the TUI reads only through them (hard rule 4).
10. **Surfaces.** TUI: a `Logs` section under Manage (visible with `logs.mine`; the owner sees a `Scope` toggle mine/everyone) with a three-level drill-down
    (sessions, session, generation, raw JSON) in the btop style of the existing sections. CLI: `keith-core logs list|show|call|raw|prune|settings`,
    owner-local and audited like the other owner CLI reads.
11. **Not in scope.** No export to Langfuse or Datadog, no replay of a call, no search inside bodies, no cost correction of the budget ledger (the ledger
    stays the source of truth for money; log cost is informational and may differ).

## Alternatives considered

- **Use `eh_messages` and `eh_budget_record` only.** They hold the conversation and the spend, not the provider request, latency, fallbacks or the raw
  response; compaction and flush calls and the judge leave nothing. Rejected.
- **A kind column only, ids freed.** Cleaner in theory, but every id is used by readers (rights, recovery, the dream collector). Making the registry the
  reader and keeping the ids avoids a migration of live sessions. The stored kind is a cache for listing.
- **Wrap the provider in `providers/`.** Needs one wrapper per provider and misses the compaction and flush calls that eharness issues itself.
  `model.call` is one hook for all, with the same record the spec defines.
- **Store bodies in files.** Retention and removal would need a second sweeper. gzip blobs in their own table keep one transaction and one prune.
- **Owner reads everything without audit.** Contradicts ADR-0020 §4.

## Consequences

- One additive migration (three tables); `body_state` and the settings make the cost of storage a choice of the owner. A busy day holds a few MB per
  active person after gzip; the default 14 days bounds it.
- Every agent factory gains the same plugin; a new agent forgets it only once, because a test lists every `defineHarnessAgent` site.
- New capabilities `logs.mine` and `logs.read`, new audit kinds `logs.owner-read`, `logs.purge`, `logs.settings`; `docs/specs/permissions.md`, `db.md`,
  `people.md`, `core-cli.md`, `tui.md` and a new `docs/specs/activity-logs.md` change in the same commits as their code.
- The session kind registry becomes the place to add the next kind (a node-side session, a plugin session).
