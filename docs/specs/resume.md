# Resume

Code: `apps/core/src/modules/resume/`, `compose.ts`, adapter `packages/db/src/eh/stream-log.ts`
(`db.md`). Tests: `apps/core/src/resume.e2e.test.ts`.

## Purpose

A client that lost its connection, or a core that restarted, picks the answer up again: the chunks
of a running turn are readable from another process, and a turn a dead process left half done is
marked interrupted with a notice instead of looking "running" forever.

## Parts

- Stream log: `storage.streams = sqliteStreamLog(sqlite, { retentionMs })` shared by every agent,
  plus `streams: { retentionMs: STREAM_RETENTION_MS }` (10 minutes) on each agent. With it,
  `GET /sessions/:id/chat/stream` replays and follows a turn that runs in another process; the
  turn's owner keeps writing, readers poll (SQLite has no cross-process notification). Once the turn
  ended and the retention passed, or when nothing runs, the route answers 204 and the client reads
  the stored messages.
- Instance id: `instanceIdOf(dataDir)` returns the random `core-<uuid>` kept in
  `<dataDir>/instance-id`. It is `recovery.instanceId` of every agent and the owner of the SQLite
  lock (eharness passes it to `acquire` as `owner`, so the lock needs no flag). A restarted core with the same id treats
  the turn it owned but does not run as stale at once and takes over its lock lease, instead of
  waiting `recovery.staleMs` (120 s) and the lease (30 s). Two live cores on one database need
  different ids: `CoreOptions.instanceId` overrides the file (tests).
- Boot: `createSessionCare(...).recoverAll(agent)` (`compose-sessions.ts`) calls
  `recoverSession(agent, front:<id>, lock, logger)` for the front session of every person who exists
  (status `active` or `suspended`, not `left`; the list comes from the people store, the owner
  after a transfer included), before the reconcile of workers. Each call runs `session.recover()`. It marks the unfinished assistant message `interrupted`, answers dangling
  tool calls with the interrupted error (tools are never re-run), saves the `eh.notice`
  `EH_TURN_INTERRUPTED` and clears the active turn. It never throws: a failure is logged and boot
  goes on. Worker sessions are repaired by the reconcile (`cortex.md`).
- Graceful stop: `main.ts` logs `keith core stopping (<signal>)` and `stopped` around
  `server.stop()` + `core.close()`. `close()` counts the active turns of every person's front
  session (`peek(id).stats().activeTurn`, for the log) and calls `agent.close({ inFlight:
  'interrupt' })` (eharness 0.10): each running turn ends exactly as `session.recover()` repairs a
  crash (reply `stop: 'interrupted'`, dangling tool calls answered, `EH_TURN_INTERRUPTED` notice,
  active turn cleared). After the next boot the chat looks like a recovered crash and `/continue`
  works. Test: `graceful-stop.e2e.test.ts`. Worker sessions are repaired by the reconcile
  (`cortex.md`). Room sessions follow the same two paths: `recoverRooms` and `closeRoomAgent` (`compose-sessions.ts`, corpus-callosum.md "Recovery").

## Invariants

- A tool call that was running when the process died is never executed again automatically.
- A live turn of another process is never recovered: it needs a stale heartbeat or its own
  instance id restarting.
- Recovery and graceful stop enumerate people, never `front:owner`: a member's half-done turn is
  repaired and marked exactly like the owner's (`peopleFor('recover', …)` in `platform/sessions.ts`:
  active and suspended people). Test: `isolation.e2e.test.ts`, `compose-sessions.test.ts`,
  `platform/sessions.test.ts`.
