# Permissions

Code: `packages/contracts/src/capabilities.ts` (the closed set, the role table, `ProcedureMeta`),
`apps/core/src/platform/rpc.ts` (`authorize`, the one middleware),
`apps/core/src/modules/auth/capabilities.ts` (role table plus grants, `stepUpDenial`),
`apps/core/src/modules/people/grants.ts` (grants service), `packages/db/src/repos/grants.ts` (store).
Tests: `packages/contracts/src/capabilities.test.ts`, `modules/auth/permissions.e2e.test.ts`,
`member-shell.e2e.test.ts`.

## Purpose

Who may do what, in one place. A **capability** is a name from a closed set. Every oRPC procedure
declares the one it needs as metadata; a **role** (`owner`, `member`) grants a fixed set, and
**grants** add single capabilities to a person. A few calls are **sensitive**: from a remote client
they also need a recent step-up (`auth.md`).

## Capabilities (`CAPABILITY_IDS`)

| Capability | What it allows |
| --- | --- |
| `chat` | the person's own front session (`/sessions/*`) and the activity feed; `presence.*` (the person's own clients, manual status and disclosure: `presence.clients.register|heartbeat|goodbye|ack|list|remove`, `presence.mine`, `presence.setStatus`, `presence.disclosure.set`; no step-up, `parietal.md`); `persona.get`, `persona.style.get|set` (the persona text for everyone who can chat, and a person's own style, `prefrontal.md`); `chat.newContext`, `chat.compact`, `chat.generations`, `chat.history` (the caller's own front session: a context reset, a manual compaction, and the caller's old generations, `chat-context.md`; no step-up, no owner gate, ADR-0030); `dream.status|mode|now|apply|undo|diary` (the caller's own memory dreaming: its mode, a run now, the apply of a staged plan, the undo of an applied run, and the diary of one day; no step-up, ADR-0031 §5; `dreaming.md`); `protocols.list|get|save|setEnabled|pause|delete|runs|answer` on the person's own protocols (`answer`: the open question of the person's own run only) (the owner sees all, a member's read is audited; the pre-approval of an `act` over TCP needs a step-up, `hypothalamus.md` "RPC") |
| `tasks.own` | `tasks.list`, `tasks.stop` on their own tasks |
| `nodes.read` | `nodes.list` (every node: nodes are Keith's self layer, ADR-0020 and ADR-0027 §9; the per-person filter of OWN-008 applies to the activity feed only) |
| `nodes.manage` | `nodes.pair`, `nodes.revoke` |
| `settings.read` | `providers.describe`, `providers.models`, `models.roles.get` (model names, no secrets), `models.price.list`, `admin.approvals.get`, `protocols.settings.get` |
| `settings.manage` | `providers.list|put|remove|test`, `models.roles.set`, `models.price.set|clear`, `admin.access.get|set`, `persona.setTemplate|edit|restore` (owner only, step-up, one persona version each, `prefrontal.md`; the front tools `persona_*` do the same through the persona service: owner only; in a clean conversation they run with undo and no step-up; when tainted they wait on a device and answering from a remote client needs a step-up, `STEP_UP_TOOLS`, ADR-0036) |
| `budget.read` | `budget.get` (the caller's own scope; the owner, who holds `budget.manage`, also gets the global scope and every person, `budget.md`) |
| `budget.manage` | `budget.set` |
| `people.manage` | `admin.people.*` (including grants, passwords, PINs). Members only: never the owner or yourself (the service refuses with `FORBIDDEN`, `people.md`). `admin.people.export` and `admin.people.setLogin` are owner only: a delegate is refused with `FORBIDDEN` (`people.md`, Export and Identifiers) |
| `tokens.manage` | `admin.tokens.*` (the caller's own tokens: `list` is scoped to the caller, and `revoke` acts on the caller's own credentials unless the caller is the owner; any other id answers `NOT_FOUND`, ADR-0027 §5) |
| `devices.manage` | `admin.devices.*` (approve as the caller's own person; `revoke` has the same scope: own credentials unless the caller is the owner) |
| `audit.read` | `admin.audit.list`, `admin.audit.retention.get` (the retention calls also require the owner role in the handler; `set` is `settings.manage` with a step-up), `admin.presence.read` (the raw presence of one person, audited as `presence.read`, `parietal.md`), `admin.notice.send` (the owner's test notice, audited as `delivery.test_notice`, `delivery.md`), `persona.history` and `persona.style.read` (the owner's read of another person's style, audited as `persona.style.read` and `acl.owner-access`, `prefrontal.md`). **Owner role only** (`OWNER_ONLY_CAPABILITIES`, ADR-0027 §6): a grant is refused (`BAD_REQUEST`), a stored one is ignored by `capabilitiesOf` and listed by `keith-core doctor` (`grants`). A member reads only the lines about themselves through `audit.mine` |
| `audit.mine` | `admin.audit.mine` (the person's own lines: rows where they are the subject or the owner of the resource; held by every role, never grantable as an extra because the member role has it) |
| `logs.mine` | `logs.sessions`, `logs.session`, `logs.call`, `logs.raw`, `logs.status`, `logs.purge` (own person) on the caller's own model-call log: sessions the caller owns, and room sessions while the caller is a member with `r` (`activity-logs.md`, "Rights"). Held by every role; no step-up for the caller's own rows |
| `logs.read` | `logs.settings.get`, and the owner's read of another person's sessions and raw bodies (`logs.sessions` with `scope: everyone`, `person`, `logs.raw` on another person's call; audited as `logs.owner-read` and `acl.owner-access`). **Owner role only** (`OWNER_ONLY_CAPABILITIES`): a grant is refused (`BAD_REQUEST`), a stored one is ignored by `capabilitiesOf`. `logs.purge` of another person is also `logs.read` with a step-up (`activity-logs.md`, "RPC") |
| `approvals.answer` | `/attention` (list and answer); which items is `amygdala.md` |
| `reviews.decide` | `admin.reviews.*` (list, approve, deny the operations plugins hold for the owner, `plugins.md`). **Owner role only** (`OWNER_ONLY_CAPABILITIES`); approve and deny are `sensitive` (a step-up over TCP) |
| `plugins.manage` | `admin.plugins.*` (list, show, views.list, enable, disable the built-in plugins, `plugins.md`, "Operator surface"). **Owner role only** (`OWNER_ONLY_CAPABILITIES`); enable and disable are `sensitive` and apply at the next boot |
| `guests.manage` | `admin.guests.*` (get, set, killswitch, list, end, peek the anonymous guest mode, `guests.md`). **Owner role only** (`OWNER_ONLY_CAPABILITIES`); everything that changes something is `sensitive`. Picking the `guest` model role (`models.roles.set`) also needs it |
| `groups.manage` | `admin.groups.*` (create, delete, add and remove members). **Owner role only**: it is in `OWNER_ONLY_CAPABILITIES`, so a grant is refused (`BAD_REQUEST`) and a stray row is ignored by `capabilitiesOf` |
| `succession.manage` | the succession settings (`admin.succession.setHeir|clearHeir|setWindow|pause|resume`, `succession.md`); every change needs a step-up over TCP. **Owner role only**: it is in `OWNER_ONLY_CAPABILITIES`, so a grant is refused (`BAD_REQUEST`) and a stored one is ignored by `capabilitiesOf`. The heir's own `admin.succession.claim` is `authenticated` with a step-up, decided in the handler |
| `rooms.start` | `rooms.start` (`corpus-callosum.md`): `rooms.start` starts a room with invitees. Invitations, accept, leave and the room's transcript are `chat` calls with membership checked in the room service, and `rooms.remove` and `rooms.end` are for the initiator or the owner. The owner holds it; a member holds it only by a grant (`keith-core people grant`). **Not owner-only**: it is not in `OWNER_ONLY_CAPABILITIES`, so a grant works (ADR-0026 §1) |

`ProcedureMeta.capability` may also be `authenticated` (any signed-in principal): `health.get`,
`auth.whoami`, `auth.logout`, `auth.pin.set` (a step-up is required over TCP, so a PIN session cannot call it), `auth.sessions.list`, `auth.sessions.revoke` (ending a session other than the caller's own over TCP needs a step-up, checked in the handler). `admin.audit.notice.get|ack` (the first-login privacy notice, per person).

## Dreaming (P35, ADR-0031 §5 and §8; `dreaming.md`)

- The person's own dreaming (`dream.status`, `dream.mode`, `dream.now`, `dream.apply`, `dream.undo`, `dream.diary` for the caller's own day) is
  the `chat` capability: no step-up, because it changes only the person's own memory (the same rule as a memory write, ADR-0031 §5).
- The member default `dreaming.memberDefault` is an owner change: `dream.settings.set`, `settings.manage`, with a step-up over TCP, like the other
  settings; the handler also requires the owner. `dreaming.maxUsdPerRun` is the same route (owner, step-up); its read is `settings.read`.
- A member reads the owner's diary never. The owner reads a member's diary with `dream.diary` (`{ personId, date? }`): the handler checks the owner
  (a delegate with `people.manage` is refused), and the read writes `acl.owner-access` with kind `dream-diary`. A member asking for another person's
  diary gets `NOT_FOUND`, the same as for a missing one.
- Nothing in these rows is a grant: a member's `dream.*` on their own folder needs no grant, and a grant never widens another person's read.

## Activity logs (P36, ADR-0032 §8; `activity-logs.md`)

- `logs.mine` is held by every role and reads only the rows the caller may read under `canReadSession` (the person's own sessions, and room
  sessions while a member with `r`). It is not a grant: a removed membership or a suspension ends it at the next call.
- `logs.read` is the owner's, and only the owner's: the owner reads another person's sessions and raw bodies through the audited owner path
  (`logs.owner-read` and `acl.owner-access`, shown to the person under `audit.mine`). Nobody else holds it, and a member's token never gets it.
- Nothing in these rows is a grant. A grant never widens another person's log read.

## Plugin capabilities (closed set at runtime)

A plugin's manifest declares `permissions` (`<plugin-id>.<name>`, `docs/specs/plugins.md`). At load the host registers them in the capability registry (`createCapabilityRegistry`,
`@keith/contracts`), which is the closed set at runtime: the core ids above plus the registered ones. An id cannot shadow a core id or another plugin's, and a plugin that fails to load takes its ids back.
`Capabilities.of(principal)` (now a set of strings) is `capabilitiesOf(role, grants)` plus every plugin id whose manifest `roles` include the role (the owner holds all of them) plus the person's grants that are
registered ids. The oRPC contract takes capability ids on the wire as strings (`PersonCapabilitySchema`): `admin.people.grant|revokeGrant` check the id against the **live registry** (the core ids plus the loaded plugins'; an unknown id, or a plugin that is not loaded, is `BAD_REQUEST`), `admin.people.grants` reports the known ones, and `auth.whoami` lists every capability the person holds, core or plugin. `admin.capabilities.list` (`people.manage`) is the picker's source. The test walking `keithContract` accepts `CAPABILITY_IDS` and `authenticated`; the test walking plugin operations (`packages/host/src/capabilities.test.ts`) accepts the ids the
manifests declare.

## Function level and resource level

This document is **function level**: which procedure a person may call. **Resource level** (may this person read this note, fire this
reminder) is a second, separate check that a plugin makes with the ACL (`acl.md`, ADR-0015). A call must pass both: a capability lets a
member call `notes.read`, and the ACL then decides which notes. The owner role holds every capability and, on resources, a read of
anything that is audited (`acl.owner-access`); a grant never widens a resource. Isolation that is structural today (`memory/<personId>`,
`front:<personId>`, budget scopes) is unchanged.

## Roles and grants

| Role | Capabilities |
| --- | --- |
| `owner` | all |
| `member` | `chat`, `tasks.own`, `nodes.read`, `settings.read`, `budget.read`, `approvals.answer` |

The capability `succession.manage` (the heir, the succession window and pauses) is owner only, like `audit.read` and `groups.manage`: `succession.md`. A grant is a row of `person_grants` (`people.md`), managed with `keith-core people grant|revoke-grant
<username> <capability>` (`admin.people.grant|revokeGrant|grants`, `people.manage`, step-up). The
principal's capabilities are `ROLE_CAPABILITIES[role] ∪ grants`, read per request. A grant never
lowers a step-up requirement, and the owner needs none. Guests are not people and hold no capabilities: they have their own listener and tool allow-list (`guests.md`, ADR-0017).

`acl.show|share|unshare|chmod|chgrp` are `authenticated` and decide in the handler, on the stored resource, whether the caller owns it (or is the owner role); `acl.chown` is `people.manage` with a step-up and also checks the owner role. Widening to `@public` or `@users` needs a step-up checked in the handler (`acl.md`).

ACL-changing agent tools (`acl_*`) always ask the person first (`aclGuard`, `acl.md`, "Confused deputy"), whatever the risk table says.

## The middleware

`rpc` (`platform/rpc.ts`) runs `authorize(meta, context)` before every handler (and before the audit
hook):

1. no `capability` in the metadata: `FORBIDDEN` (fail closed; a test also fails the build);
2. the capability is not in `context.capabilities`: `FORBIDDEN`, "you do not have the X capability";
3. `stepUp` is set, the call is over TCP and the principal is not elevated:
   `ORPCError('KEITH_STEP_UP_REQUIRED', { status: 403 })`.

`context.capabilities` is built by thalamus from `Capabilities.of(principal)` for the call. The test
`capabilities.test.ts` walks `keithContract` and fails when any procedure lacks metadata, names an
unknown capability, or when a `*.manage` call that changes something lacks `stepUp`.

## Step-up matrix

| Capability | Needs a step-up over TCP |
| --- | --- |
| `settings.manage` | `providers.put|remove`, `models.roles.set`, `admin.access.set`, `admin.approvals.set`, `protocols.settings.set`, `persona.setTemplate|edit|restore` (not `list`, `test`, `access.get`) |
| `budget.manage` | `budget.set` |
| `nodes.manage` | `nodes.pair`, `nodes.revoke` |
| `people.manage` | everything except `list`, `get`, `grants`, `alias.list` |
| `tokens.manage` | `create`, `revoke` (not `list`) |
| `devices.manage` | `approve`, `deny`, `revoke` (not `list`) |
| `settings.manage` (policy) | `admin.auth.policy.set` (not `get`); both also require the owner role in the handler |
| `people.manage` (sessions) | `admin.sessions.revoke` (not `list`) |
| Answering a `shell.exec` approval (`/attention`) | yes (see below) |
| A `STEP_UP_TOOLS` front call (`persona_template|edit|restore`, `model_role_set`) from a remote client that has not stepped up | yes, even in a clean conversation: the call waits as a `device` approval and its answer asks for the step-up (`amygdala.md`, "Step-up binds"); the person's word in the chat never replaces it |
| everything else | no |

The implicit owner of the local socket (opt-in local trust `idle-lock` or `full`, `auth.md`) is always elevated; a session on the socket steps up like on TCP, and `keith-core` asks for the PIN as needed. A session credential is elevated for
10 minutes after `POST /auth/step-up` (`auth.md`).

### Legacy tokens

A legacy `keith_<b64>` token has no credential row and no PIN or password behind it, so it can never
be elevated: a sensitive call with one is `KEITH_STEP_UP_REQUIRED` with the message "a legacy token
cannot step up: replace it with `keith-core token create`". To do sensitive things remotely, replace
the legacy token with a `token` credential (or sign in) and step up.

## Routes that are not oRPC

| Route | Check |
| --- | --- |
| `/sessions/*`, `/activity*` | `chat`; a person reaches only their own front session (404 otherwise) |
| `GET /attention` | `approvals.answer`; items are routed per person (`amygdala.md`) |
| `POST /attention/:id/answer` | `approvals.answer`, then `canAnswer` (`amygdala.md`): an owner-routed item is the owner's alone, and from a remote client needs a step-up |
| `POST /plugins/<id>/<op>`, `GET /plugins/openapi.json` | a signed-in principal; the operation's own capability, audience and ACL rule are checked by the plugin guard (`plugins.md`); a denial is a `404`, identical to a missing operation |
| `/health`, `/auth/*`, `/nodes/join`, `/nodes/ws` | open or their own credential (`auth.md`, `nodes.md`) |

A refusal by a capability on these routes is `403 { error: { code: 'FORBIDDEN' } }`; a step-up
refusal on `/attention` is `403 { error: { code: 'KEITH_STEP_UP_REQUIRED' } }`; a member answering an
owner-routed item gets `403` with code `KEITH_WAITING_FOR_OWNER`.

## Tool risk

Tools keep their own risk (`motor.md`, `cortex.md`) and, since ADR-0036, declare a **source** next to it: `metadata: { risk, source: 'trusted' | 'outside', reversible? }`
(`@keith/eh-ext` `toolSource`, `toolReversible`, read like eharness `toolTraits`; the type is `ToolSource` in `@keith/contracts`). `trusted` is Keith's own state and the person's own data;
`outside` is anything a third party can have written (web pages and search results, plugin text from other people, room messages, other people's notes, node and desktop
output, a worker's report). A tool that declares nothing is `outside`; the tools eharness ships are known by name (`EHARNESS_TOOL_TRAITS`). Since ADR-0039 a tool may also declare an **effect**
(`metadata.effect`: `none | local | behavior | egress | destructive`, `toolEffect`; else derived from the risk); effect, source and the
provenance of a call's targets decide how it is consented (`amygdala.md`, "Consent"). The one rule that crosses people: a member's
`shell.exec` (on a node or on `core`) is an approval the owner answers (`amygdala.md`, "Who answers"),
shown to the owner with the asker, node and command (the documented exception to "the owner does not
see members' messages"). `tool.approve` stays deterministic: it never reads who asks, and it decides from the input and static tables, with one exception that can only deny: the shell-off check reads the live node registry (`motor.md`).

## Invariants

- Every contract procedure has capability metadata (test).
- The owner has every capability; a member never gets a `*.manage` capability by role.
- A legacy token never elevates; the implicit owner of the local socket (opt-in) is always elevated.
- A grant is the only way to add a capability to a member; there is no way to remove one from the owner.
