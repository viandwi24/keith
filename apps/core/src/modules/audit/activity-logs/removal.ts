// A removed person's activity logs (ADR-0032 §7, docs/specs/activity-logs.md "Removal", ADR-0027 §26). `keep` moves
// nothing: the rows stay and expire by their periods (`platform/retention.ts`). `export` writes the person's rows, with
// the bodies decoded, as `activity-logs.json` into the archive. `purge` (at the kept folder's purge time) deletes the
// person's sessions, calls and bodies, then audits `data.pruned` with counts only.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activityLogsRepo, type Sqlite } from '@keith/db'
import type { PersonRemovalHooks } from '../../people/index.ts'
import type { Audit } from '../audit.ts'
import { unpack } from './pack.ts'

export const ACTIVITY_LOGS_FILE = 'activity-logs.json'

export interface ActivityLogsRemovalOptions {
  sqlite: Sqlite
  audit: Pick<Audit, 'record'>
}

/** A stored body as the export holds it: the decoded JSON, or null when that part was not kept. */
const decodeBody = (bytes: Uint8Array | null): unknown =>
  bytes === null ? null : unpack(bytes as Uint8Array<ArrayBuffer>)

export function activityLogsRemoval(options: ActivityLogsRemovalOptions): PersonRemovalHooks {
  const repo = activityLogsRepo(options.sqlite)
  return {
    keep() {
      return undefined
    },
    export(personId, dest) {
      const data = repo.exportPerson(personId)
      if (data.sessions.length === 0 && data.calls.length === 0) return
      const bodies = data.bodies.map((body) => ({
        callId: body.callId,
        request: decodeBody(body.request),
        response: decodeBody(body.response),
        output: decodeBody(body.output),
      }))
      writeFileSync(
        join(dest, ACTIVITY_LOGS_FILE),
        `${JSON.stringify({ personId, sessions: data.sessions, calls: data.calls, bodies }, null, 2)}\n`,
        { mode: 0o600 },
      )
    },
    purge(personId) {
      const removed = repo.purgePerson(personId)
      const tables = [
        { table: 'llm_bodies', count: removed.bodies },
        { table: 'llm_calls', count: removed.calls },
        { table: 'llm_sessions', count: removed.sessions },
      ]
      for (const { table, count } of tables) {
        if (count > 0)
          options.audit.record({
            kind: 'data.pruned',
            actor: 'system',
            via: 'local',
            detail: { table, count },
          })
      }
    },
  }
}
