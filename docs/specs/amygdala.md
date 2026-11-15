# Amygdala

Code: `apps/core/src/modules/amygdala/{attention,pending,expiry,consent,consent-context,consent-table,consent-classifier,consent-conversation,consent-note,consent-voice,consent-summary,client-auth,undo}.ts`, `apps/core/src/compose-consent.ts`, `apps/core/src/platform/undo-log.ts`.
Tests: `amygdala.test.ts`, `consent*.test.ts`, `undo.test.ts`, `apps/core/src/{consent.e2e,consent-conversation.e2e,tool-sources}.test.ts`, `apps/core/src/node-pairing.e2e.test.ts`.

## Purpose

What waits for the owner. Workers run in park mode, so an approval they need ends their turn; the
amygdala makes those waits visible (`/attention`, `brain.amygdala.wait`) and answerable. Decisions
by policy are in `cortex.md` and `motor.md`; `brain.amygdala.decide` is `brain-events.md`.

## Public API (`index.ts`)

- `attentionOptions({ lead, cortex, tasks, people, store, lock? })` returns the `attention` option of
  `createHarnessHttp` (type `AttentionOptions`).
- `watchPending(store, warn?)` returns an `ActivityStore` that wraps another one.
- `createConsent({ riskOf?, elevatedOf?, max? })` returns `{ registry, plugin(role), learnedSource }`: the consent hook plugin of an agent (`'front'` or `'worker'`) and the registry
  the attention list reads (`tierOf`, `contextOf`). `consentContext`, `consentDecision`: the pure parts. `createUndoPlugin(log)`: the `undo_last` tool (the log is
  `createUndoLog()` of `platform/undo-log.ts`). `classifyConsent(message, summary, { model? })`, `classifyShort`: the consent classifier (below).
  `createConsentConversation(deps)` (`.message(call)`): the person's message answering a request asked in conversation. `createConsentVoice(deps)`: the audit row and the wake of a
  worker's request. `createClientAuth()`: the step-up of the client each person last wrote from. `watchPending(store, warn?, { ttlMs?, onApproval? })`: `onApproval` is called for each new approval.

## `/attention`

Mounted by thalamus (`thalamus.md`), behind a token whose person has `approvals.answer`
(`permissions.md`). Served by `eharness/http`:
`GET /attention` lists the items; `POST /attention/:id/answer` takes `{ sessionId, answer: { kind:
'approval', approved, reason?, note?, remember? } }` (`remember: 'session'` is allowed:
`allowRemember: true`). Answers: `resumed`, `recorded`, `already-answered`; unknown item is 404.

- `roots`: a member: `[front:<personId>]`; the owner: their own front session plus the front session
  of every other active person. Children (workers) are walked through the child index.
- `peek(sessionId, { agent?, parentSessionId })`: the front agent for the root; for a worker the
  agent of the catalog key (`info.agent`, else the `agent` of the task row), via `cortex.worker`.
  Unknown agent: no handle (the item is skipped).
- `open(sessionId)`: the live session on the agent that runs it: the front agent with the shared
  `lock` for the root, `worker.session(id)` for a task; an unknown worker session throws.
- `canAnswer`: see "Who answers" below. A session or item that is not the caller's to answer is a 404.
- `store`: the activity store, so every answer appends `attention-answered`; `agentId`: `front` or
  the task's catalog key.

An item carries the tool call as the model made it: for `motor_remote` that is `input.node`,
`input.capability` and `input.input.command`, plus `agent`, `sessionId` (the task id), `risk`
(`external`), `toolCallId` and `createdAt`. The TUI renders from that.

### Who answers (P9 step 3)

Which person owns a session is read from the id alone, never from live state: `front:<personId>`, or
for a worker the front session of its task's `parentSessionId`. Whether the owner answers an item is
`ownerAnswers(toolName, input, capabilities)` of motor (`motor.md`): a `motor_remote` call that asks
anyone (a capability whose risk for that input is not `read` and not `approval: 'never'` at `write`
or below, `shell.exec` on a node or on `core` included), or one that cannot be read. `capabilities` is
the core's registry (the attention deps carry it). Everything else (a member's
workspace writes, web calls) stays with the person whose session it is.

| Item | In the asker's list | In the owner's list | Answer |
| --- | --- | --- | --- |
| The owner's own | yes | yes | the owner; from a remote client `shell.exec` needs a step-up |
| A member's, owner-routed | yes, `extra.waitingFor = 'owner'` | yes, with `extra.askedBy` (username), `askedByName`, `node`, `capability`, `command` | the owner only; the member gets `403 KEITH_WAITING_FOR_OWNER`; remote owner needs a step-up |
| A member's, other | yes | no (`decorate` hides it) | the member |

- **Privacy exception.** The owner does not see members' messages or other items, but sees who asked,
  the node and the command of an owner-routed item: the owner is the one who runs the risk.
- `decorate` adds the `extra` above (and hides what is not for the caller). An approval item also carries `ageMs` and `expiresAt` (epoch ms, the creation plus `approvals.ttlMs()`; absent when the item has no readable creation time or no lifetime is configured) for the TUI's age line, and `scopable`: `true` for the caller's own item, `false` for a member's request the owner answers and for a member's own item that waits for the owner (ADR-0027 §14: such an answer never sets a grant, so the TUI offers no "allow for task"). `canAnswer` finds the
  item in the session's stored pending state; a member answering another person's session is `404`.
- **Expiry (ADR-0027 §10, §11).** A pending approval is denied after `approvals.ttlHours` (see "Approval lifetime" below); the sweeper is `expiry.ts`, run by `compose.ts` at boot and on every reconcile tick (60 s). It walks the attention queue of the front session of every person that `peopleFor('recover')` counts (active and suspended; `platform/sessions.ts`, the same rule as boot recovery; `listAttention`, no waits), and for each approval whose age (the attention item's `createdAt`, the UUIDv7 time of its message) reached the lifetime it answers `approved: false` with reason `this request expired after <N> hours; ask again if it is still needed` through `answerAttention`, the path the TUI uses. The parked worker resumes with that text. Each denial writes `approval.expired` (`{ sessionId, approvalId, ageHours, capability }`, no command text, actor `system`) and emits `brain.amygdala.expired`; a second sweep finds nothing to do. An approval whose age cannot be read is left alone. Stopping a task cancels its parked approval (ADR-0027 §11): every pending approval of the worker is answered denied with reason `the task was stopped` through `respond({ endTurn: 'after-answers' })`, so the command never reaches a node and the worker's turn ends without a model call (`Cortex.cancelPending`).
- **Step-up on answers.** From a remote principal that is not elevated, answering an owner-routed
  item is `403` with `{ error: { code: 'KEITH_STEP_UP_REQUIRED' } }` (denying needs one too: the
  answer body is not read before the check). The local socket is always elevated; a legacy token
  never is. Streams and listing never ask for it.
- **Step-up tools (ADR-0034 §3, §8).** `STEP_UP_TOOLS` (`@keith/contracts`: `persona_template`, `persona_edit`, `persona_restore`,
  `model_role_set`) are front tools that wait for approval when the conversation is tainted (they run at once when it is clean: "Consent" below). The person answers their own session as usual, but `canAnswer` denies the answer of
  one of these from a remote principal that is not elevated with the same `403 KEITH_STEP_UP_REQUIRED` (the local socket is always elevated).
  Test: `amygdala/step-up-tools.test.ts`.
- The audit trail (`AttentionTrail`): `describeApproval(sessionId, attentionId)` reads the approval while it still waits (node, capability, driver, redacted command capped at 200 characters); `appliedRemember(sessionId, attentionId)` returns the remember scope that `parseAnswer` applied (`once` when none is kept). The audit of `/attention/:id/answer` reads both (`approval.answered`, auth.md).
- `parseAnswer` drops `remember: 'session'` from an owner's answer to a member's owner-routed item:
  the member's next command asks again.
- Routing is by `/attention` only: the activity feed still carries `brain.amygdala.wait` for every
  person until P9 step 4 filters it per person.

The authorize hook of thalamus sees no `sessionId` on attention routes (the session is in the
body), so only the token is checked there and `canAnswer` does the per-session check.

## Approval lifetime (`settings.ts`, ADR-0027 §10)

The setting `approvals.ttlHours` (settings repo; integer 1 to 168, default 24) is read by `createApprovalSettings`: a missing or invalid stored value reads as 24, a value outside the bounds is refused on write (`RangeError`). Owner-facing: `admin.approvals.get` (`settings.read`, every person) and `admin.approvals.set` (`settings.manage`, step-up from a remote caller), audited as `settings.approvals.set` with `{ from, to }`; CLI `keith-core approvals ttl [hours]`. The sweeper that uses it is described under Expiry above.

The ping (`approvals.pingBeforeHours`, ADR-0027 §10, P28.3.6): a whole number 1 up to below the lifetime, default 2, read by the same `createApprovalSettings` (`pingBeforeHours()`). It is the hours before expiry at which the owner is told a request waits (the `approval-stale` built-in of `hypothalamus.md`). The built-in pings at `expiresAt` minus this setting, read live at each evaluation of its trigger (`hypothalamus.md`, "Triggers" and "Built-ins"); a change applies to approvals that start waiting after it, and a pending ping moves at its wake time. The ping never answers or expires the approval. The lifetime and the ping are checked as one pair: a lifetime at or below the stored ping is refused, and a ping at or above the lifetime is refused. `admin.approvals.set` takes `ttlHours`, `pingBeforeHours` or both (at least one; a refusal is `BAD_REQUEST` and writes neither), and `admin.approvals.get` returns the ping with its default. Each value given writes one `settings.approvals.set` row with `{ key, from, to }`. CLI `keith-core approvals ping-before [hours]`.

## `brain.amygdala.wait`

`watchPending(inner, warn, { ttlMs, now })` is the store every module appends to (compose builds it first). Appends pass
through; for a `pending-changed` event (written by the library `activity()` plugin when a turn ends
waiting) it adds `brain.amygdala.wait` for every approval in the snapshot that was not already
announced for that session: `{ region: 'amygdala', toolName, sessionId, count, approvalId, expiresAt }`
with `count` = approvals pending now across all sessions, `approvalId` the attention item id, and
`expiresAt` = the wait start plus the lifetime in force then (a later change of the setting does not
move it; P28's `approval-stale` pings relative to it). A row written before P24 has neither field.
The record's `sessionId` and `agentId` are set as before.
The payload is validated with `parseBrainEvent` before it is written (a bad one is dropped with a
warning). Tracking is in memory: per session the set of approval ids last seen; an empty snapshot
forgets the session, so the same id waiting again is announced again. Client tools and external
waits are ignored. A failure inside the watch never fails the append.

`brain.amygdala.expired` `{ region: 'amygdala', sessionId, approvalId }` is written by the sweeper for each
approval it denied (see Expiry above).

`brain.amygdala.decide` (the answer) comes from `brainEvents` on the `approval.decided` hook:
`by: 'user'` for an owner answer.

## Consent (ADR-0036, P39.1 and P39.2)

Decision: ADR-0036. Amygdala decides, for every tool call of the front agent and of the workers, whether it runs, is asked in the conversation, or is confirmed on a trusted device.
The decision is made by code from facts the model cannot forge, never by the model.

**Tool traits.** `metadata: { risk, source, reversible? }` (`permissions.md`, "Tool risk"): `risk` is eharness' `read | write | destructive | external`; `source` is `trusted | outside`
(undeclared: `outside`); `reversible: true` marks a write whose last change `undo_last` can take back (`persona_template`, `persona_edit`, `persona_restore`, `style_set`, `model_role_set`,
`presence_status_set`, and `undo_last` itself). `@keith/eh-ext` reads them (`toolSource(metadata, name)`, `toolReversible`, `declaresSource`) and knows the eharness tools by name
(`EHARNESS_TOOL_TRAITS`). `tool-sources.test.ts` builds the front agent and both workers with their real plugins, resolves every plugin and lists each tool with its source and
`reversible` mark in one table; a Keith-owned tool that does not declare `source` fails it, and so does a tool added without a row.

**Context (`consent-context.ts`, pure).** `consentContext({ transcript, sourceOf, origin })` over eharness' restricted transcript (`GuardTranscriptEntry[]`: the person's messages and the agent's
own tool calls, never an output, so an injection in a page cannot reach it):

| Origin | Rule |
| --- | --- |
| `person` (a front turn started by the person's own message) | `clean` when, after the newest `user` entry, every tool call is `trusted` (the newest entry before the call is the person's message, or only trusted calls follow it); a transcript with no `user` entry is `tainted` |
| `delegated-clean` (a worker whose delegating front call was clean) | the same rule; with no `user` entry (the task prompt is hidden from the transcript) the whole transcript must hold only `trusted` calls |
| `tainted` | always `tainted` |

A new message of the person after outside content makes it clean again. The tools a transcript names are looked up by name: the hook learns each tool's `source` from the metadata of every
call it reviews (`learned`), falls back to `EHARNESS_TOOL_TRAITS`, and `outside` for a name it has never seen (after a restart a session is cautious until its tools run again).

**How the hook knows the trigger of a turn (deterministic).** The front plugin's `turn.start` hook stores, per front session id, the trigger of the latest turn from `e.kind`: `send` and `edit`
are `person`, `wake` is `wake`; `respond` and `regenerate` continue the trigger of the turn before them. A wake is what a protocol, a plugin, a reminder, a worker report, a room hand-off or a
delivery digest starts (`session.inject(..., { wake: true })`). The origin is `person` only when the stored trigger is `person`; a session with no stored trigger (a restart) is `tainted`.
A person turn that merges a queued, non-waking event still counts as the person's. A worker has no trigger: `ctx.session.parent = { sessionId, toolCallId }` names the front call that delegated it, and the
registry holds the context of that call (`<session id>|<tool call id>`): `clean` gives `delegated-clean`; `tainted`, an unknown or evicted call, or no parent gives `tainted`.

**Table (`consent-table.ts`, pure).** The risk is the call's: `riskOf(name, input)` of the options (the core passes `motorConsentRisk`: `system.info` and any call that runs unasked are `read`, a
destructive capability is `destructive`, any other `motor_remote` call is `external`), else eharness' web tools (`web_fetch`, `web_search`) as `read`, else `e.risk`.

| Risk | Clean | Tainted |
| --- | --- | --- |
| `read` | `approved` | `approved` |
| `write`, reversible | `approved` (runs, with undo) | `user-approval`, tier `conversation` |
| `destructive`, `external` | `user-approval`, tier `conversation` | `user-approval`, tier `device` |
| `write` not reversible | no opinion (the tool's own rules and the agent's policy decide, as before) | `user-approval`, tier `conversation` |
| no risk | no opinion | no opinion |

**Self-confirmed tools.** A tool that runs its own confirmation outside the model declares `metadata.selfConfirmed: true` (`room_post`: the person confirms the exact text of a room post request, corpus-callosum.md); the consent hook gives no opinion on it, so the person is never asked twice. Learned by name, since re-validation passes calls without metadata.

**Step-up binds**, except for a clean reversible change: a `persona_*`, `style_set`, `model_role_set` or `presence_status_set` call the person asked for in a clean conversation runs without a step-up (undo and the budget caps are its guard; a PIN session could not step up with its PIN anyway). Otherwise a call of a `STEP_UP_TOOLS` tool (`persona_template`, `persona_edit`, `persona_restore`, `model_role_set`), or a call whose answer needs a step-up under `canAnswer` (a shell command: `ownerAnswers`, passed as `stepUpCall`), from a client that has not stepped up is `user-approval`, tier `device`, in
any conversation, clean or tainted, so `canAnswer` asks for the step-up on the card and the person's word in the chat never replaces it. "The client" is the one of the person's newest chat message:
thalamus records `stepUpDenial(principal, via) === undefined` for every `send` (`ClientAuth.note`, in memory) and the hook reads it through `elevatedOf(personId)`; a person never seen since the start counts
as not stepped up. The fact is cached with the call (`<session id>|<tool call id>`), so a step-up between the first decision and a re-validation never flips it. Without `elevatedOf` (the hook alone in a
test) every client counts as stepped up.

Both tiers answer `user-approval`; taint never answers `denied`. Every other rule stays and the most restrictive answer wins (eharness combines the hooks): a member's shell still goes to the owner, the
shell-off check still denies, `aclGuard` and the guest limits still deny, `STEP_UP_TOOLS` still need a step-up to answer from a remote client, a plugin `dangerous` operation still asks.
Consequence worth knowing: a persona, style or model change that runs in a clean conversation is never answered through `/attention`, so the step-up check of an answer does not apply to it
(the person's own words in their own authenticated chat are the consent); when it asks, the answer keeps the step-up.

**Cache.** The first decision of a call is kept by `<session id>|<tool call id>` (context and tier, bounded at 5 000, oldest first). eharness re-runs `tool.approve` when it re-validates an approved call:
the hook reuses the cached context, so the answer is the same even though the wire has changed (the continuation ends with the answered calls). Not persisted: a restart forgets it, and a call whose
tier is unknown counts as `device`.

**Tier on the attention items.** `AttentionDeps.consent` (the registry): an approval item's `extra.consent` is the stored tier (`conversation` or `device`); unknown, no tool call id, and an item the owner
answers for a member (a decision between two people, not consent in one conversation) are `device`. Without the registry the items carry no `consent`. The trusted-device routing is P39.4 (the card remains the way to answer
a `device` request). A request asked in conversation is answered in the chat (next section) or, still, through `/attention`.

**Undo (`undo.ts`, `platform/undo-log.ts`).** A reversible tool records, per person and front session, how to take its change back (`UndoLog.record`; the newest ten are kept; in memory):
persona (`persona.restore` to the version before, `prefrontal.md`), style (`styles.set` to the style before), model role (`setRole` to the model before, `providers.md`), presence status
(`setStatus` to the status before, `parietal.md`). The front tool `undo_last` (`{ risk: 'write', reversible: true, source: 'trusted' }`, no input) takes the newest entry of the person in this session off
the log and runs it, answering `{ ok: true, summary }` or `{ ok: false, reason, message }` (`nothing-to-undo`, `no-person`, `undo-failed`, or the service's refusal); it records no undo of its own, so a second
"undo" takes back the change before. Being a reversible write it is itself clean-only by the table (after outside content it asks in conversation). Each undo goes through the same service and writes the same
audit row as the original action (`persona.restore`, `persona.style.set`, `settings.model.set`, `presence.status.set`), so nothing is invisible.

## Asked in conversation (ADR-0036 §4, P39.3)

A request of tier `conversation` waits as an ordinary eharness approval. Who says it, who reads the answer and when it expires:

**Voicing.** A front call: the front agent says it itself before the call (`CONSENT_INSTRUCTIONS`, `wernicke-broca.md`). A worker call: `watchPending` calls `onApproval` for each new approval after its
`brain.amygdala.wait` event; `createConsentVoice` reads the pending approval of its session (the tool call id and input), keeps the stored tier (only `conversation`), writes `consent.asked` (tier, tool, session, call id; no
input text, for front and worker calls alike) and, for a worker session, hands one wake to the delivery service (`id: consent:<session>:<approval id>`, `source: amygdala:consent`, name `consent.request`, `needs.mode: wake`,
never `immediate`): the person's presence may hold it, then it is released with the digest or simply expires with the request. Its text is the one-line summary (`approvalSummary`: `<capability> on <node>: <command>`, the
command redacted and capped at 200 characters, framed with `untrustedContent({ source: 'worker-request' })` because a worker wrote it; the tool name for anything else) and asks the front agent to voice it: what, where, why, exactly
one yes/no question, no tool, never "done", never answering for the person.

**Classifier (`consent-classifier.ts`).** `classifyConsent(message, summary, { model? })` answers `yes | no | other`. First the fixed list on the normalised message (NFKC, lowercase, apostrophes dropped, punctuation, symbols and
emoji removed; 👍 and 👎 read as ok and no; at most 6 words): it decides when every word is a phrase of one list or a filler (`please`, `tolong`, `dong`, `sir`, ...), with at least one phrase; a mix, an unknown word or more than
six words does not decide. Yes: yes, yeah, yep, yup, ya, iya, iyah, yap, yoi, ok, oke, okay, okey, sure, boleh, lanjut, lanjutkan, gas, go ahead, go, silakan, silahkan, setuju, do it, jalankan, proceed, confirm, approved,
sounds good, oke gas. No: no, nope, nah, tidak, tdk, nggak, ngga, enggak, engga, gak, ga, jangan, jgn, stop, batal, batalkan, cancel, dont (don't), dont do it, do not, do not do it, never, wait, hold on, belum, tunggu
(after a no, `ya`, `yah`, `aja`, `usah`, `deh`, `dulu` may follow: `jangan ya`; `ya jangan` is left to the model). For the rest, one `generateText` call on the front role's model (no cheaper role exists; `thinking`
off for the call kind `consent`, recorded in the activity logs as `aux:consent:<person>`) with a tiny system prompt and `maxOutputTokens: 8`; it sees only `Request: <summary>` and `<reply>message</reply>` (each cut, `<` and `>`
stripped), never the transcript or any outside text. The first word of its answer decides: `yes`, `no`, else `other`; a failure, a timeout (8 s) or no model is `other`, so a failure never approves.

**Hook (`consent-conversation.ts`).** The seam is the chat route of thalamus: `createHarnessHttp` `chat.validate` runs for every `send` after authorize and the body clean-up, before the session is opened and so before
eharness applies `onNewInput` to the pending approvals (`11-interaction.md` §4.1). Thalamus passes the person's text (the text parts of the newest user message), the principal and the listener (`tcp` or `local`, kept per request) to
`ConsentConversation.message`; only a message a signed-in person sent to their own front session reaches it, and nothing else (a page, a worker report, a room message, a wake) ever does, so a planted "yes" is never read.
`message` records the client's step-up (`ClientAuth`), then looks at the person's own chat: `listAttention` over the person's front session (their front calls and their workers'), the approvals whose stored tier is
`conversation` and whose age is under the lifetime; the newest one (by `createdAt`) is the candidate. `device` and unknown tiers are never answered here. The answer route's own rule applies first
(`attention.canAnswer`: the person's own session, an owner-routed item such as a member's shell is the owner's alone, step-up tools and shell from a remote client that has not stepped up): when it does not say `true` the message
is forwarded untouched and the card stays the way. Then:

| Classifier | Request of a worker | Request of the front agent (the turn is parked on it) |
| --- | --- | --- |
| `yes` | approved (`remember: once`, through `answerAttention` as the person, so re-validation, `approval.decided` and the audit hold); then the person's message (a bare yes included) is sent to the front session as an ordinary input carrying a framed note (below) | approved; the message (a bare yes included) goes with the answer as an approval note (`11-interaction.md` §3.6, the first step of the continuation reads it); the message is not forwarded either way |
| `no` | denied, reason "the person said no"; the message goes on the same way, with the note | denied, reason "the person said no", the person's words appended to the reason (§3.6: a denied call carries the note in its reason only) |
| `other` | denied, reason "the person moved on", the message forwarded | not answered here: the message is forwarded and eharness denies the call as new input (`onNewInput: 'deny'`) with the message after it |

A message the route does not forward is answered with `202 { inboxId: <approval id>, delivered: 'steer' | 'queue', target: 'local', consent: 'yes' | 'no' }`, the shape clients already treat as "queued" (the answer comes from the
continuation or the turn in the activity feed). For the front agent's own call the person's words are the approval note: stored as `data-eh.input` (`source: 'user'`, `approvalNote`) of the continued assistant message, not as a user message,
and only an approved call stores it as such (a denied call keeps the words in the reason).

**A worker's answer reaches the front agent (P39.3 follow-up).** The worker's request is answered first, by the classifier and the core, before any model reads the message: the approval never depends on the front agent. Then the message
is sent to the front session (`ConsentConversationDeps.forward`, wired in `compose-consent.ts`) as `session.send(text, { ifBusy: 'queue' })` on the session opened with the shared lock and the person as principal (`frontSessionOptions`):
the message is stored in the chat like any other and a turn acknowledges it. A turn that holds the session (a worker report wake, a long answer) does not make it fail with `409`: eharness keeps the input in its in-memory FIFO and runs it
as a queued turn when the session is free (`11-interaction.md` §6.2); nothing bounces back to the client as a draft, the route answers `202` with `delivered: 'queue'`. The worker's answer is sent without waiting for its run
(`settleMs: 1`) so the message reaches the front session before the worker's report wakes it. The note comes from `consent-note.ts`: `createConsentNotes()` keeps it by session and message text, and its plugin (`input.submit`, on the front
agent) returns it as `context`, an extra text part of the stored user message (`eh.augmented`, which UIs hide and the context service and dreaming already skip). It reads `<system-reminder>` "the person answered yes|no to: <summary, framed as an
untrusted `worker-request`>. The core already decided it: approved|denied. Acknowledge in a few words, in the person's language. Do not ask again and call no tool for it." The answer and the decision are code's words; only the summary is a worker's, and
it is framed. If the send is refused the note is dropped and the message is forwarded by the route as before. The queue is in memory: a restart between the answer and the turn loses the acknowledgement, not the answer. `other` is unchanged
(denied "the person moved on", the message forwarded by the route with no note). Each handled request writes `approval.answered` (as for a card; `remember: once`) and `consent.answered`.

**Expiry.** A request of tier `conversation` lives `CoreTiming.conversationTtlMs` (default 10 minutes; a code constant, since the approval setting counts hours), also the `expiresAt` of its attention item. The sweeper
(`expireApprovals`, boot and every `reconcileEveryMs`, 60 s by default) denies it with the reason "no answer in the conversation" and writes `consent.answered` with `expired` instead of `approval.expired`; a request past its
lifetime is no longer a candidate of the hook even before the sweep.

**Audit.** `consent.asked` (`tier`, `tool`, `session`, `callId`) when a conversation request is created; `consent.answered` (`answer: yes | no | other | expired`, `tier`, `tool`, `session`, `callId`; actor the person,
`system` for `expired`). Never the message, the summary or any input text (`auth.md`, audit kinds).

## Invariants

- An owner-routed approval is never answered by a member, in any session.
- The activity feed follows the same rule: the owner receives `brain.amygdala.wait` of a member's
  owner-routed item (tool name and count only), nothing else of the member (`thalamus.md`).
- A person never sees or answers another person's items, except the owner's view of owner-routed items.
- A call is never decided from text the model read: the context comes from the restricted transcript and the turn's trigger only (`Consent`), and a wake turn is never clean.
- Only the person's own authenticated chat message answers a request asked in conversation; no outside text, wake or report reaches the classifier, and a `device` request is never answered in the chat.
- The classifier never approves on a failure: a model error, a timeout or an unclear answer is `other`.
- `tool.approve` of the consent hook never answers `denied` because of taint, so a re-validation cannot flip an approved call; the tier of a call is the one stored when it was first decided.
- A protocol `act` with its owner's stored pre-approval runs without a `user-approval` item, so it never appears here (the one
  exception to the approval rule, ADR-0024 §3; `motor.md` "Invariants"). Its audit row is `protocol.act`.

## Tests

`consent-context.test.ts` (transcripts to clean or tainted: a person message, trusted reads, a web fetch, an agent delegation, a wake, a new person message after outside content, workers), `consent-table.test.ts` (risk x
context to status and tier, never denied), `consent.test.ts` (the hook: trigger by turn kind, cache and re-validation, workers clean and tainted, risk overrides, bounds), `consent-attention.test.ts` (the tier on items),
`consent-classifier.test.ts` (the list by table, the model part with a scripted model), `undo.test.ts`; `consent-conversation.e2e.test.ts` (a worker's shell request voiced by the front agent and answered "ya" and "no" (the message stored, the front agent acknowledges from the framed note), a busy front session that queues the answer, a new topic, a yes with more words; the front agent's own request; a "yes" in a worker report; a `device` request; expiry; the step-up of a cold client); `consent.e2e.test.ts` (real core, scripted models: a clean persona switch runs with no pending approval and "undo" restores, the same after outside content or in a wake turn asks with tier
`conversation` and the approved call runs, a worker's shell command is `conversation` when delegated cleanly and `device` after outside content, frames); `tool-sources.test.ts`.
`amygdala.test.ts`: wait events (payload, dedupe, count across sessions, re-announce, ignored kinds,
bad snapshots, pass-through), roots, peek/open routing, `canAnswer`, audit agent id.
`member-shell.e2e.test.ts`: a member's `shell.exec` waits for the owner (member sees
`waitingFor`, answers `403 KEITH_WAITING_FOR_OWNER`; owner sees asker, node and command; a cold owner
session needs the step-up, then answers; another member gets `404`).
`node-pairing.e2e.test.ts`: the denied and approved flows read and answer `/attention` over HTTP and check the
events in the feed.
