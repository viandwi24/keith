// The `clients` table (docs/specs/parietal.md, "Data"): a client of one person, registered and kept by the parietal
// service. The repo stores rows and enforces the two rules of the data itself (one owner per id, at most 20 clients
// per person); the service turns a refusal into CONFLICT. Pruning of unseen clients is in retention.ts.
import {
  CLIENTS_PER_PERSON_MAX,
  type ClientEnvironment,
  ClientEnvironmentSchema,
  type ClientKind,
  type ClientNetwork,
  ClientNetworkSchema,
  type ClientRegister,
} from '@keith/contracts'
import { immediate, type Sqlite } from '../eh/sql.ts'

export interface ClientRow {
  id: string
  personId: string
  kind: ClientKind
  label: string
  capabilities: string[]
  version: string
  firstSeenAt: number
  lastSeenAt: number
  /** Null until the client reported input once. */
  lastActiveAt: number | null
  /** Where the client runs, as it reported it on register (docs/decisions/0033); null when it did not. */
  environment: ClientEnvironment | null
  /** How the client reached the core, derived by the core on register; null when unknown. */
  network: ClientNetwork | null
}

/**
 * `registered`: a new row, or the same person's existing row updated (`created` says which). `foreign`: the id belongs
 * to another person (no hijack). `full`: the person already has `CLIENTS_PER_PERSON_MAX` other clients.
 */
export type ClientRegisterResult =
  | { status: 'registered'; created: boolean; record: ClientRow }
  | { status: 'foreign' }
  | { status: 'full' }

export interface ClientsRepo {
  /**
   * Registers or re-registers a client of `personId` at `at`, in one write transaction. `network` is what the core derived
   * from the listener; the environment is what the client reported (each replaces the stored one).
   */
  register(
    personId: string,
    input: ClientRegister,
    at: number,
    network?: ClientNetwork | null,
  ): ClientRegisterResult
  get(id: string): ClientRow | undefined
  /** The clients of a person, most recently seen first. */
  listFor(personId: string): ClientRow[]
  countFor(personId: string): number
  /**
   * Records a heartbeat: sets `last_seen_at`, and `last_active_at` too when `active`. False when the person has no
   * client of that id (an unknown or foreign id changes nothing).
   */
  touch(personId: string, id: string, at: number, active: boolean): boolean
  /** Deletes a client of the person; false when there is none. */
  remove(personId: string, id: string): boolean
}

interface Row {
  id: string
  person_id: string
  kind: string
  label: string
  capabilities: string
  version: string
  first_seen_at: number
  last_seen_at: number
  last_active_at: number | null
  environment: string | null
  network: string | null
}

/** A stored environment or network that no longer parses reads as unknown, never as a guess. */
const environmentOf = (raw: string | null): ClientEnvironment | null => {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const checked = ClientEnvironmentSchema.safeParse(parsed)
  return checked.success ? checked.data : null
}
const networkOf = (raw: string | null): ClientNetwork | null => {
  const checked = ClientNetworkSchema.safeParse(raw)
  return checked.success ? checked.data : null
}

const toRecord = (r: Row): ClientRow => ({
  id: r.id,
  personId: r.person_id,
  kind: r.kind as ClientKind,
  label: r.label,
  capabilities: JSON.parse(r.capabilities) as string[],
  version: r.version,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  lastActiveAt: r.last_active_at,
  environment: environmentOf(r.environment),
  network: networkOf(r.network),
})

export function clientsRepo(sqlite: Sqlite): ClientsRepo {
  const get = (id: string): Row | null =>
    sqlite.query<Row, [string]>('SELECT * FROM clients WHERE id = ?').get(id)

  return {
    register(personId, input, at, network = null) {
      return immediate(sqlite, (): ClientRegisterResult => {
        const existing = get(input.id)
        if (existing !== null && existing.person_id !== personId) return { status: 'foreign' }
        if (existing === null) {
          const count = sqlite
            .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM clients WHERE person_id = ?')
            .get(personId)
          if ((count?.n ?? 0) >= CLIENTS_PER_PERSON_MAX) return { status: 'full' }
        }
        const capabilities = JSON.stringify(input.capabilities)
        const environment =
          input.environment === undefined ? null : JSON.stringify(input.environment)
        if (existing === null) {
          sqlite
            .query(
              `INSERT INTO clients (id, person_id, kind, label, capabilities, version, first_seen_at, last_seen_at, last_active_at, environment, network)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              input.id,
              personId,
              input.kind,
              input.label,
              capabilities,
              input.version,
              at,
              at,
              environment,
              network,
            )
        } else {
          sqlite
            .query(
              `UPDATE clients SET kind = ?, label = ?, capabilities = ?, version = ?, last_seen_at = ?, environment = ?, network = ? WHERE id = ?`,
            )
            .run(
              input.kind,
              input.label,
              capabilities,
              input.version,
              at,
              environment,
              network,
              input.id,
            )
        }
        const row = get(input.id)
        if (row === null) throw new Error(`clients: row ${input.id} vanished after register`)
        return { status: 'registered', created: existing === null, record: toRecord(row) }
      })
    },
    get(id) {
      const row = get(id)
      return row === null ? undefined : toRecord(row)
    },
    listFor(personId) {
      return sqlite
        .query<Row, [string]>(
          'SELECT * FROM clients WHERE person_id = ? ORDER BY last_seen_at DESC, id',
        )
        .all(personId)
        .map(toRecord)
    },
    countFor(personId) {
      return (
        sqlite
          .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM clients WHERE person_id = ?')
          .get(personId)?.n ?? 0
      )
    },
    touch(personId, id, at, active) {
      const changes = sqlite
        .query(
          `UPDATE clients SET last_seen_at = ?, last_active_at = CASE WHEN ? THEN ? ELSE last_active_at END
           WHERE id = ? AND person_id = ?`,
        )
        .run(at, active ? 1 : 0, at, id, personId).changes
      return changes > 0
    },
    remove(personId, id) {
      return (
        sqlite.query('DELETE FROM clients WHERE id = ? AND person_id = ?').run(id, personId)
          .changes > 0
      )
    },
  }
}
