import { describe, expect, test } from 'bun:test'
import { defineKeithPlugin, defineOperation } from './define.ts'
import { z } from './schema.ts'
import { memoryHost } from './testing/index.ts'
import type { KeithCtx } from './types.ts'

const out = z.object({}).passthrough()
type In = { id?: string | undefined; arg?: string | undefined }
const op = (name: string, run: (i: In, k: KeithCtx) => unknown, extra = {}) =>
  defineOperation({
    name,
    description: name,
    input: z.object({ id: z.string().optional(), arg: z.string().optional() }),
    output: out,
    permission: { capability: 'authenticated' },
    risk: 'read',
    ...extra,
    run,
  } as never) as ReturnType<typeof defineOperation>

function probe(withSchedule: boolean) {
  return defineKeithPlugin({
    id: 'probe',
    version: '1.0.0',
    apiVersion: 1,
    resources: { thing: { class: 'leaf' } },
    ...(withSchedule
      ? {
          async onSchedule(fire, ctx) {
            const who = (fire.payload as { to: string }).to
            const p = await ctx.person(who)
            if (p === undefined || !p.active) return { fired: false, reason: 'gone' }
            await ctx.wake({
              to: who,
              billTo: 'ana',
              name: 'probe',
              text: `late=${fire.late}`,
              id: fire.fireId,
            })
            return { fired: true }
          },
        }
      : {}),
    operations: [
      op('make', (i, k) => {
        k.acl.createResource({
          kind: 'thing',
          id: i.id as string,
          ownerId: k.actor.personId as string,
        })
        return {}
      }),
      op('share', async (i, k) => ({
        view: await k.access.share({
          kind: i.arg ?? 'thing',
          id: i.id as string,
          target: '@public',
          bits: 4,
        }),
      })),
      op('people', async (i, k) => ({
        found: (await k.people.find(i.arg as string))?.id ?? null,
        name: (await k.people.name(i.arg as string)) ?? null,
      })),
      op('touch', (i, k) => {
        k.audit.ownerAccess('thing', [i.id as string])
        return {}
      }),
      op('later', async (_i, k) => {
        const info = await k.schedule.set('t1', {
          when: { kind: 'once', at: k.clock.now() + 60_000 },
          catchUp: 'once',
          payload: { to: 'ben' },
        })
        return { info, got: await k.schedule.get('t1') }
      }),
      op('cancel', async (_i, k) => ({ gone: await k.schedule.cancel('t1') })),
    ],
  })
}

const setup = (withSchedule = true) => {
  const host = memoryHost({ plugins: [probe(withSchedule)] })
  host.add('boss', 'owner')
  for (const p of ['ana', 'ben', 'cy']) host.add(p)
  return host
}
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return (e as { code?: string }).code
  }
  return 'none'
}

describe('k.schedule and ctx.wake', () => {
  test('a plugin without onSchedule cannot use k.schedule', async () => {
    const host = setup(false)
    expect(await code(host.call('probe', 'later', {}, 'ana'))).toBe('INTERNAL')
  })

  test('set, get and cancel by key; a due timer reaches onSchedule once with a late flag and wakes through the port', async () => {
    const host = setup()
    const r = (await host.call('probe', 'later', {}, 'ana')) as {
      info: { nextFireAt: number }
      got: unknown
    }
    expect(r.got).toEqual(r.info)
    await host.tick()
    expect(host.wake.requests).toEqual([]) // not due yet
    host.clock.advance(61_000)
    await host.tick()
    await host.tick()
    expect(host.wake.requests.map((w) => ({ to: w.to, billTo: w.billTo, text: w.text }))).toEqual([
      { to: 'ben', billTo: 'ana', text: 'late=false' },
    ])
    expect(await host.call('probe', 'cancel', {}, 'ana')).toEqual({ gone: true })
    expect(await host.call('probe', 'cancel', {}, 'ana')).toEqual({ gone: false })
  })

  test('the wake port records the failure notice and answers its result as set (queued, budget)', async () => {
    const host = setup()
    const failureNotice = { to: 'ana', text: 'could not be delivered', key: 'r1:day' }
    const request = { to: 'ben', name: 'probe', text: 'hi', id: 'fire-1', failureNotice }
    host.wake.result = { delivered: true, queued: { nextAttemptAt: 123 } }
    expect(await host.wake.deliver('probe', request)).toEqual({
      delivered: true,
      queued: { nextAttemptAt: 123 },
    })
    host.wake.result = { delivered: false, reason: 'budget' }
    expect(await host.wake.deliver('probe', { ...request, id: 'fire-2' })).toEqual({
      delivered: false,
      reason: 'budget',
    })
    expect(host.wake.requests.map((r) => r.failureNotice)).toEqual([failureNotice, failureNotice])
  })

  test('onSchedule re-reads the person now: a suspended recipient is not woken', async () => {
    const host = setup()
    await host.call('probe', 'later', {}, 'ana')
    host.suspend('ben')
    host.clock.advance(120_000)
    await host.tick()
    expect(host.wake.requests).toEqual([])
  })
})

describe('k.access, k.people, k.audit.ownerAccess', () => {
  test("access is limited to the plugin's own kinds and to the resource owner; widening needs an elevated call", async () => {
    const host = setup()
    await host.call('probe', 'make', { id: 't' }, 'ana')
    expect(await code(host.call('probe', 'share', { id: 't', arg: 'note' }, 'ana'))).toBe(
      'NOT_FOUND',
    )
    expect(await code(host.call('probe', 'share', { id: 't' }, 'ana'))).toBe('FORBIDDEN') // not elevated
    expect(await code(host.call('probe', 'share', { id: 't' }, 'ben', { elevated: true }))).toBe(
      'NOT_FOUND',
    )
    await host.call('probe', 'share', { id: 't' }, 'ana', { elevated: true })
    expect(host.acl.getResource('thing', 't')?.entries.map((e) => e.subject)).toEqual(['@public'])
    expect(host.audit.kinds()).toContain('acl.share')
  })

  test('people.find answers only for an active person', async () => {
    const host = setup()
    expect(await host.call('probe', 'people', { arg: 'ben' }, 'ana')).toEqual({
      found: 'ben',
      name: 'ben',
    })
    host.suspend('ben')
    expect(await host.call('probe', 'people', { arg: 'ben' }, 'ana')).toEqual({
      found: null,
      name: 'ben',
    })
    expect(await host.call('probe', 'people', { arg: 'nobody' }, 'ana')).toEqual({
      found: null,
      name: null,
    })
  })

  test("ownerAccess records only root reads of the instance owner, never the owner's own, never a member's", async () => {
    const host = setup()
    await host.call('probe', 'make', { id: 't' }, 'ana')
    await host.call('probe', 'make', { id: 'b' }, 'boss')
    await host.call('probe', 'touch', { id: 'b' }, 'boss')
    await host.call('probe', 'touch', { id: 't' }, 'ben')
    expect(host.audit.kinds()).not.toContain('acl.owner-access')
    await host.call('probe', 'touch', { id: 't' }, 'boss')
    expect(host.audit.rows.filter((r) => r.kind === 'acl.owner-access').length).toBe(1)
  })
})
