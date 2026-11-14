// The rooms' share of a removed person (ADR-0027 §26, docs/specs/corpus-callosum.md "Suspension and removal of a person").
// `keep` ends the person's memberships (through the room service, as a `remove` row with reason `removed`) and writes the
// memberships and the lines they spoke into the kept folder. `export` copies that dump (or writes the live rows for a person
// who is not removed). `purge` deletes the member rows after the keep time; the transcript stays with the room, as the
// room's members still read it. The suspension listener ends the same memberships with reason `suspended`.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sqlite } from '@keith/db'
import { type PersonRemovalHooks, removedFolderOf } from '../people/index.ts'
import type { RoomAcl } from './acl.ts'
import { type RoomService, SYSTEM_CALLER } from './service.ts'

/** The file of the kept folder (and of an export) that holds the person's memberships and lines. */
export const ROOMS_FILE = 'rooms.json'

export interface RoomsRemovalOptions {
  service: RoomService
  acl: RoomAcl
  sqlite: Sqlite
  dataDir: string
}

/** A raw `room_members` row, as the dump and the undo hold it. */
interface MemberRow {
  room_id: string
  person_id: string
  status: string
  invited_by: string | null
  invited_at: number
  joined_at: number | null
  left_at: number | null
  leave_reason: string | null
}

/** A raw `rooms` row of the rooms a person was in, kept so an undo can put back a room that keep ended. */
interface RoomRow {
  id: string
  state: string
  ended_at: number | null
  ended_by: string | null
  end_reason: string | null
}

/** The rooms module's share of a removed person: what the dump holds for a person (memberships and their own lines). */
function dumpOf(sqlite: Sqlite, personId: string) {
  return {
    memberships: sqlite
      .query<MemberRow, [string]>('SELECT * FROM room_members WHERE person_id = ? ORDER BY room_id')
      .all(personId),
    lines: sqlite
      .query(
        'SELECT seq, room_id, at, kind, speaker, text, data FROM room_events WHERE speaker = ? ORDER BY seq',
      )
      .all(personId),
  }
}

export function roomsRemoval(options: RoomsRemovalOptions): PersonRemovalHooks {
  const { service, acl, sqlite, dataDir } = options
  const write = (path: string, personId: string) =>
    writeFileSync(path, `${JSON.stringify({ personId, ...dumpOf(sqlite, personId) }, null, 2)}\n`, {
      mode: 0o600,
    })

  return {
    keep(personId, folder) {
      const memberships = sqlite
        .query<MemberRow, [string]>('SELECT * FROM room_members WHERE person_id = ?')
        .all(personId)
      const roomIds = [...new Set(memberships.map((m) => m.room_id))]
      const roomRows = roomIds.map(
        (id) =>
          sqlite
            .query<RoomRow, [string]>(
              'SELECT id, state, ended_at, ended_by, end_reason FROM rooms WHERE id = ?',
            )
            .get(id) as RoomRow,
      )
      const ended = service.endMemberships(personId, 'removed', SYSTEM_CALLER)
      const undo = (): void => {
        sqlite
          .transaction(() => {
            for (const row of memberships)
              sqlite
                .query(
                  `UPDATE room_members SET status = ?, invited_by = ?, invited_at = ?, joined_at = ?, left_at = ?, leave_reason = ?
                 WHERE room_id = ? AND person_id = ?`,
                )
                .run(
                  row.status,
                  row.invited_by,
                  row.invited_at,
                  row.joined_at,
                  row.left_at,
                  row.leave_reason,
                  row.room_id,
                  row.person_id,
                )
            for (const row of roomRows)
              sqlite
                .query(
                  'UPDATE rooms SET state = ?, ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ?',
                )
                .run(row.state, row.ended_at, row.ended_by, row.end_reason, row.id)
            // the write marker of an active membership comes back with the row (the room service writes it on accept)
            for (const row of memberships)
              if (row.status === 'active') acl.grant(row.room_id, row.person_id, 'system')
            for (const entry of ended) {
              if (entry.seq !== undefined)
                sqlite.query('DELETE FROM room_events WHERE seq = ?').run(entry.seq)
              if (entry.endSeq !== undefined)
                sqlite.query('DELETE FROM room_events WHERE seq = ?').run(entry.endSeq)
            }
          })
          .immediate()
      }
      try {
        write(join(folder, ROOMS_FILE), personId)
      } catch (error) {
        undo()
        throw error
      }
      return undo
    },

    export(personId, dest) {
      const folder = removedFolderOf(dataDir, personId)
      const target = join(dest, ROOMS_FILE)
      // a removed person: the kept dump is the record; a live person: the rows as they are now
      if (existsSync(join(folder, 'manifest.json'))) {
        if (existsSync(join(folder, ROOMS_FILE))) {
          mkdirSync(dest, { recursive: true })
          copyFileSync(join(folder, ROOMS_FILE), target)
        }
        return
      }
      const dump = dumpOf(sqlite, personId)
      if (dump.memberships.length === 0 && dump.lines.length === 0) return
      mkdirSync(dest, { recursive: true })
      write(target, personId)
    },

    purge(personId) {
      sqlite.query('DELETE FROM room_members WHERE person_id = ?').run(personId)
    },
  }
}

/**
 * The suspension listener (`identity.changed` with reason `suspend`): the person's memberships end at once, as `suspended`.
 * Wired by the composition (P30 step 2.5); it is one listener among the others, the people service is not edited.
 */
export function roomsOnIdentityChanged(
  service: RoomService,
): (change: { personId: string; reason: string }) => void {
  return ({ personId, reason }) => {
    if (reason !== 'suspend') return
    service.endMemberships(personId, 'suspended', SYSTEM_CALLER)
  }
}
