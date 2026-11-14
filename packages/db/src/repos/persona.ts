// The persona and its history (docs/specs/prefrontal.md, "Data model", P33.2.2). A write moves the `persona` row and adds one
// `persona_versions` row in one `BEGIN IMMEDIATE`: the version is read and written inside the same transaction, so two
// writers cannot both take the same number, and a write that fails halfway leaves neither row. A restore writes a new
// version with the old body; the history keeps every version. Validation of the body is the contract's schema.
import {
  type PersonaBody,
  PersonaBodySchema,
  type PersonaTemplateId,
  PersonaTemplateIdSchema,
  type PersonaVersionReason,
  PersonaVersionReasonSchema,
} from '@keith/contracts'
import { immediate, type Sqlite } from '../eh/sql.ts'

/** The one persona row (`persona.id`). */
export const PERSONA_ID = 'keith'

/** The current persona as the repo reads it. */
export interface PersonaRecord {
  version: number
  templateId: PersonaTemplateId
  body: PersonaBody
  updatedAt: number
  updatedBy: string
}

/** One row of the history. */
export interface PersonaVersionRecord {
  id: string
  version: number
  templateId: PersonaTemplateId
  body: PersonaBody
  reason: PersonaVersionReason
  changedBy: string
  changedAt: number
  note: string | null
}

export interface PersonaWriteInput {
  templateId: PersonaTemplateId
  body: PersonaBody
  reason: PersonaVersionReason
  changedBy: string
  note?: string | null
}

export interface PersonaRepoOptions {
  now?: () => number
}

export interface PersonaRepo {
  /** The current persona, or undefined before the first boot seeds it. */
  get(): PersonaRecord | undefined
  /**
   * Writes the persona and one version in one transaction; the new version is the current one plus 1 (1 for the first
   * write). Returns the version written. A refused write (a CHECK, a bad value) throws and leaves both tables as they were.
   */
  write(input: PersonaWriteInput): number
  /** One version of the history, or undefined. */
  version(version: number): PersonaVersionRecord | undefined
  /** The history, newest first. */
  versions(limit?: number): PersonaVersionRecord[]
  /**
   * Restores version `version`: writes a NEW version (reason `restore`) with its template and body. The old version stays.
   * Undefined when the version is unknown; nothing is written then.
   */
  restore(version: number, changedBy: string, note?: string | null): number | undefined
}

interface PersonaRow {
  version: number
  template_id: string
  body: string
  updated_at: number
  updated_by: string
}

interface VersionRow {
  id: string
  version: number
  template_id: string
  body: string
  reason: string
  changed_by: string
  changed_at: number
  note: string | null
}

const toPersona = (row: PersonaRow): PersonaRecord => ({
  version: row.version,
  templateId: PersonaTemplateIdSchema.parse(row.template_id),
  body: PersonaBodySchema.parse(JSON.parse(row.body)),
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
})

const toVersion = (row: VersionRow): PersonaVersionRecord => ({
  id: row.id,
  version: row.version,
  templateId: PersonaTemplateIdSchema.parse(row.template_id),
  body: PersonaBodySchema.parse(JSON.parse(row.body)),
  reason: PersonaVersionReasonSchema.parse(row.reason),
  changedBy: row.changed_by,
  changedAt: row.changed_at,
  note: row.note,
})

export function personaRepo(sqlite: Sqlite, options: PersonaRepoOptions = {}): PersonaRepo {
  const now = options.now ?? Date.now

  const currentVersion = (): number =>
    sqlite
      .query<{ version: number }, [string]>('SELECT version FROM persona WHERE id = ?')
      .get(PERSONA_ID)?.version ?? 0

  const getVersion = (version: number): PersonaVersionRecord | undefined => {
    const row = sqlite
      .query<VersionRow, [number]>(
        `SELECT id, version, template_id, body, reason, changed_by, changed_at, note
         FROM persona_versions WHERE version = ?`,
      )
      .get(version)
    return row === null ? undefined : toVersion(row)
  }

  /** The write, inside the caller's transaction: the persona row and one history row. */
  const writeRows = (input: PersonaWriteInput): number => {
    const templateId = PersonaTemplateIdSchema.parse(input.templateId)
    const body = PersonaBodySchema.parse(input.body)
    const reason = PersonaVersionReasonSchema.parse(input.reason)
    const version = currentVersion() + 1
    const at = now()
    const json = JSON.stringify(body)
    sqlite
      .query(
        `INSERT INTO persona (id, version, template_id, body, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, template_id = excluded.template_id,
           body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(PERSONA_ID, version, templateId, json, at, input.changedBy)
    sqlite
      .query(
        `INSERT INTO persona_versions (id, version, template_id, body, reason, changed_by, changed_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Bun.randomUUIDv7(),
        version,
        templateId,
        json,
        reason,
        input.changedBy,
        at,
        input.note ?? null,
      )
    return version
  }

  return {
    get() {
      const row = sqlite
        .query<PersonaRow, [string]>(
          'SELECT version, template_id, body, updated_at, updated_by FROM persona WHERE id = ?',
        )
        .get(PERSONA_ID)
      return row === null ? undefined : toPersona(row)
    },
    write(input) {
      return immediate(sqlite, () => writeRows(input))
    },
    version: getVersion,
    versions(limit = 50) {
      return sqlite
        .query<VersionRow, [number]>(
          `SELECT id, version, template_id, body, reason, changed_by, changed_at, note
           FROM persona_versions ORDER BY version DESC LIMIT ?`,
        )
        .all(limit)
        .map(toVersion)
    },
    restore(version, changedBy, note = null) {
      return immediate(sqlite, () => {
        const old = getVersion(version)
        if (old === undefined) return undefined
        return writeRows({
          templateId: old.templateId,
          body: old.body,
          reason: 'restore',
          changedBy,
          note,
        })
      })
    },
  }
}
