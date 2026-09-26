# Storage

One SQLite file (`~/.keith/keith.db`) plus one data folder (`~/.keith/files/`). No storage adapter layer ([ADR-0006](../decisions/0006-sqlite-only-storage.md)).

## Rules

- Only `packages/core/src/storage` imports `bun:sqlite` or Drizzle. Everything else uses the repository interfaces in `storage/types.ts`.
- Migrations are generated with drizzle-kit and applied on `keith start` (and by `keith migrate`). Never edit an applied migration.
- WAL mode on, `foreign_keys = ON`, `busy_timeout = 5000`.
- Timestamps are integer milliseconds since epoch (UTC). IDs are prefixed ULIDs stored as text.
- JSON columns are validated with zod on read in the repository. A bad row is a bug, and the repository throws `STORAGE_CORRUPT`.

## Tables

| Table | Key columns | Phase |
|---|---|---|
| `persons` | id, name, username (unique, nullable), password_hash, tier, last_seen_at (nullable), created_at | 1 |
| `relationships` | person_id (PK), tone, notes, blocked_relay_from (json) | 1 |
| `auth_tokens` | token_hash (PK), person_id, node_id (nullable; filled on `hello`), expires_at, created_at | 1 |
| `nodes` | id, name, kind (`attended`/`headless`), capabilities (json), last_seen_at | 1 |
| `threads` | id, kind (`direct`/`group`), slug (e.g. `main`), title, owner_person_id, summary, created_at, updated_at. Unique (owner_person_id, slug) | 1 |
| `thread_participants` | thread_id, person_id, joined_at, left_at | 1 |
| `messages` | id, thread_id, role (`user`/`assistant`/`tool`), author_person_id, node_id, modality, content, tool_calls (json), tool_call_id, tool_name, is_error, ui (json), meta (json), created_at. See below | 1 |
| `tasks` | id, person_id, thread_id, agent_id, goal, status, attempt, summary, detail, ui (json), visibility, created_at, started_at, finished_at | 1 |
| `commitments` | id, thread_id, person_id, task_id, promise, status, created_at, resolved_at, expires_at | 1 |
| `deliveries` | id, thread_id, person_id, kind, author_person_id, source, urgency, content, ui (json), status, created_at, delivered_at | 1 |
| `memories` (+ `memories_fts`) | see [memory.md](memory.md) | 1 |
| `plugin_data` | plugin_id, key, value (json), updated_at. PK (plugin_id, key) | 1 |
| `files` | id, path, mime, size, owner_person_id, created_at | 2 |
| `reminders` | id, person_id, thread_id, due_at, text, status | 4 |
| `workspaces` | id, person_id or thread_id, state (json), updated_at | 6 |

Group-thread columns (`threads.kind`, `thread_participants`, `messages.author_person_id`) exist from phase 1 even though group threads ship in phase 5. This is deliberate, so phase 5 needs no data migration of history.

## Messages and tool calls

One row per message. Columns used depend on `role`:

| role | content | tool_calls | tool_call_id / tool_name / is_error | ui |
|---|---|---|---|---|
| `user` | the text (the transcript for audio) | null | null | null |
| `assistant` | the text | `LlmToolCall[]` when the step called tools, else null | null | `Array<{ block: UiBlock; toolCallId: string; toolName: string }>` or null |
| `tool` | the tool result `content` | null | the provider's call id, the tool name, and whether it errored | null |

- Tool call ids are the provider's `LlmToolCall.id`, persisted as-is (no `tcl_` prefix).
- `ui` entries remember which tool produced each block. `ui.action` frames carry `messageId` + `blockId`, so the core can find the tool's `onAction` handler (see [ui.md](ui.md#interactivity)).
- `tool` rows are internal. They are never sent to nodes, but they are replayed into `LlmMessage[]` for later turns.

## Memory search filter

`memories.search(text, filter)` and `memories.list(filter)` take a filter computed by `memory/visibility.ts` (`toStorageFilter(viewer)`), so the SQL and the pure `isVisible` function share one source of truth:

```ts
type MemoryFilter = {
  allowHousehold: boolean            // every viewer participant is owner or member
  allowOwner: boolean                // every viewer participant is owner
  subjectPersonId: PersonId | null   // set only when the viewer has exactly one participant
  threadIds: ThreadId[]              // threads that every viewer participant belongs to
}
// SQL: (visibility='household' AND :allowHousehold) OR (visibility='owner' AND :allowOwner)
//   OR (visibility='subject' AND subject_person_id = :subjectPersonId)
//   OR (visibility='thread' AND thread_id IN (:threadIds))
```

## Backups

The whole state is `~/.keith/`. `keith backup` (planned, phase 4) runs SQLite's online backup API plus a copy of `files/`.
