# Notes (plugin)

Code: `plugins/notes` (`plugin.ts`, `operations/{write,read,share}.ts`, `store.ts`, `schema.ts`, generated `migrations/`). Tests: `plugins/notes/notes.test.ts` (host kit), `apps/core/src/plugins-notes.e2e.test.ts` (booted core).
ADR: `docs/decisions/0016-keith-plugin-layer.md`. Plan: `docs/plans/done/P16-keith-plugin-layer.md`. Contracts it relies on: `../plugins.md` (operations, guard, `k`), `../acl.md` (who may read), `../db.md` (plugin storage).

## Purpose

A person's notes, private by default and shareable per the ACL (P15): named people, groups, every active person (`@users`), the public (`@public`, guests included), and deny entries. The model gets the tools; the same operations are HTTP routes with OpenAPI.
Notes uses no privileged path: it is a plugin like any other (`defineKeithPlugin`).

## Data

- `plg_notes_items` (`id` UUID, `author_id`, `title`, `body`, `created_at`, `updated_at`; index on `updated_at`): the content. `author_id` only records who wrote the note first; **access is never read from it**.
- `plg_notes_fts`: an FTS5 table `(id UNINDEXED, title, body)` (tokenizer `unicode61 remove_diacritics 2`) kept in step by the operations (no triggers: the host refuses them in plugin migrations). Created by the second migration, a **custom** drizzle-kit migration
  (`bun run plugin:db:generate notes --name search_index --custom`; a virtual table is not something Drizzle can describe). The host's migration check accepts exactly `CREATE VIRTUAL TABLE plg_<id>_... USING fts5` (`db.md`).
- The access data is the ACL resource `('note', id)`: owner = creator, no team, mode **0600** (the default of a `leaf`; the kind registers no wider one), no entries. Kind `note`, class `leaf`: `r` read, `w` edit.
- Limits: title 200 characters, text 20 000, 2 000 notes per author.

## Operations

The model sees `notes_<operation>` (the first underscore splits the plugin id from the name). Capability `notes.use` (declared by the plugin; held by the `member` role by default, the owner role always); the owner can withdraw it from one person by a grant revoke or turn the plugin off (`plugins.notes.enabled`, default **on**).

| Operation (tool) | What | Rule |
| --- | --- | --- |
| `create` (`notes_create`) | `{ title, body }` -> `{ id }` | 30 a minute; the ACL resource and the content are written in one `k.transaction` (a failed insert leaves no resource) |
| `get` (`notes_get`) | one note: `title`, `body`, `by` (author's name, `you` for the caller), `mine`, `canEdit`, times | guard checks `r`; a denied and a missing note are the same `NOT_FOUND` |
| `list` (`notes_list`) | `{ limit<=50, offset }` -> titles, `total`, `hasMore`, newest first | the ids come from `acl.visibleIds` and filter **inside** the SQL, before the count, the order and the limit |
| `search` (`notes_search`) | `{ query, limit<=25 }` -> titles and a short excerpt, best first | FTS5 `MATCH` joined to the visible ids in one query: ranking, limit and the excerpt see only readable notes. The score is used for the order and **never returned**. The query is split into words and each is quoted (no FTS operators, no syntax error); all words are required |
| `update` (`notes_update`) | `{ id, title?, body? }` | guard checks `r`, `run` checks `w`: a reader gets `FORBIDDEN` "you can read this note but not change it", a stranger the standard `NOT_FOUND` |
| `append` (`notes_append`) | `{ id, text }` adds a line | as `update` |
| `delete` (`notes_delete`) | `{ id }` | **only the ACL owner** (`FORBIDDEN` for an editor); `dangerous`: the model asks the person first. Removes content, index entry and ACL resource in one `k.transaction` (a failed delete leaves both, ADR-0027 §19) |
| `share` (`notes_share`) | `{ id, target, access: read | edit, deny? }` -> the shares | `dangerous` (asks first). Goes through `k.access` = the core's access service: only the note's owner (and the instance owner), a user target must be an active person, a group must exist, one transaction, audit `acl.share`. `target` is `user:<name or id>`, `group:<name or id>`, `@users` or `@public`. `edit` grants `rw`; `deny` writes a deny entry that shuts every bit |
| `unshare` (`notes_unshare`) | `{ id, target, deny? }` | same rules; audit `acl.unshare` |
| `shares` (`notes_shares`) | who a note is shared with: mode text and entries (`who`, `access`, `effect`) | only the owner (or the instance owner) can look |
| `public_get`, `public_list` | a note that is public / the public notes | **`audience: 'public'`: the only operations a guest reaches**, offered to the model of a **guest** session only (`expose: { ai: false, guest: true }`; a person's agent has `get`, `list`, `search`). For a guest `by` reads `the author` (no person's name). They answer only what a **guest** could read: the check runs as a guest actor whoever calls, so a signed-in person gets no private note through them |

There is no `chmod`: `@public` and `@users` entries cover it, and the mode stays 0600. Widening to `@users` or `@public` needs a **confirmed** call (a step-up over HTTP; `k.session.elevated`): a chat turn is never elevated, and a tool approval never counts as confirmation, so the model cannot widen on its own: a model-driven widening ends in `STEP_UP`, which the operations port maps to `FORBIDDEN` (`acl.md`, "Widening needs a confirmation"). The tool description tells the model to have the owner make the change at the TUI or with `keith-core acl share`.
Narrowing, named people and groups never need it.

## Who sees what (proved by `notes.test.ts`)

| Goal | Case | Test |
| --- | --- | --- |
| 1 private | owner only | `case 1 private` and "a note is private by default" |
| 2 public read | everyone incl. guests | `case 2 public read` (guest through `public_get` and `public_list`) |
| 3 every active person, no guests | `allow @users r` | `case 3` (the guest gets `NOT_FOUND` on `public_get`) |
| 4 groups A and B, not C | `allow group:A`, `allow group:B`; with a broad share + `deny group:C` | `case 4` and `4b`; removing a member from the group removes the access at once |
| 5 Duta and Amel | two user entries | `case 5` |
| 6 Duta only | one user entry | `case 6` |

Each case runs for the eight actors of the ACL kit (owner, groups A/B/C, Duta, Amel, outsider, guest) and the instance owner, over `get`, `list`, `search` (and the count in `list`): exactly the readers see the note, everyone else sees an empty list, no excerpt and `NOT_FOUND`.
The P15 **leak kit** (`leakCheck`, re-exported by `@keith/host/testing`) runs for the owner, an outsider, a member of an unrelated group and a guest over list, search, count, get, update and delete: no answer, count or error text differs from the baseline or from a missing id.
"Filter before limit" is its own test: 40 better-ranked private notes of another person never push an outsider's own match out of a `limit: 5` search.

## The terminal view (P18)

`tui/notes-view.tsx`, menu entry `Notes` (`notes.browse`, capability `notes.use`). A full Ink view the core runs for the viewer (`plugin-views.md`); it reads and changes data only through `useKeith().call` as the **viewer**, so the guard, the ACL, the rate limit and the audit apply to every call and a view shows exactly what `notes.list`, `notes.search` and `notes.get` return to that person.

- **Browse**: the notes the viewer may read, newest first (title, author or `you`, updated in UTC), the first 50 and more as the cursor reaches the end. `/` focuses the search box, `enter` runs `notes.search` (an empty box is the list again), `↓` leaves the box, `r` refreshes. `enter` or `→` reads, `s` shares a note of the viewer's own (the key is offered only on their own notes).
- **Read**: `notes.get`, the body wrapped to the width, `↑↓`, page keys and space scroll; a note shared read-only says `read only`. `b`, `←` or backspace go back (`esc` and `ctrl+g` belong to the host and leave the view).
- **Share panel** (own notes): `notes.shares` lists who has it and the mode; `a` adds a person or group (`user:<name>` or `group:<name>`, add `edit` to let them edit) through `notes.share`; `x` removes the selected entry through `notes.unshare`. **There is no one-key "make it public"**: widening to `@users` or `@public` needs a confirmation (a step-up) a view cannot give, so the core refuses it and the panel shows the refusal. That step stays in the chat's confirmation, `keith-core acl` or the Manage screen.
- **Proof** (`tui/notes-view.test.tsx`): the flows above over a real view host on a memory host; a note shared with someone reads as read only there; the **P15 leak kit run through the view**: an outsider, a group member and a guest (never offered the view) learn nothing of a private note from the list, the count or a search (the secrets are in no frame, and the counts match the baseline). Keys are read through a ref so fast typing or a paste never takes a letter for a command.

## The instance owner

The owner role reads any note (root read, never write: `update` on another person's note is `FORBIDDEN`, `delete` too). Every such read through `get`, `list` or `search` calls `k.audit.ownerAccess('note', ids)`; the host keeps only the ids where root access made the difference and writes `acl.owner-access`
(one row per window and resource owner, never content). The member-facing docs say the owner can do this and that it is audited.

## Not done

Notebooks (a container kind), attachments, tags, editing a note from the view (the operations exist; the view reads and shares), moving the memory store here. Notes does not feed the hippocampus.
