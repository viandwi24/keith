# 0021. Workspaces belong to someone, and the core never executes code

Status: Accepted (2026-11-10). Follows ADR-0020 (layers). Fixes flow-review finding F-002 (owner answer OWN-014). Plan: docs/plans/done/P21-flow-review-high-fixes.md.

## Context

`cortex.general` workers read and write files in `<dataDir>/workspace`, one folder for every person, while their prompt calls it "a private
folder". A member's worker could read what the owner's worker wrote (proved by `docs/flow-review/2026-11-09-full/proof-tests/F-002.proof.ts`).
The owner wants a real workspace: write research files, edit them, and hand a file to another tool (for example a mail connector of a plugin).

## Decision

1. **Every workspace has an owner**, rooted under `<dataDir>/workspace/`:
   - `people/<personId>/` for one person's workers (the default for any task a person asked for);
   - `rooms/<roomId>/` for a shared room (ADR-0026), created with the room and archived when it ends;
   - `keith/` for Keith's own work (protocols, self layer), owner only.
   A worker mounts only the folder of the principal it runs for; paths inside it are unchanged (`/notes.md`). No mount ever exposes a parent.
2. **Files move between tools by reference, not by content.** A tool that sends or publishes a file (mail, upload, a client view) takes a
   workspace path; the core resolves it against the caller's own workspace (or a room the caller is in) and refuses anything else. Content that
   leaves Keith is audited with the path, never the content.
3. **The core never runs code or shell commands for a worker.** Execution happens on a node (`motor_remote`, ADR-0023), including a sandbox node
   that is a disposable container. The core node keeps its current shell only for the owner's own approved commands; its cwd is confined like a
   node's (realpath inside the work dir) and it gets the same minimal env (closes F-032).
4. **Migration of old files:** the shared folder is moved, untouched, to `keith/legacy-shared/` (owner only) at the first start after the
   change; nothing is deleted. The worker prompt drops the word "private" until the per-owner mount is live, then says "your own folder".

## Consequences

- One person's research never shows up in another person's worker; rooms get an explicit place for shared files.
- A worker that needs a file from someone else must ask that person to share it (ACL on files can come later; for now: per-owner folders only).
- Disk use grows per person; a quota per folder is a later decision.
- Revisit when files need ACL entries like notes (then the workspace becomes an ACL container, ADR-0015 bits).
