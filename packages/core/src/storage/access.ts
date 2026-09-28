// auth_tokens + nodes repositories.

import { eq, lte } from 'drizzle-orm'
import { z } from 'zod'
import { type Orm, parseJson } from './orm.ts'
import { authTokens, nodes } from './schema.ts'
import type { AuthTokensRepository, NodeRecord, NodesRepository } from './types.ts'

export function createAuthTokensRepository(db: Orm): AuthTokensRepository {
  return {
    async create(t) {
      db.insert(authTokens).values(t).run()
    },
    async get(tokenHash) {
      const row = db.select().from(authTokens).where(eq(authTokens.tokenHash, tokenHash)).get()
      return row ?? null
    },
    async setNode(tokenHash, nodeId) {
      db.update(authTokens).set({ nodeId }).where(eq(authTokens.tokenHash, tokenHash)).run()
    },
    async delete(tokenHash) {
      db.delete(authTokens).where(eq(authTokens.tokenHash, tokenHash)).run()
    },
    async deleteExpired(now) {
      return db.delete(authTokens).where(lte(authTokens.expiresAt, now)).run().changes
    },
    async deleteForPerson(personId) {
      return db.delete(authTokens).where(eq(authTokens.personId, personId)).run().changes
    },
  }
}

const Capabilities = z.array(z.string())

export function createNodesRepository(db: Orm): NodesRepository {
  return {
    async upsert(n) {
      const values = { ...n, capabilities: JSON.stringify(n.capabilities) }
      db.insert(nodes)
        .values(values)
        .onConflictDoUpdate({
          target: nodes.id,
          set: {
            name: values.name,
            kind: values.kind,
            capabilities: values.capabilities,
            lastSeenAt: values.lastSeenAt,
          },
        })
        .run()
    },
    async get(id) {
      const row = db.select().from(nodes).where(eq(nodes.id, id)).get()
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        capabilities: parseJson(Capabilities, row.capabilities, {
          table: 'nodes',
          column: 'capabilities',
          id: row.id,
        }),
        lastSeenAt: row.lastSeenAt,
      } satisfies NodeRecord
    },
    async touch(id, at) {
      db.update(nodes).set({ lastSeenAt: at }).where(eq(nodes.id, id)).run()
    },
  }
}
