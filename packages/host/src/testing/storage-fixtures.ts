import { z } from 'zod'
import { defineKeithPlugin, defineOperation } from '../define.ts'
import { eq, sql } from '../schema.ts'
import type { KeithPlugin } from '../types.ts'
import { items } from './fixtures/alpha/schema.ts'
import { notes } from './fixtures/beta-two/schema.ts'

/** Where the fixture migrations were generated (`bun run plugin:db:generate <id> --dir <folder>`). */
export const FIXTURES_DIR: string = `${import.meta.dir}/fixtures`

const Open = { capability: 'authenticated' } as const

/**
 * Two fixture plugins that keep tables, for the storage tests of the host and of the core: `alpha`
 * (`plg_alpha_items`, two migrations) and `beta-two` (`plg_beta_two_notes`, one; the hyphen proves
 * the name rule). `probe` runs the SQL it is given and reports the refusal instead of throwing.
 */
export function alphaPlugin(): KeithPlugin {
  return defineKeithPlugin({
    id: 'alpha',
    version: '1.0.0',
    apiVersion: 1,
    storage: { migrations: `${FIXTURES_DIR}/alpha/migrations` },
    operations: [
      defineOperation({
        name: 'add',
        description: 'Add an item.',
        input: z.object({ id: z.string().min(1).max(40), title: z.string().max(100) }),
        output: z.object({ ok: z.boolean() }),
        permission: Open,
        run(input, k) {
          k.db.insert(items).values({ id: input.id, title: input.title }).run()
          return { ok: true }
        },
      }),
      defineOperation({
        name: 'titles',
        description: 'List titles.',
        input: z.object({}),
        output: z.object({ titles: z.array(z.string()) }),
        permission: Open,
        risk: 'read',
        run: (_input, k) => ({
          titles: k.db
            .select()
            .from(items)
            .all()
            .map((r) => r.title),
        }),
      }),
      defineOperation({
        name: 'rename',
        description: 'Rename an item.',
        input: z.object({ id: z.string(), title: z.string() }),
        output: z.object({ changed: z.number() }),
        permission: Open,
        run: (input, k) => ({
          changed: k.db
            .update(items)
            .set({ title: input.title })
            .where(eq(items.id, input.id))
            .returning({ id: items.id })
            .all().length,
        }),
      }),
      defineOperation({
        name: 'probe',
        description: 'Run raw SQL and report what the scope said.',
        input: z.object({ sql: z.string().max(500) }),
        output: z.object({ ok: z.boolean(), message: z.string() }),
        permission: Open,
        risk: 'read',
        run(input, k) {
          try {
            k.db.run(sql.raw(input.sql))
            return { ok: true, message: '' }
          } catch (error) {
            // Drizzle wraps what the client threw: the scope's own message is the cause
            const cause =
              error instanceof Error && error.cause instanceof Error ? error.cause : error
            return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
          }
        },
      }),
      defineOperation({
        name: 'kv',
        description: 'Set then read a key-value pair.',
        input: z.object({ key: z.string(), value: z.string() }),
        output: z.object({ value: z.string().nullable(), keys: z.array(z.string()) }),
        permission: Open,
        run(input, k) {
          k.kv.set(input.key, input.value)
          return {
            value: k.kv.get<string>(input.key) ?? null,
            keys: k.kv.list().map((e) => e.key),
          }
        },
      }),
    ],
  })
}

export function betaTwoPlugin(): KeithPlugin {
  return defineKeithPlugin({
    id: 'beta-two',
    version: '1.0.0',
    apiVersion: 1,
    storage: { migrations: `${FIXTURES_DIR}/beta-two/migrations` },
    operations: [
      defineOperation({
        name: 'note',
        description: 'Add a note and return how many exist.',
        input: z.object({ body: z.string().max(100) }),
        output: z.object({ count: z.number() }),
        permission: Open,
        run(input, k) {
          k.db.insert(notes).values({ body: input.body }).run()
          return { count: k.db.select().from(notes).all().length }
        },
      }),
    ],
  })
}
