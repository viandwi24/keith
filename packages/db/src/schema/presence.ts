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
 * The stated status of a person: `state` is its kind, `busy` (the first overlay source) or `out`; `from` is the start
 * (epoch ms, null: from `set_at`), `until` is the end (null: no end, capped by the service). `/free` deletes the row.
 */
export const presenceStatus = sqliteTable('presence_status', {
  personId: text('person_id').primaryKey(),
  state: text('state').notNull(),
  note: text('note'),
  /** Epoch ms the status starts (ADR-0034 §5); null means it started when it was set. */
  from: integer('from'),
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

/**
 * A Web Push subscription of one person (docs/specs/push.md, ADR-0035): the endpoint (unique) and the browser's keys. The
 * endpoint and the keys are secrets of the subscription; no read shows them to a client. `failures` counts failed sends
 * in a row, the row is dropped past the limit or on a 404/410 answer.
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    personId: text('person_id').notNull(),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** The presence client id of the browser, when it sent one. */
    clientId: text('client_id'),
    label: text('label').notNull(),
    userAgent: text('user_agent').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSuccessAt: integer('last_success_at'),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (t) => [index('push_subscriptions_person').on(t.personId)],
)
