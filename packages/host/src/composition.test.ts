import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MAX_CALL_DEPTH } from './ctx.ts'
import { defineKeithPlugin, defineOperation } from './define.ts'
import { planBoot } from './services.ts'
import { memoryHost } from './testing/index.ts'
import type { KeithPlugin, PluginManifest } from './types.ts'

const empty = z.object({})
const ping = () =>
  defineOperation({
    name: 'ping',
    description: 'Ping.',
    input: empty,
    output: z.object({ pong: z.boolean() }),
    permission: { capability: 'authenticated' },
    risk: 'read',
    run: () => ({ pong: true }),
  })
const plug = (id: string, extra: Partial<PluginManifest> = {}): KeithPlugin =>
  defineKeithPlugin({ id, version: '1.0.0', apiVersion: 1, operations: [ping()], ...extra })
const ids = (plugins: KeithPlugin[]) => plugins.map((p) => p.id)

describe('boot order from provides and requires', () => {
  test('a provider boots before its consumers; otherwise the list order stays', () => {
    const a = plug('aa', { requires: ['bb.data'] })
    const b = plug('bb', { provides: ['bb.data'] })
    const c = plug('cc')
    const plan = planBoot([a, b, c], () => true)
    expect(ids(plan.order)).toEqual(['bb', 'aa', 'cc'])
    expect(plan.failed.size).toBe(0)
  })

  test('a missing provider fails only its consumer', () => {
    const a = plug('aa', { requires: ['zz.data'] })
    const b = plug('bb', { requires: ['aa.x'] })
    const c = plug('cc', { provides: ['aa.x'] })
    const plan = planBoot([a, b, c], () => true)
    expect(plan.failed.get('aa')).toBe('requires service "zz.data", which no plugin provides')
    expect(ids(plan.order)).toEqual(['cc', 'bb'])
  })

  test('a provider that is off is named', () => {
    const a = plug('aa', { requires: ['bb.data'] })
    const b = plug('bb', { provides: ['bb.data'] })
    const plan = planBoot([a, b], (id) => id !== 'bb')
    expect(plan.failed.get('aa')).toBe('requires service "bb.data", provided by bb which is off')
  })

  test('a chain behind a failed provider fails with a clear reason', () => {
    const a = plug('aa', { requires: ['bb.data'], provides: ['aa.x'] })
    const b = plug('bb', { requires: ['nothing.here'], provides: ['bb.data'] })
    const c = plug('cc', { requires: ['aa.x'] })
    const plan = planBoot([a, b, c], () => true)
    expect([...plan.failed.keys()].sort()).toEqual(['aa', 'bb', 'cc'])
    expect(plan.failed.get('cc')).toBe('requires service "aa.x", provided by aa which cannot load')
  })

  test('a cycle fails every plugin on it with the loop, and not the plugin beside it', () => {
    const a = plug('aa', { requires: ['bb.s'], provides: ['aa.s'] })
    const b = plug('bb', { requires: ['aa.s'], provides: ['bb.s'] })
    const c = plug('cc')
    const plan = planBoot([a, b, c], () => true)
    expect(ids(plan.order)).toEqual(['cc'])
    expect(plan.failed.get('aa')).toBe('dependency cycle: aa -> bb -> aa')
    expect(plan.failed.get('bb')).toBe('dependency cycle: bb -> aa -> bb')
  })

  test('two providers of one service: the second fails', () => {
    const plan = planBoot(
      [plug('aa', { provides: ['s.x'] }), plug('bb', { provides: ['s.x'] })],
      () => true,
    )
    expect(plan.failed.get('bb')).toBe('service "s.x" is already provided by aa')
  })
})

describe('services at runtime (memoryHost.boot)', () => {
  const provider = plug('store', {
    provides: ['store.count'],
    start: (ctx) => {
      ctx.provide('store.count', { value: () => 42 })
    },
  })
  const consumer = defineKeithPlugin({
    id: 'user',
    version: '1.0.0',
    apiVersion: 1,
    requires: ['store.count'],
    operations: [
      defineOperation({
        name: 'read',
        description: 'Read the count.',
        input: empty,
        output: z.object({ n: z.number() }),
        permission: { capability: 'authenticated' },
        risk: 'read',
        run: (_i, k) => ({ n: k.services.get<{ value(): number }>('store.count').value() }),
      }),
      defineOperation({
        name: 'peek',
        description: 'Read a service it did not require.',
        input: empty,
        output: empty,
        permission: { capability: 'authenticated' },
        risk: 'read',
        run: (_i, k) => {
          k.services.get('other.thing')
          return {}
        },
      }),
    ],
  })

  test('a consumer reads what its provider offered; a service not in requires is refused', async () => {
    const host = memoryHost({ plugins: [consumer, provider] })
    host.add('ana')
    await host.boot()
    expect(await host.call('user', 'read', {}, 'ana')).toEqual({ n: 42 })
    await expect(host.call('user', 'peek', {}, 'ana')).rejects.toThrow('the operation failed')
  })

  test('a plugin that does not offer all of provides fails to boot', async () => {
    const lazy = plug('lazy', { provides: ['lazy.s'], start: () => {} })
    await expect(memoryHost({ plugins: [lazy] }).boot()).rejects.toThrow('did not provide lazy.s')
  })

  test('provide refuses an id outside provides', async () => {
    const sneaky = plug('sneaky', {
      provides: ['sneaky.s'],
      start: (c) => c.provide('sneaky.other', {}),
    })
    await expect(memoryHost({ plugins: [sneaky] }).boot()).rejects.toThrow('not in provides')
  })
})

describe('k.call', () => {
  const target = defineKeithPlugin({
    id: 'target',
    version: '1.0.0',
    apiVersion: 1,
    operations: [
      defineOperation({
        name: 'who',
        description: 'Who asked.',
        input: empty,
        output: z.object({ person: z.string().nullable(), elevated: z.boolean() }),
        permission: { capability: 'authenticated' },
        risk: 'read',
        run: (_i, k) => ({ person: k.actor.personId, elevated: k.session.elevated }),
      }),
      defineOperation({
        name: 'admin',
        description: 'Needs an owner capability.',
        input: empty,
        output: empty,
        permission: { capability: 'people.manage' },
        run: () => ({}),
      }),
      defineOperation({
        name: 'hidden',
        description: 'Not callable by other plugins.',
        input: empty,
        output: empty,
        permission: { capability: 'authenticated' },
        expose: { call: false, ai: true },
        run: () => ({}),
      }),
      defineOperation({
        name: 'write',
        description: 'A write, so it is audited.',
        input: empty,
        output: empty,
        permission: { capability: 'authenticated' },
        run: () => ({}),
      }),
    ],
  })
  const caller = defineKeithPlugin({
    id: 'caller',
    version: '1.0.0',
    apiVersion: 1,
    operations: [
      defineOperation({
        name: 'go',
        description: 'Call anything.',
        input: z.object({ target: z.string() }),
        output: z.object({ result: z.unknown() }),
        permission: { capability: 'authenticated' },
        run: async (i, k) => ({ result: await k.call(i.target, {}) }),
      }),
      defineOperation({
        name: 'loop',
        description: 'Calls itself.',
        input: empty,
        output: empty,
        permission: { capability: 'authenticated' },
        run: async (_i, k) => {
          await k.call('caller.loop', {})
          return {}
        },
      }),
    ],
  })
  const setup = () => {
    const host = memoryHost({ plugins: [target, caller] })
    host.add('owner', 'owner')
    host.add('ana')
    return host
  }
  const go = (host: ReturnType<typeof setup>, who: string, to: string, session = {}) =>
    host.call('caller', 'go', { target: to }, who, session)

  test('the callee sees the caller: same person, same session facts, never elevated by the call', async () => {
    const host = setup()
    expect(await go(host, 'ana', 'target.who')).toEqual({
      result: { person: 'ana', elevated: false },
    })
    expect(await go(host, 'ana', 'target.who', { elevated: true })).toEqual({
      result: { person: 'ana', elevated: true },
    })
  })

  test('a member cannot reach an owner operation through a call; the owner can', async () => {
    const host = setup()
    await expect(go(host, 'ana', 'target.admin')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await go(host, 'owner', 'target.admin')).toEqual({ result: {} })
  })

  test('a call to an unknown plugin, an unknown operation or one hidden from calls is the same refusal', async () => {
    const host = setup()
    for (const to of ['nope.who', 'target.nope', 'target.hidden', 'nodot', '.who'])
      await expect(go(host, 'ana', to), to).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('a suspended person is refused at the callee too', async () => {
    const host = setup()
    host.suspend('ana')
    await expect(go(host, 'ana', 'target.who')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('the depth is limited', async () => {
    const host = setup()
    await expect(host.call('caller', 'loop', {}, 'ana')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'calls are nested too deep',
    })
    expect(MAX_CALL_DEPTH).toBe(4)
  })

  test('the audit row of a called write names the caller', async () => {
    const host = setup()
    await go(host, 'ana', 'target.write')
    const row = host.audit.rows.find((r) => r.kind === 'plugin.target.write')
    expect(row?.detail).toEqual({ outcome: 'ok', from: 'caller.go' })
    expect(row?.actor).toBe('ana')
  })
})

describe('events and notices', () => {
  const emitter = defineKeithPlugin({
    id: 'emit',
    version: '1.0.0',
    apiVersion: 1,
    events: { shared: z.object({ what: z.string() }) },
    operations: [
      defineOperation({
        name: 'tell',
        description: 'Emit an event.',
        input: z.object({
          name: z.string(),
          data: z.unknown(),
          to: z.union([z.array(z.string()), z.literal('public')]).optional(),
        }),
        output: empty,
        permission: { capability: 'authenticated' },
        run: (i, k) => {
          k.emit(i.name, i.data, i.to)
          return {}
        },
      }),
      defineOperation({
        name: 'notice',
        description: 'Notify the actor.',
        input: z.object({ text: z.string() }),
        output: empty,
        permission: { capability: 'authenticated' },
        run: (i, k) => {
          k.notify(i.text)
          return {}
        },
      }),
    ],
  })
  const setup = () => {
    const host = memoryHost({ plugins: [emitter] })
    host.add('ana')
    host.add('ben')
    return host
  }

  test('an event goes to the actor alone unless the plugin names more people', async () => {
    const host = setup()
    await host.call('emit', 'tell', { name: 'shared', data: { what: 'a' } }, 'ana')
    await host.call(
      'emit',
      'tell',
      { name: 'shared', data: { what: 'b' }, to: ['ben', 'ben'] },
      'ana',
    )
    await host.call('emit', 'tell', { name: 'shared', data: { what: 'c' }, to: 'public' }, 'ana')
    expect(host.events).toEqual([
      { plugin: 'emit', name: 'shared', data: { what: 'a' }, to: ['ana'] },
      { plugin: 'emit', name: 'shared', data: { what: 'b' }, to: ['ben'] },
      { plugin: 'emit', name: 'shared', data: { what: 'c' }, to: 'public' },
    ])
  })

  test('an undeclared event, bad data and extra fields are refused or stripped', async () => {
    const host = setup()
    await expect(host.call('emit', 'tell', { name: 'other', data: {} }, 'ana')).rejects.toThrow(
      'the operation failed',
    )
    await expect(
      host.call('emit', 'tell', { name: 'shared', data: { what: 1 } }, 'ana'),
    ).rejects.toThrow('the operation failed')
    await host.call('emit', 'tell', { name: 'shared', data: { what: 'x', secret: 'no' } }, 'ana')
    expect(host.events[0]?.data).toEqual({ what: 'x' })
  })

  test('a notice reaches the actor only, is capped in size and rate', async () => {
    const host = setup()
    await host.call('emit', 'notice', { text: 'hello' }, 'ben')
    expect(host.notices).toEqual([{ plugin: 'emit', to: 'ben', text: 'hello' }])
    await expect(host.call('emit', 'notice', { text: '' }, 'ben')).rejects.toThrow(
      'the operation failed',
    )
    await expect(host.call('emit', 'notice', { text: 'x'.repeat(501) }, 'ben')).rejects.toThrow(
      'the operation failed',
    )
    for (let i = 0; i < 25; i++) await host.call('emit', 'notice', { text: 'again' }, 'ben')
    expect(host.notices.length).toBe(20)
    host.clock.advance(61_000)
    await host.call('emit', 'notice', { text: 'later' }, 'ben')
    expect(host.notices.length).toBe(21)
  })

  test('a guest cannot be notified and an event of a guest defaults to nobody', async () => {
    const host = memoryHost({
      plugins: [
        defineKeithPlugin({
          id: 'pub',
          version: '1.0.0',
          apiVersion: 1,
          events: { seen: z.object({}) },
          operations: [
            defineOperation({
              name: 'hi',
              description: 'Public.',
              input: empty,
              output: empty,
              audience: 'public',
              permission: { capability: 'authenticated' },
              run: (_i, k) => {
                k.emit('seen', {})
                k.notify('x')
                return {}
              },
            }),
          ],
        }),
      ],
    })
    host.addGuest('g1')
    await expect(host.call('pub', 'hi', {}, 'g1')).rejects.toThrow('the operation failed')
    expect(host.events).toEqual([])
  })
})

describe('owner review', () => {
  const text = z.object({ to: z.string(), text: z.string() })
  const ran: string[] = []
  const reminders = defineKeithPlugin({
    id: 'remind',
    version: '1.0.0',
    apiVersion: 1,
    operations: [
      defineOperation({
        name: 'create',
        description: 'Create a reminder; for someone else it waits for the owner.',
        input: text,
        output: z.object({ ok: z.boolean(), by: z.string().nullable() }),
        permission: { capability: 'authenticated' },
        review: { by: 'owner', when: (input, actor) => input.to !== actor.personId },
        run: (input, k) => {
          ran.push(`${k.actor.personId}->${input.to}`)
          return { ok: true, by: k.actor.personId }
        },
      }),
      defineOperation({
        name: 'always',
        description: 'Always held.',
        input: empty,
        output: empty,
        permission: { capability: 'authenticated' },
        review: 'owner',
        run: () => ({}),
      }),
      defineOperation({
        name: 'manual',
        description: 'Asks for a review by itself.',
        input: z.object({ to: z.string() }),
        output: z.unknown(),
        permission: { capability: 'authenticated' },
        run: (input, k) => k.review.request('create', { to: input.to, text: 'hi' }, 'because'),
      }),
    ],
  })
  const setup = () => {
    ran.length = 0
    const host = memoryHost({ plugins: [reminders] })
    host.add('owner', 'owner')
    host.add('ana')
    host.add('ben')
    return host
  }

  test('a call that needs review stores the validated input and runs nothing', async () => {
    const host = setup()
    const out = await host.call('remind', 'create', { to: 'ben', text: 'x' }, 'ana')
    expect(out).toEqual({
      review: { id: 'rv1', status: 'pending', message: 'sent to the owner for review' },
    })
    expect(ran).toEqual([])
    expect(host.reviews[0]).toMatchObject({
      requester: 'ana',
      plugin: 'remind',
      operation: 'create',
      payload: { to: 'ben', text: 'x' },
    })
    expect(
      host.audit.rows.find((r) => r.kind === 'plugin.remind.review.requested')?.detail,
    ).toEqual({
      operation: 'create',
      review: 'rv1',
    })
  })

  test('a call the rule lets through runs at once; the owner is never held', async () => {
    const host = setup()
    expect(await host.call('remind', 'create', { to: 'ana', text: 'x' }, 'ana')).toEqual({
      ok: true,
      by: 'ana',
    })
    expect(await host.call('remind', 'create', { to: 'ben', text: 'x' }, 'owner')).toEqual({
      ok: true,
      by: 'owner',
    })
    expect(host.reviews).toEqual([])
  })

  test('input is validated before it is stored, and an unauthorized caller learns nothing', async () => {
    const host = setup()
    await expect(host.call('remind', 'create', { to: 1 }, 'ana')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(host.call('remind', 'always', {}, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(host.reviews).toEqual([])
  })

  test('approval replays as the requester and runs once; a suspended requester is refused', async () => {
    const host = setup()
    await host.call('remind', 'create', { to: 'ben', text: 'x' }, 'ana')
    await host.call('remind', 'create', { to: 'ben', text: 'y' }, 'ana')
    expect(await host.approve('rv1')).toEqual({ ok: true, by: 'ana' })
    expect(ran).toEqual(['ana->ben'])
    await expect(host.approve('rv1')).rejects.toThrow('no pending review')
    host.suspend('ana')
    await expect(host.approve('rv2')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(ran).toEqual(['ana->ben'])
    expect(host.audit.rows.find((r) => r.kind === 'plugin.remind.create')?.detail).toEqual({
      outcome: 'ok',
      review: 'rv1',
    })
  })

  test('a person holds at most 20 pending reviews', async () => {
    const host = setup()
    for (let i = 0; i < 20; i++) await host.call('remind', 'always', {}, 'ana')
    await expect(host.call('remind', 'always', {}, 'ana')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
    await host.call('remind', 'always', {}, 'ben') // another person has their own room
  })

  test('k.review.request files a review of another operation; the owner may not use it', async () => {
    const host = setup()
    const out = await host.call('remind', 'manual', { to: 'ben' }, 'ana')
    expect(out).toMatchObject({ review: { id: 'rv1' } })
    await expect(host.call('remind', 'manual', { to: 'ben' }, 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  test('a review rule must be well formed', () => {
    expect(() =>
      defineKeithPlugin({
        id: 'badrule',
        version: '1.0.0',
        apiVersion: 1,
        operations: [{ ...ping(), review: 'anyone' as never }],
      }),
    ).toThrow('review is')
  })
})
