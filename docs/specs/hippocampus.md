# Hippocampus (memory)

Code: `apps/core/src/modules/hippocampus/`. Recall events: `brain-events/plugin.ts`. Tests:
`apps/core/src/memory.e2e.test.ts`.

## Purpose

Keith remembers what each person asks it to remember, across sessions and restarts. Every person
has their own folder of small text files, exposed to the agents through eharness' `memory()` plugin
(eharness spec 14). One person's agents never read or write another person's folder.

## Public API (`index.ts`)

- `hippocampus({ dataDir, store, nameOf?, workspace?, workspaceTools?, readOnly?, flushOnCompaction?, warn? })`
  returns the two plugins an agent needs, in order: `filesystem(...)` then `memory(...)`. `nameOf`
  gives the display name used in the root's label (never throws).
- `memoryBase(dataDir)` = `<dataDir>/memory`; `memoryDir(dataDir, personId)` =
  `<dataDir>/memory/<personId>`; `MEMORY_ROOT` = `/memories`; `memoryRootOf(personId)` =
  `/memories/<personId>`; `profilePathOf(personId)` = `/memories/<personId>/profile.md`;
  `HIPPOCAMPUS_PROTOCOL`.

## How it is mounted

`memory()` needs the `fs` service of a `filesystem()` plugin, and an agent can have only one.
Every agent therefore gets one `filesystem` over `mountFs`:

| Agent | Mounts | File tools |
| --- | --- | --- |
| front, `cortex.research` | `/memories/` -> `diskFs(<dataDir>/memory)` | none (`tools: []`, `toolOutputs`/`toolMedia` off) |
| `cortex.general` | `/` -> `diskFs(<dataDir>/workspace/people/<personId>)` (resolved per session from `ctx.principal`) and `/memories/` as above | the workspace tools of `cortex.md` |

`hiddenPrefixes: ['/memories']` keeps the generic file tools of `cortex.general` away from the
memory; it is reached only through `memory_*`. Workspace paths do not change (`/notes.md`). The `workspace` option is a resolver `(ctx) => string | undefined` (the folder of that session's person; `undefined` = no `/` mount).

## Memory

- **One root per person.** `memory({ roots: (ctx) => … })` returns the single root
  `/memories/<personId>` (`write: true` for the front agent), where `personId` is the person of the
  person who asked for the turn: `ctx.principal.id` (eharness 0.10, ADR-0069). Thalamus sets it when
  it opens the front session (`platform/sessions.ts`, `frontSessionOptions`), and a worker inherits
  the principal of the turn that sent it. A session of no person (no principal), or an id that cannot name a
  folder, gets no root (memory off). The label names the person (`what you know about <name>`).
  Because the mount covers all of `<dataDir>/memory`, the roots are what keep a person out of
  another's folder: any other path answers `REJECTED: … is outside the memory roots`, a worker of
  Ana's task gets Ana's root only (read-only), and `hiddenPrefixes` keeps file tools away.
- One pinned file `/memories/<personId>/profile.md`, shown in every turn (default `maxPinnedChars`
  2000). The file is not created at boot: a missing pinned file is skipped, and an empty one would
  make `memory_create` fail with "already exists". The agent creates it when the person first
  states a lasting fact.
- **Owner and transfer.** The owner's id is `owner`, so the folder of a first install stays
  `memory/owner`. Other people use their id (`memory/<uuid>`). The folder belongs to the person, not
  the role: after `transfer-owner` the new owner keeps their own folder and the former owner keeps
  `memory/owner`; nothing moves.
- **Retention.** A suspended person's folder and sessions stay on disk, and nothing routes to them. A removed
  person's folder moves to `workspace/keith/removed/<personId>/memory` and is purged 30 days after removal
  (`people.md`, Rules).
- Tools: `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete`,
  `memory_rename`. The front agent also sets `flushOnCompaction: true`: before a compaction
  summarizes history it gets a flush step to write facts to memory (`wernicke-broca.md`).
- Discipline (`HIPPOCAMPUS_PROTOCOL`, replaces eharness' default protocol, a static instruction):
  store durable preferences and facts about the person talking; never system state, task progress or
  results, credentials, passwords, API keys or tokens; refuse to remember a secret; notes are data.
  The protocol never says "your owner": who the front agent talks to is a per-turn instruction
  (`wernicke-broca.md`, `whoText`) and the root's label.

## Who writes, and the secret guard

- Two writers, the same root, the same guard. During a person's turn, only the front agent writes memory (`memory_*`).
  The applier of the `dream` protocol is the second writer (ADR-0031 §4, `dreaming.md`): code that acts for the same
  person, outside any turn, under the same root `/memories/<personId>` and the same secret guard. The judge model of a
  dreaming run never writes (ADR-0031 §7): it returns a plan, and the applier writes it. Workers (`readOnly: true`) have the root `/memories` with
  `write: false`: the `memory_*` tools stay but every mutation returns `REJECTED: … is read-only`,
  and their protocol (`HIPPOCAMPUS_READONLY_PROTOCOL`) says to put anything worth remembering in
  the report. Reason: workers fetch web pages, and a page must not be able to plant instructions in
  `profile.md`, which is pinned into every front prompt.
- Every front write (`memory_create`, `memory_str_replace`, `memory_insert`) passes the
  `secretGuard` plugin (`secret-guard.ts`), a `tool.approve` hook that decides from the input only
  and answers `denied` with `SECRET_REFUSAL` (an English text that ends "Say that it was not saved, and keep the secret out of the chat."; no static text assumes who the person is; the model sees it as the tool result and answers in the person's language) when
  any string of the input matches: `keith_` token, `Bearer x`, `sk-or-v1-…`, `sk-…` (20+ chars),
  PEM `-----BEGIN`, a JWT `eyJ….….…`, or a 32+ char run of `[A-Za-z0-9_-+/=]` with lower, upper and
  digit characters and entropy >= 3.5 bits/char (runs with more than two `/` are paths). The check
  is a backstop for the protocol, not a substitute for it.

## Events

- `brain.hippocampus.write`: from `memory({ onWrite })`: `{ region, personId, op, path, taskId? }`; `path` is the
  new path for `rename`; `taskId` is the session id when the write ran in a worker.
- `brain.hippocampus.recall`: from the `step.end` hook of `brainEvents` when a `memory_view` call
  returned an output: `{ region, path, taskId? }`. Reads fire no `onWrite`, hence the second source.
- `memory_*` tools are in the motor exclusions (`brain-events.md`): they never light the motor.

## Invariants

- Memory lives only under `<dataDir>/memory/<personId>`, and a session reaches only the root of its
  own person (the roots, plus `diskFs` containment under `<dataDir>/memory`).
- A failing event append never fails a memory call (`emit` is fire and forget).
