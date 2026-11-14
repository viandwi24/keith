// Registries and settings: config profiles, catalog cache, key-value settings (docs/specs/db.md).
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// --- registries (ADR-0007) --------------------------------------------------------------------

/**
 * Profiles of any kind (`provider` now; connectors later): one configured instance per row.
 * `settings` is JSON whose secrets are sealed by `sealedProfileStore` before they get here.
 */
export const configProfiles = sqliteTable(
  'config_profiles',
  {
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    definitionId: text('definition_id').notNull(),
    label: text('label').notNull(),
    settings: text('settings').notNull(),
    models: text('models'),
    /** Plain JSON of the profile fields beyond the columns: no secrets. */
    extra: text('extra'),
    enabled: integer('enabled').notNull().default(1),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.id] })],
)

/** Raw public model catalogs (models.dev, OpenRouter) cached between runs. */
export const catalogCache = sqliteTable('catalog_cache', {
  key: text('key').primaryKey(),
  data: text('data').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
})

// --- Keith --------------------------------------------------------------------------------------

/** Key-value settings (`model.front`, `model.cortex`, ...): JSON values. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
