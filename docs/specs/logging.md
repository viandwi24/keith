# Logging

Module: `apps/core/src/platform/logger.ts`. The only code in `apps/*/src` that touches `console`.

## Interface

`Logger` has `debug`, `info`, `warn`, `error`, each `(message: string, fields?: Record<string, unknown>)`.
`createLogger(options)` returns a `FileLogger` (a `Logger` plus `flush()`, which resolves when every
queued line is on disk). `createLogger('info')` (level only) still works: console only.
`silentLogger` drops everything (tests).

Options: `level` (`KEITH_LOG_LEVEL`, default `info`), `dir`, `now` (clock for tests), `retainDays`
(default 14), `console` (default true). Events below `level` go nowhere.

## File

- Location: `<KEITH_DATA_DIR>/logs/keith-YYYY-MM-DD.log` (local date), created on demand.
- One JSON object per line: `{ "at": ISO-8601, "level", "msg", ...fields }`. Reserved keys `at`,
  `level`, `msg` win over fields with the same name.
- Rotation: the file name follows the date of each event, so a new day starts a new file.
- Retention: when the first event of a day is logged (so at startup and once a day) files named
  `keith-YYYY-MM-DD.log` whose date is more than `retainDays` days before today are deleted. Other
  files in the folder are never touched.
- Writes are queued and appended off the caller's path. A log call never blocks and never throws.
  If the folder cannot be written, one `error log file not writable` line goes to the console per
  failure streak. The lines of the failed batch are dropped (they are not queued again); events logged later try the folder again.

## Console

`level message` plus the redacted fields as JSON when present; message and fields are redacted
exactly like the file. The one exception is `logger.secretOnce(message)`: console only, raw, never
written to a file, kept for a secret the console must show once; no command uses it now (`keith-core token create` and `recover` print the token on stdout, never through the logger).

## Redaction

Nothing secret is written to a file. In fields (deeply, max depth 6), a value whose key matches
`/token|secret|key|authorization|password|passphrase|cookie/i` becomes `[redacted]`, and so does a
value whose whole key is `pin`, `session` or `code` (case-insensitive). A `code` value that is an
error code (`W_*`, `EH_*`, `E_*`, `GUEST_*`, e.g. `W_HOOK_FAILED`, `GUEST_AUDIT`) stays, since it
is what a log line is for; any other `code` (a login code) is masked. Ids such as `sessionId` and
`guestSession` are not secrets and stay. In every string (message and
field values), `Bearer <x>` becomes `Bearer [redacted]` and `keith_<x>`, provider keys (`sk-or-v1-…`, `sk-` followed by 20+ characters) and JWT-like
`eyJ….….…` strings become `[redacted]`.
Errors are reduced to their message; cycles become `[circular]`.

## eharness

`toHarnessLogger(logger)` adapts the eharness `HarnessLogger`. Its `data` argument becomes fields.
An eharness warning (a `W_*` code in the message or in `data.code`) is always logged at `warn`,
with `code` plus its `details` as fields.

## The guest path

A guest session's agent gets its own logger (`createGuestLogger`, `modules/guests/guest-logger.ts`): it writes `guest agent` with `{ code, guestSession, ipHash }` and nothing else. Tested in `modules/guests/guest-logger.test.ts` (REQ-187: no text, address or user agent reaches the file).
Retention is tested in `platform/logger.test.ts` (14 days, other files kept). Every log call of `apps/*/src` goes
through this logger, so its redaction applies to all of them: `platform/logger.test.ts` fails on a `console.*` call or a
`.log` append outside this module. `debug` and `info` are dropped; the message text and every other field of eharness' own lines are dropped too (a hook, tool or provider error can quote what a visitor wrote); a line with no recognisable code (`W_*`, `E_*`, `EH_*`, `GUEST_*`) is `GUEST_AGENT_EVENT`. The registry's own lines carry a code only (`GUEST_CLOSE_FAILED`). No guest text, address or user agent reaches the file (`guests.md`).

## Shutdown and crash (FD11-06)

- A crash: `installCrashHandlers(logger)` (`run-core.ts`, called by `main.ts` and `keith-core start`) handles
  `uncaughtException` and `unhandledRejection`: it logs `uncaught exception: <message>` or `unhandled rejection: <message>` at
  `error` (with the stack, redacted), flushes for at most 2 s, then exits 1. A second crash while that runs only exits 1.
  Test: `run-core.test.ts` (a child process whose timer rejects or throws: the line is on disk, exit 1).
- A stop: `signalStop` (`run-core.ts`) runs `running.stop()` once. A failed stop is logged (`stop failed: <message>`), the
  lock is released in a `finally` of `stop`, and the exit code is 1. A stop still running after 10 s is forced out with exit 1.
  A second SIGINT or SIGTERM while stopping never runs stop again: it flushes and exits 1 at once. Every exit path flushes
  with a 2 s cap (`logger.flush(timeoutMs)`), so a line that is queued at exit is on disk or the flush gave up.

## Dead letters

`compose.ts` passes `inbox.onDeadLetter` to the front agent and every worker. A dead item is logged
at `error` as `inbox item dead-lettered` with `sessionId`, `kind`, `attempts`, `reason` and
`lastError`, then an `eh.notice` (level `error`, "A message failed repeatedly and was
stopped; see the log.") is injected into the front session of the person the dead item belongs to
(`front:<personId>`, derived from the session id; a worker's item goes to the person who asked). Only an item with no derivable
person (an empty session id) goes to the current owner as the same generic notice. A person who is not `active`
(suspended, gone) is only logged. A failure to inject the notice is a `warn` and never throws. A dead letter of a guest session (`guest:*`, `isGuestSession` in `platform/sessions.ts`) is only logged: nothing is injected, not even the owner's generic notice (ADR-0027 §20, F-049).

## Audit versus the log

Security events (device codes, credentials, settings changes, node pairing, approvals answered) go to
the `audit_events` table, not the log file (`auth.md`, Audit). The log only gets operational lines, such as
`audit: could not record <kind>` when a write fails. Neither holds secrets.
