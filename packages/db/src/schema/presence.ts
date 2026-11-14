// The presence tables of the parietal region (docs/specs/parietal.md, "Data", ADR-0025 §1, §4). Clients, the signals
// that feed presence, the manual busy status, and the disclosure settings of a person. No foreign keys: a removed
// person's rows follow the removal registry (ADR-0027 §26).
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * A client of one person (a TUI, later a web or mobile app). `id` is the uuid the client keeps; the first registrant
 * owns it. `capabilities` is a JSON array of ids. `last_active_at` is null until the client reported input once.
 */
export const clients = sqliteTable(
  'clients',
  {
    id: text('id').primaryKey(),
    personId: text('person_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    capabilities: text('capabilities').notNull(),
    version: text('version').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    lastActiveAt: integer('last_active_at'),
    /** JSON of the client's `ClientEnvironment` (docs/decisions/0033), null when the client did not report one. */
    environment: text('environment'),
    /** How the client reached the core (`ClientNetwork`), derived by the core; null when unknown. */
    network: text('network'),
  },
  (t) => [index('clients_person').on(t.personId)],
)

/**
 * A fact with a time that feeds presence: `activity`, `client.active`, `client.connected`, `client.disconnected`,
 * `node.event`, `device.location`. `detail` is JSON of at most 200 bytes and never holds message text. Kept 7 days.
 */
export const presenceSignals = sqliteTable(
  'presence_signals',
  {
    id: text('id').primaryKey(),
    personId: text('person_id').notNull(),
    clientId: text('client_id'),
    type: text('type').notNull(),
    at: integer('at').notNull(),
    detail: text('detail'),
  },
  (t) => [index('presence_signals_person_at').on(t.personId, t.at)],
)

/**
 * The manual status of a person (the first overlay source): `state` is `busy` while the row exists, `until` is the end
 * (null: no end, at most 24 hours from `set_at` by the service). `/free` deletes the row.
 */
export const presenceStatus = sqliteTable('presence_status', {
  personId: text('person_id').primaryKey(),
  state: text('state').notNull(),
  note: text('note'),
  until: integer('until'),
  setAt: integer('set_at').notNull(),
})

/** The level a person sets for one audience (`owner`, `@users`, `group:<id>`): `none`, `state` or `detail`. */
export const presenceDisclosure = sqliteTable(
  'presence_disclosure',
  {
    personId: text('person_id').notNull(),
    audience: text('audience').notNull(),
    level: text('level').notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.audience] })],
)
