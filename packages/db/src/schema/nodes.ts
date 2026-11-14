// Peripheral nodes and pairing codes (docs/specs/db.md).
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Peripheral nodes. `token_hash` is SHA-256 of the node token; revoking scrambles it. */
export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    /** Unique among non-revoked rows (enforced in the repo, so a revoked name can be reused). */
    name: text('name').notNull(),
    os: text('os').notNull(),
    arch: text('arch').notNull(),
    version: text('version').notNull(),
    /** JSON: the capabilities the node declares. */
    manifest: text('manifest').notNull(),
    allowShell: integer('allow_shell').notNull().default(0),
    tokenHash: text('token_hash').notNull().unique(),
    /** Hash of the token a rotation is handing out; null when no rotation is pending. */
    tokenNextHash: text('token_next_hash'),
    /** When `token_hash` was issued (join or last rotation). Null only on rows older than migration 0013; read as `created_at`. */
    tokenIssuedAt: integer('token_issued_at'),
    /** online | offline | revoked */
    status: text('status').notNull(),
    lastSeenAt: integer('last_seen_at'),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('nodes_name').on(t.name)],
)

/** One-time pairing codes: only the hash is stored. */
export const pairingCodes = sqliteTable(
  'pairing_codes',
  {
    hash: text('hash').primaryKey(),
    createdBy: text('created_by').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    usedByNode: text('used_by_node'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('pairing_codes_expiry').on(t.expiresAt)],
)
