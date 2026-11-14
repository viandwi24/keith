import { uuidv7 } from 'eharness'
import { immediate, type Sqlite } from '../eh/sql.ts'
import { type CodeProblem, codeProblem, spendCode } from './pairing.ts'

export type NodeStatus = 'online' | 'offline' | 'revoked'

/** A peripheral node. The token hash never leaves the repo. */
export interface NodeRecord {
  id: string
  name: string
  os: string
  arch: string
  version: string
  manifest: unknown
  allowShell: boolean
  status: NodeStatus
  lastSeenAt: number | null
  createdAt: number
  /** When the current token was issued (join or last rotation). */
  tokenIssuedAt: number
  revokedAt: number | null
}

export interface NodeInput {
  name: string
  os: string
  arch: string
  version: string
  manifest: unknown
  allowShell: boolean
  tokenHash: string
}

export type JoinResult =
  | { ok: true; node: NodeRecord }
  | { ok: false; reason: CodeProblem | 'name-taken' }

export type NodeManifestUpdate = Partial<Pick<NodeInput, 'os' | 'arch' | 'version' | 'manifest'>> &
  Partial<Pick<NodeInput, 'allowShell'>>

export interface NodesRepo {
  /** Throws when a non-revoked node already has the name. Starts offline, never seen. */
  create(input: NodeInput): NodeRecord
  get(id: string): NodeRecord | undefined
  /** The non-revoked node whose current or pending (rotation) token has this hash. */
  findByTokenHash(hash: string): NodeRecord | undefined
  /** Oldest first; revoked rows only with `includeRevoked`. */
  list(query?: { includeRevoked?: boolean }): NodeRecord[]
  /** Replace the declared fields (os, arch, version, manifest, allowShell). Undefined for unknown or revoked ids. */
  updateManifest(id: string, fields: NodeManifestUpdate): NodeRecord | undefined
  /** Set online or offline (not revoked: use `revoke`); `lastSeenAt` optional. Undefined for unknown or revoked ids. */
  setStatus(
    id: string,
    status: Exclude<NodeStatus, 'revoked'>,
    lastSeenAt?: number,
  ): NodeRecord | undefined
  /** `last_seen_at` = now. Undefined for unknown or revoked ids. */
  touch(id: string): NodeRecord | undefined
  /** Status revoked, `revoked_at` = now, token hashes (current and pending) scrambled so they never match again. */
  revoke(id: string): NodeRecord | undefined
  /** Start a rotation: `nextHash` is the hash of the new token; the current token keeps working. Undefined for unknown or revoked ids. */
  beginTokenRotation(id: string, nextHash: string): NodeRecord | undefined
  /** Complete a rotation whose new token (hash `hash`) is in use: it becomes the current token and `token_issued_at` = now. Undefined when `hash` is not the pending one, so a repeat is a no-op. */
  commitTokenRotation(id: string, hash: string): NodeRecord | undefined
  /**
   * `POST /nodes/join` as one transaction (ADR-0027 §13): the code is checked first (unknown, used,
   * expired), then the name (`reserved` names count as taken), then the node is created and the code
   * is spent with `used_by_node` = the new node. A refusal spends nothing.
   */
  joinWithCode(input: { codeHash: string; reserved: boolean; node: NodeInput }): JoinResult
}

interface NodeRow {
  id: string
  name: string
  os: string
  arch: string
  version: string
  manifest: string
  allow_shell: number
  status: NodeStatus
  last_seen_at: number | null
  created_at: number
  token_issued_at: number | null
  revoked_at: number | null
}

const COLUMNS =
  'id, name, os, arch, version, manifest, allow_shell, status, last_seen_at, created_at, token_issued_at, revoked_at'

const toRecord = (row: NodeRow): NodeRecord => ({
  id: row.id,
  name: row.name,
  os: row.os,
  arch: row.arch,
  version: row.version,
  manifest: JSON.parse(row.manifest),
  allowShell: row.allow_shell === 1,
  status: row.status,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  // rows older than migration 0013 have no issue time: their token dates from creation
  tokenIssuedAt: row.token_issued_at ?? row.created_at,
  revokedAt: row.revoked_at,
})

export function nodesRepo(sqlite: Sqlite, options: { now?: () => number } = {}): NodesRepo {
  const now = options.now ?? Date.now

  const get = (id: string): NodeRecord | undefined => {
    const row = sqlite.query<NodeRow, [string]>(`SELECT ${COLUMNS} FROM nodes WHERE id = ?`).get(id)
    return row === null ? undefined : toRecord(row)
  }

  /** Apply an UPDATE to a live node; undefined when it is unknown or revoked. */
  const updateLive = (id: string, set: string, params: (string | number | null)[]) => {
    const result = sqlite
      .query(`UPDATE nodes SET ${set} WHERE id = ? AND status != 'revoked'`)
      .run(...params, id)
    return result.changes === 0 ? undefined : get(id)
  }

  /** A non-revoked node has this name. */
  const nameTaken = (name: string): boolean =>
    sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM nodes WHERE name = ? AND status != 'revoked'",
      )
      .get(name) !== null

  const insert = (input: NodeInput, id: string, at: number): void => {
    sqlite
      .query(
        `INSERT INTO nodes (id, name, os, arch, version, manifest, allow_shell, token_hash, status, created_at, token_issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.os,
        input.arch,
        input.version,
        JSON.stringify(input.manifest),
        input.allowShell ? 1 : 0,
        input.tokenHash,
        at,
        at,
      )
  }

  return {
    create(input) {
      return immediate(sqlite, () => {
        if (nameTaken(input.name)) throw new Error(`node name already in use: ${input.name}`)
        const id = uuidv7()
        insert(input, id, now())
        return get(id) as NodeRecord
      })
    },
    joinWithCode(input) {
      return immediate(sqlite, () => {
        const at = now()
        const problem = codeProblem(sqlite, input.codeHash, at)
        if (problem !== undefined) return { ok: false, reason: problem }
        if (input.reserved || nameTaken(input.node.name)) return { ok: false, reason: 'name-taken' }
        const id = uuidv7()
        insert(input.node, id, at)
        spendCode(sqlite, input.codeHash, at, id)
        return { ok: true, node: get(id) as NodeRecord }
      })
    },
    get,
    findByTokenHash(hash) {
      const row = sqlite
        .query<NodeRow, [string, string]>(
          `SELECT ${COLUMNS} FROM nodes
           WHERE (token_hash = ? OR token_next_hash = ?) AND status != 'revoked'`,
        )
        .get(hash, hash)
      return row === null ? undefined : toRecord(row)
    },
    list(query = {}) {
      const where = query.includeRevoked === true ? '' : "WHERE status != 'revoked'"
      return sqlite
        .query<NodeRow, []>(`SELECT ${COLUMNS} FROM nodes ${where} ORDER BY created_at, id`)
        .all()
        .map(toRecord)
    },
    updateManifest(id, fields) {
      const current = get(id)
      if (current === undefined || current.status === 'revoked') return undefined
      return updateLive(id, 'os = ?, arch = ?, version = ?, manifest = ?, allow_shell = ?', [
        fields.os ?? current.os,
        fields.arch ?? current.arch,
        fields.version ?? current.version,
        JSON.stringify(fields.manifest ?? current.manifest),
        (fields.allowShell ?? current.allowShell) ? 1 : 0,
      ])
    },
    setStatus(id, status, lastSeenAt) {
      return lastSeenAt === undefined
        ? updateLive(id, 'status = ?', [status])
        : updateLive(id, 'status = ?, last_seen_at = ?', [status, lastSeenAt])
    },
    touch(id) {
      return updateLive(id, 'last_seen_at = ?', [now()])
    },
    revoke(id) {
      const result = sqlite
        .query(
          `UPDATE nodes SET status = 'revoked', revoked_at = ?, token_hash = 'revoked:' || id,
             token_next_hash = NULL
           WHERE id = ? AND status != 'revoked'`,
        )
        .run(now(), id)
      return result.changes === 0 && get(id) === undefined ? undefined : get(id)
    },
    beginTokenRotation(id, nextHash) {
      return updateLive(id, 'token_next_hash = ?', [nextHash])
    },
    commitTokenRotation(id, hash) {
      const result = sqlite
        .query(
          `UPDATE nodes SET token_hash = token_next_hash, token_next_hash = NULL, token_issued_at = ?
           WHERE id = ? AND token_next_hash = ? AND status != 'revoked'`,
        )
        .run(now(), id, hash)
      return result.changes === 0 ? undefined : get(id)
    },
  }
}
