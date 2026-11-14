// ProfileStore of eharness/providers on `config_profiles`. Adapted from eharness
// examples/team/server/src/infra/eh/profile-store.ts (MIT). It does not encrypt: core wraps it in
// `sealedProfileStore` with the vault, so `settings` only ever holds sealed secrets.
import type { ConfigProfile, ProfileStore } from 'eharness/providers'
import type { Sqlite } from './sql.ts'

interface Row {
  kind: string
  id: string
  definition_id: string
  label: string
  settings: string
  models: string | null
  extra: string | null
  enabled: number
  updated_at: number
}

const unrow = (row: Row): ConfigProfile =>
  ({
    ...(row.extra === null ? {} : (JSON.parse(row.extra) as Record<string, unknown>)),
    id: row.id,
    kind: row.kind,
    definitionId: row.definition_id,
    label: row.label,
    settings: JSON.parse(row.settings) as Record<string, unknown>,
    enabled: row.enabled === 1,
    source: 'store',
    updatedAt: row.updated_at,
    ...(row.models === null ? {} : { models: JSON.parse(row.models) }),
  }) as ConfigProfile

export function sqliteProfileStore(sqlite: Sqlite): ProfileStore {
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // a listener must not break a write
      }
    }
  }
  return {
    // creation order (rowid survives an upsert): editing a profile does not reorder the list
    async list(query) {
      const rows =
        query?.kind === undefined
          ? sqlite.query<Row, []>('SELECT * FROM config_profiles ORDER BY rowid').all()
          : sqlite
              .query<Row, [string]>('SELECT * FROM config_profiles WHERE kind = ? ORDER BY rowid')
              .all(query.kind)
      return rows.map(unrow)
    },
    async get(kind, id) {
      const row = sqlite
        .query<Row, [string, string]>('SELECT * FROM config_profiles WHERE kind = ? AND id = ?')
        .get(kind, id)
      return row === null ? undefined : unrow(row)
    },
    async put(profile) {
      const {
        id,
        kind,
        definitionId,
        label,
        settings,
        enabled,
        updatedAt,
        models,
        source: _source,
        ...rest
      } = profile as ConfigProfile & Record<string, unknown>
      const extra = Object.keys(rest).length === 0 ? null : JSON.stringify(rest)
      sqlite
        .query(
          `INSERT INTO config_profiles (kind, id, definition_id, label, settings, models, extra, enabled, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, id) DO UPDATE SET definition_id = excluded.definition_id,
             label = excluded.label, settings = excluded.settings, models = excluded.models,
             extra = excluded.extra, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(
          kind,
          id,
          definitionId,
          label,
          JSON.stringify(settings ?? {}),
          models === undefined ? null : JSON.stringify(models),
          extra,
          enabled ? 1 : 0,
          updatedAt,
        )
      notify()
    },
    async delete(kind, id) {
      sqlite.query('DELETE FROM config_profiles WHERE kind = ? AND id = ?').run(kind, id)
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
