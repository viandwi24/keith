# ADR-0018: What deleting a person removes

- **Status:** accepted
- **Date:** 2026-09-28
- **Rules/invariants affected:** I-2, I-4, R-4, R-14

## Context

memory.md says "deleting a Person deletes their `subject` memories and their direct threads", marked Planned for phase 5. A person's data reaches much further than that. Their messages sit in group threads. They authored memories about other people. Relays they sent are pending or delivered in other people's threads. They created group threads and uploaded files. Other people's block lists name them. Most of these rows have foreign keys to `persons` with no `on delete` action, so a plain `DELETE` fails, and `messages.author_person_id = null` already means "the Mind" (I-2), so setting it to null would put the person's words in Keith's mouth. P5-S1 implements the deletion as one storage transaction, and P5-A1 builds the command around it. Both start at the same time, so the rule must be fixed before them.

## Decision

- **Command.** `keith person remove <name>` asks for confirmation (or takes `--yes`) and holds the home lock, so Keith must be stopped. The owner can't be removed. The command suggests running `keith backup` first and prints what it removed.
- **One transaction** (`PersonsRepository.remove`, storage only, R-4) deletes:
  - the person, their relationship, auth tokens, invite links, group invitations to or from them, and reminders;
  - their direct threads (`kind = 'direct'`, owned by them), with everything in them: messages, deliveries, commitments, tasks, reminders and `thread` memories;
  - every memory whose subject is them, whatever its visibility;
  - their tasks and commitments elsewhere, the deliveries addressed to them, and relays they sent that are still pending;
  - their participant rows in group threads (they leave every group), and **their own messages in group threads**. Their words leave with them. The Mind's replies stay.
- **Kept, with the reference cleared:**
  - memories they authored about someone else or about nobody keep their content, visibility and source, and `author_person_id` becomes null;
  - delivered relays they sent keep their content, and `author_person_id` becomes null (the recipient's thread history still shows the delivery message, whose `meta.relayFrom` keeps the name the recipient saw);
  - group threads they created stay, and `owner_person_id` becomes null;
  - other people's `blocked_relay_from` lists drop their id.
- **Files** they uploaded: the rows are deleted in the transaction, and the command deletes the stored bytes after the commit. A reference to such a file elsewhere answers `404`.
- `remove` returns counts of what it deleted and the file paths to delete, so the command can print them and remove the files.
- There is no undo. A backup is the only way back.

## Consequences

- memory.md's Planned note is replaced by this list (P5-K1 writes it, P5-S1 removes the marker).
- A group conversation can have gaps where the deleted person spoke. The Mind's replies may refer to words that are gone. We accept this: the person's words are theirs to take.
- Deleting a person never fails on a foreign key. P5-S1's tests cover every table in the list above.
- The command needs a stopped Keith, because the running core caches thread participants. A live removal would need a new event and cache invalidation in every folder, which is not worth it for a rare admin action.
