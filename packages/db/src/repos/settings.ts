import type { Sqlite } from '../eh/sql.ts'

/** Key-value settings with JSON values (`model.front`, `model.cortex`, ...). */
export interface SettingsRepo {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

export function settingsRepo(sqlite: Sqlite): SettingsRepo {
  return {
    get<T>(key: string): T | undefined {
      const row = sqlite
        .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
        .get(key)
      return row === null ? undefined : (JSON.parse(row.value) as T)
    },
    set(key, value) {
      sqlite
        .query(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(value), Date.now())
    },
    delete(key) {
      sqlite.query('DELETE FROM settings WHERE key = ?').run(key)
    },
  }
}
