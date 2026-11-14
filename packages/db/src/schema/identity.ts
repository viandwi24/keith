// People, accounts, credentials, identifiers, secrets, grants, throttling and device logins (docs/specs/db.md).
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * People Keith knows (docs/specs/people.md). `id` is a UUIDv7, except the owner of a first install
 * (`owner`). `name` is the display name; `username` is the unique, changeable login name (null only
 * until the P9 backfill of an old row). `role` is `owner` (exactly one, enforced by the unique
 * index) or `member`; `status` is `active | suspended`. `fields` and `divisions` are JSON.
 */
export const people = sqliteTable(
  'people',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    createdAt: integer('created_at').notNull(),
    username: text('username').unique(),
    status: text('status').notNull().default('active'),
    nickname: text('nickname'),
    notes: text('notes').notNull().default(''),
    fields: text('fields').notNull().default('{}'),
    divisions: text('divisions').notNull().default('[]'),
    memberId: text('member_id'),
    createdBy: text('created_by'),
    updatedAt: integer('updated_at').notNull().default(0),
    /** 1 = a User that may sign in, 0 = a directory entry only (P14, ADR-0014). */
    canLogin: integer('can_login').notNull().default(1),
  },
  (t) => [uniqueIndex('people_one_owner').on(t.role).where(sql`${t.role} = 'owner'`)],
)

/** Platform accounts of a person (`eharness/identity` `PersonAccount`): chat apps, voice, ... */
export const personAccounts = sqliteTable(
  'person_accounts',
  {
    id: text('id').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    platform: text('platform').notNull(),
    /** The platform's stable user id, never a username. */
    nativeId: text('native_id').notNull(),
    label: text('label'),
    /** linked | revoked */
    status: text('status').notNull(),
    linkedVia: text('linked_via').notNull(),
    linkedBy: text('linked_by'),
    linkedAt: integer('linked_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('person_accounts_person').on(t.personId),
    uniqueIndex('person_accounts_linked')
      .on(t.platform, t.nativeId)
      .where(sql`${t.status} = 'linked'`),
  ],
)

/** One-time codes that link a platform account to a person: only the hash is stored. */
export const personPairCodes = sqliteTable(
  'person_pair_codes',
  {
    hash: text('hash').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('person_pair_codes_person').on(t.personId, t.expiresAt)],
)

/** Bearer tokens of clients (TUI, web): only the SHA-256 hash is stored. */
export const clientTokens = sqliteTable(
  'client_tokens',
  {
    id: text('id').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    hash: text('hash').notNull().unique(),
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('client_tokens_person').on(t.personId)],
)

/**
 * Session credentials (P8): `keith_s_<id>_<secret>`; only the SHA-256 of the secret is stored.
 * `kind` is `device` (device login) or `token` (`token create`). Legacy `client_tokens` still work.
 */
export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    secretHash: text('secret_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    lastIp: text('last_ip'),
    revokedAt: integer('revoked_at'),
    /** Step-up window end (ms): the session may do sensitive work until then (P9 step 2). */
    elevatedUntil: integer('elevated_until'),
    /** P14: JSON array of the methods that made the session; null on an older row (read as `['legacy']`). */
    methods: text('methods'),
    /** P14: 0 possession, 1 PIN, 2 password; older rows are 0. */
    assurance: integer('assurance').notNull().default(0),
    /** P14: ms; null = no limit (older rows are grandfathered). */
    idleExpiresAt: integer('idle_expires_at'),
    absoluteExpiresAt: integer('absolute_expires_at'),
    userAgent: text('user_agent'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('credentials_person').on(t.personId)],
)

/**
 * Admin-set sign-in aliases of a person (P14): email and phone. `value_norm` is the normalised
 * value and is unique across people; no mail or SMS exists, so nothing is ever "verified".
 */
export const personIdentifiers = sqliteTable(
  'person_identifiers',
  {
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    kind: text('kind').notNull(),
    valueNorm: text('value_norm').primaryKey(),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('person_identifiers_person').on(t.personId)],
)

/**
 * Password and PIN of a person (P9): argon2id PHC strings, never a bearer secret. One row per
 * (person, kind); `kind` is `password` or `pin`. Separate from `credentials` on purpose: those
 * are random 256-bit bearers hashed with SHA-256, these are human secrets hashed slowly.
 */
export const personSecrets = sqliteTable(
  'person_secrets',
  {
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    kind: text('kind').notNull(),
    hash: text('hash').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.kind] })],
)

/**
 * Capabilities granted to a person on top of their role (P9 step 3, docs/specs/permissions.md).
 * `capability` is one of the closed set in `@keith/contracts`; the repo never validates it, the
 * core drops unknown ids when it reads them.
 */
export const personGrants = sqliteTable(
  'person_grants',
  {
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    capability: text('capability').notNull(),
    grantedBy: text('granted_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.capability] })],
)

/**
 * Failed password and PIN attempts (throttling). `subject` is a person id, or `u:<hash>` for a
 * username that does not exist; `ip` is the TCP peer, or `*` for the person-wide counter that
 * locks a member. Counters persist, so a restart does not reset them.
 */
export const authAttempts = sqliteTable(
  'auth_attempts',
  {
    subject: text('subject').notNull(),
    ip: text('ip').notNull(),
    failures: integer('failures').notNull().default(0),
    lastFailureAt: integer('last_failure_at').notNull(),
    lockedAt: integer('locked_at'),
  },
  (t) => [primaryKey({ columns: [t.subject, t.ip] })],
)

/** Pending device logins: only hashes of the code and the poll secret are stored. */
export const deviceRequests = sqliteTable(
  'device_requests',
  {
    id: text('id').primaryKey(),
    codeHash: text('code_hash').notNull().unique(),
    pollHash: text('poll_hash').notNull(),
    label: text('label').notNull(),
    ip: text('ip').notNull(),
    /** pending | approved | denied */
    status: text('status').notNull(),
    /** Set when approved: the credential the poll hands over once. */
    credentialId: text('credential_id'),
    /** SHA-256 of that credential's secret (the secret derives from the poll secret). */
    secretHash: text('secret_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('device_requests_ip').on(t.ip, t.expiresAt)],
)
