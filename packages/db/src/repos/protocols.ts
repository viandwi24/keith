// The hypothalamus tables: protocols with their versions, runs with their steps, and proposals (docs/specs/hypothalamus.md,
// "Data model"). Policy (who may save what, when a run ends, what a tick does) is the engine's: these repos store rows and
// answer the questions the engine and the service ask. Definitions, approvals, visits and answers are JSON text, parsed
// by the contracts. Pruning of ended rows is in retention.ts. The agenda is in agenda.ts.
import { immediate, type Sqlite } from '../eh/sql.ts'

export type ProposalStatus = 'pending' | 'confirmed' | 'dismissed' | 'expired'
export type RunStatus =
  | 'running'
  | 'waiting'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'skipped'
  | 'expired'

export interface ProtocolRecord {
  id: string
  /** A person id, or `keith` for the self layer. */
  owner: string
  name: string
  builtIn: string | null
  enabled: boolean
  /** Epoch ms the pause ends, or null. */
  pausedUntil: number | null
  /** The current version; the compare-and-set key of `saveVersion`. */
  version: number
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface VersionRecord {
  protocolId: string
  version: number
  /** The definition as JSON text (`ProtocolDefinitionSchema`). */
  definition: string
  /** JSON list of the `act` pre-approvals of this version. */
  approvals: string
  savedBy: string
  savedAt: number
}

export interface NewProtocol {
  id: string
  owner: string
  name: string
  builtIn?: string | null
  enabled?: boolean
  definition: string
  approvals?: string
  savedBy: string
}

export type CreateProtocolResult =
  | { ok: true; protocol: ProtocolRecord }
  /** `name`: the owner has a protocol of that name; `built-in`: the owner already has that built-in. */
  | { ok: false; reason: 'name' | 'built-in' }

export type SaveVersionResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'not-found' }
  /** The current version is not the one the caller saw; `current` is the stored one. */
  | { ok: false; reason: 'conflict'; current: number }

export interface ProtocolsRepo {
  /** Creates a protocol at version 1 with its first version row, in one `BEGIN IMMEDIATE`. */
  create(input: NewProtocol, at: number): CreateProtocolResult
  get(id: string): ProtocolRecord | undefined
  /** The protocol of an owner with a built-in name (the seed of P28.4.2 is idempotent on this). */
  findBuiltIn(owner: string, builtIn: string): ProtocolRecord | undefined
  /** Protocols of one owner, or all of them when `owner` is absent; by owner, then name. */
  list(owner?: string): ProtocolRecord[]
  version(id: string, version: number): VersionRecord | undefined
  /** Every version of a protocol, oldest first (the audit of what ran). */
  versions(id: string): VersionRecord[]
  /**
   * Writes version `expectedVersion + 1` and moves the current version to it, only when the stored current version is
   * `expectedVersion`; one `BEGIN IMMEDIATE`. A stale caller gets `conflict` and nothing is written.
   */
  saveVersion(
    id: string,
    expectedVersion: number,
    input: { definition: string; approvals?: string; savedBy: string },
    at: number,
  ): SaveVersionResult
  /** False when no protocol has the id. */
  setEnabled(id: string, enabled: boolean, at: number): boolean
  /** Sets or clears (`null`) the pause end; false when no protocol has the id. */
  setPausedUntil(id: string, until: number | null, at: number): boolean
  /** Deletes the protocol and, by cascade, its versions. Its runs keep their history. False when no row. */
  remove(id: string): boolean
}

export interface ProtocolProposalRecord {
  id: string
  person: string
  /** The proposal definition as JSON text (`ProposalDefinitionSchema`). */
  definition: string
  reason: string
  /** JSON of the session and message ids the suggestion came from. */
  source: string
  status: ProposalStatus
  createdAt: number
  expiresAt: number
}

export interface NewProposal {
  id: string
  person: string
  definition: string
  reason: string
  source: string
  expiresAt: number
}

export interface ProtocolProposalsRepo {
  create(input: NewProposal, at: number): ProtocolProposalRecord
  get(id: string): ProtocolProposalRecord | undefined
  /** Proposals of a person, newest first; all statuses unless `status` is given. */
  list(person: string, status?: ProposalStatus): ProtocolProposalRecord[]
  /**
   * Moves a `pending` proposal to `to`; false when it is not pending (a second confirm or dismiss changes nothing).
   * Only `confirmed`, `dismissed` and `expired` are targets.
   */
  decide(id: string, to: Exclude<ProposalStatus, 'pending'>): boolean
  /** Marks the pending proposals whose expiry is at or before `now` as `expired`; returns how many. */
  expireDue(now: number): number
}

interface ProtocolRow {
  id: string
  owner: string
  name: string
  built_in: string | null
  enabled: number
  paused_until: number | null
  version: number
  created_by: string
  created_at: number
  updated_at: number
}

interface VersionRow {
  protocol_id: string
  version: number
  definition: string
  approvals: string
  saved_by: string
  saved_at: number
}

interface ProposalRow {
  id: string
  person: string
  definition: string
  reason: string
  source: string
  status: string
  created_at: number
  expires_at: number
}

const toProtocol = (r: ProtocolRow): ProtocolRecord => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  builtIn: r.built_in,
  enabled: r.enabled === 1,
  pausedUntil: r.paused_until,
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toVersion = (r: VersionRow): VersionRecord => ({
  protocolId: r.protocol_id,
  version: r.version,
  definition: r.definition,
  approvals: r.approvals,
  savedBy: r.saved_by,
  savedAt: r.saved_at,
})

const toProposal = (r: ProposalRow): ProtocolProposalRecord => ({
  id: r.id,
  person: r.person,
  definition: r.definition,
  reason: r.reason,
  status: r.status as ProposalStatus,
  source: r.source,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
})

export function protocolsRepo(sqlite: Sqlite): ProtocolsRepo {
  const row = (id: string) =>
    sqlite.query<ProtocolRow, [string]>('SELECT * FROM protocols WHERE id = ?').get(id)
  return {
    create(input, at) {
      return immediate(sqlite, () => {
        const taken = sqlite
          .query<{ n: number }, [string, string]>(
            'SELECT COUNT(*) AS n FROM protocols WHERE owner = ? AND name = ?',
          )
          .get(input.owner, input.name)
        if ((taken?.n ?? 0) > 0) return { ok: false, reason: 'name' }
        if (input.builtIn) {
          const builtIn = sqlite
            .query<{ n: number }, [string, string]>(
              'SELECT COUNT(*) AS n FROM protocols WHERE owner = ? AND built_in = ?',
            )
            .get(input.owner, input.builtIn)
          if ((builtIn?.n ?? 0) > 0) return { ok: false, reason: 'built-in' }
        }
        sqlite
          .query(
            `INSERT INTO protocols (id, owner, name, built_in, enabled, paused_until, version, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.owner,
            input.name,
            input.builtIn ?? null,
            input.enabled === false ? 0 : 1,
            input.savedBy,
            at,
            at,
          )
        sqlite
          .query(
            `INSERT INTO protocol_versions (protocol_id, version, definition, approvals, saved_by, saved_at)
             VALUES (?, 1, ?, ?, ?, ?)`,
          )
          .run(input.id, input.definition, input.approvals ?? '[]', input.savedBy, at)
        const created = row(input.id)
        if (created === null) throw new Error(`protocols: row ${input.id} vanished after insert`)
        return { ok: true, protocol: toProtocol(created) }
      })
    },
    get(id) {
      const r = row(id)
      return r === null ? undefined : toProtocol(r)
    },
    findBuiltIn(owner, builtIn) {
      const r = sqlite
        .query<ProtocolRow, [string, string]>(
          'SELECT * FROM protocols WHERE owner = ? AND built_in = ?',
        )
        .get(owner, builtIn)
      return r === null ? undefined : toProtocol(r)
    },
    list(owner) {
      const rows =
        owner === undefined
          ? sqlite.query<ProtocolRow, []>('SELECT * FROM protocols ORDER BY owner, name').all()
          : sqlite
              .query<ProtocolRow, [string]>('SELECT * FROM protocols WHERE owner = ? ORDER BY name')
              .all(owner)
      return rows.map(toProtocol)
    },
    version(id, version) {
      const r = sqlite
        .query<VersionRow, [string, number]>(
          'SELECT * FROM protocol_versions WHERE protocol_id = ? AND version = ?',
        )
        .get(id, version)
      return r === null ? undefined : toVersion(r)
    },
    versions(id) {
      return sqlite
        .query<VersionRow, [string]>(
          'SELECT * FROM protocol_versions WHERE protocol_id = ? ORDER BY version',
        )
        .all(id)
        .map(toVersion)
    },
    saveVersion(id, expectedVersion, input, at) {
      return immediate(sqlite, (): SaveVersionResult => {
        const current = row(id)
        if (current === null) return { ok: false, reason: 'not-found' }
        if (current.version !== expectedVersion) {
          return { ok: false, reason: 'conflict', current: current.version }
        }
        const next = expectedVersion + 1
        sqlite
          .query('UPDATE protocols SET version = ?, updated_at = ? WHERE id = ? AND version = ?')
          .run(next, at, id, expectedVersion)
        sqlite
          .query(
            `INSERT INTO protocol_versions (protocol_id, version, definition, approvals, saved_by, saved_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, next, input.definition, input.approvals ?? '[]', input.savedBy, at)
        return { ok: true, version: next }
      })
    },
    setEnabled(id, enabled, at) {
      return (
        sqlite
          .query('UPDATE protocols SET enabled = ?, updated_at = ? WHERE id = ?')
          .run(enabled ? 1 : 0, at, id).changes > 0
      )
    },
    setPausedUntil(id, until, at) {
      return (
        sqlite
          .query('UPDATE protocols SET paused_until = ?, updated_at = ? WHERE id = ?')
          .run(until, at, id).changes > 0
      )
    },
    remove(id) {
      return sqlite.query('DELETE FROM protocols WHERE id = ?').run(id).changes > 0
    },
  }
}

export function protocolProposalsRepo(sqlite: Sqlite): ProtocolProposalsRepo {
  const row = (id: string) =>
    sqlite.query<ProposalRow, [string]>('SELECT * FROM protocol_proposals WHERE id = ?').get(id)
  return {
    create(input, at) {
      sqlite
        .query(
          `INSERT INTO protocol_proposals (id, person, definition, reason, source, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          input.id,
          input.person,
          input.definition,
          input.reason,
          input.source,
          at,
          input.expiresAt,
        )
      const created = row(input.id)
      if (created === null) throw new Error(`protocol_proposals: row ${input.id} vanished`)
      return toProposal(created)
    },
    get(id) {
      const r = row(id)
      return r === null ? undefined : toProposal(r)
    },
    list(person, status) {
      const rows =
        status === undefined
          ? sqlite
              .query<ProposalRow, [string]>(
                'SELECT * FROM protocol_proposals WHERE person = ? ORDER BY created_at DESC, id',
              )
              .all(person)
          : sqlite
              .query<ProposalRow, [string, string]>(
                'SELECT * FROM protocol_proposals WHERE person = ? AND status = ? ORDER BY created_at DESC, id',
              )
              .all(person, status)
      return rows.map(toProposal)
    },
    decide(id, to) {
      return (
        sqlite
          .query(`UPDATE protocol_proposals SET status = ? WHERE id = ? AND status = 'pending'`)
          .run(to, id).changes > 0
      )
    },
    expireDue(now) {
      return sqlite
        .query(
          `UPDATE protocol_proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
        )
        .run(now).changes
    },
  }
}
