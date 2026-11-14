import { z } from 'zod'
import { defineKeithPlugin, defineOperation } from '../define.ts'
import { OperationError } from '../errors.ts'
import type { KeithPlugin } from '../types.ts'

/**
 * The one tiny fixture plugin that proves the pipeline: a capability-gated read, a public operation, a
 * resource with an ACL rule, a rate limit, an operation that fails, one that reports the actor it saw,
 * a dangerous one and one that is hidden from the model. Content lives in a closure (no storage yet).
 */
export function echoPlugin(): KeithPlugin {
  const items = new Map<string, string>()
  let seq = 0
  const text = z.object({ text: z.string().max(200) })
  return defineKeithPlugin({
    id: 'echo',
    version: '1.0.0',
    apiVersion: 1,
    title: 'Echo',
    description: 'Fixture plugin of the host tests.',
    permissions: [{ id: 'echo.use', description: 'Use the echo plugin.', roles: ['member'] }],
    resources: { echoitem: { class: 'leaf' } },
    operations: [
      defineOperation({
        name: 'say',
        description: 'Repeat the text.',
        input: text,
        output: text,
        permission: { capability: 'echo.use' },
        risk: 'read',
        run: (input) => ({ text: input.text }),
      }),
      defineOperation({
        name: 'hello',
        description: 'Greet anyone, guests included.',
        input: z.object({}),
        output: z.object({ hello: z.string() }),
        permission: { capability: 'authenticated' },
        audience: 'public',
        risk: 'read',
        run: () => ({ hello: 'hello' }),
      }),
      defineOperation({
        name: 'who',
        description: 'Say who the guard saw.',
        input: z.object({}),
        output: z.object({
          person: z.string().nullable(),
          session: z.string().nullable(),
          kind: z.string(),
        }),
        permission: { capability: 'echo.use' },
        risk: 'read',
        run: (_input, k) => ({
          person: k.actor.personId,
          session: k.session.id,
          kind: k.session.kind,
        }),
      }),
      defineOperation({
        name: 'put',
        description: 'Keep a private item.',
        input: text,
        output: z.object({ id: z.string() }),
        permission: { capability: 'echo.use' },
        run: (input, k) => {
          const id = `item-${++seq}`
          items.set(id, input.text)
          k.acl.createResource({ kind: 'echoitem', id, ownerId: k.actor.personId ?? 'nobody' })
          return { id }
        },
      }),
      defineOperation({
        name: 'get',
        description: 'Read an item you may read.',
        input: z.object({ id: z.string() }),
        output: text,
        permission: {
          capability: 'echo.use',
          resource: { kind: 'echoitem', bits: 4, id: (i) => i.id },
        },
        risk: 'read',
        run: (input) => {
          const value = items.get(input.id)
          if (value === undefined) throw new OperationError('NOT_FOUND', 'missing')
          return { text: value }
        },
      }),
      defineOperation({
        name: 'limited',
        description: 'Allowed twice a minute.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permission: { capability: 'echo.use' },
        risk: 'read',
        rateLimit: { max: 2, windowMs: 60_000 },
        run: () => ({ ok: true }),
      }),
      defineOperation({
        name: 'admin',
        description: 'For people managers only.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permission: { capability: 'people.manage' },
        run: () => ({ ok: true }),
      }),
      defineOperation({
        name: 'wipe',
        description: 'A dangerous call: the model asks first.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permission: { capability: 'echo.use' },
        risk: 'dangerous',
        run: () => ({ ok: true }),
      }),
      defineOperation({
        name: 'quiet',
        description: 'Not offered to the model.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permission: { capability: 'echo.use' },
        risk: 'read',
        expose: { ai: false },
        run: () => ({ ok: true }),
      }),
      defineOperation({
        name: 'internal',
        description: 'Reachable by the model and by other plugins, not over HTTP.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permission: { capability: 'echo.use' },
        risk: 'read',
        expose: { http: false },
        run: () => ({ ok: true }),
      }),
      defineOperation({
        name: 'boom',
        description: 'Fails with a secret in the error.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permission: { capability: 'echo.use' },
        run: () => {
          throw new Error('secret-detail-from-db')
        },
      }),
      defineOperation({
        name: 'leaky',
        description: 'Returns more than its output declares.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permission: { capability: 'echo.use' },
        risk: 'read',
        run: () => ({ ok: true, secret: 'do-not-show' }) as never,
      }),
    ],
  })
}
