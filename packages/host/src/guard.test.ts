import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineKeithPlugin, defineOperation } from './define.ts'
import { GuardError, NOT_FOUND_MESSAGE } from './errors.ts'
import { echoPlugin, frontSession, type MemoryHost, memoryHost } from './testing/index.ts'
import type { ResolvedOperation } from './types.ts'

function setup(): MemoryHost {
  const h = memoryHost({ plugins: [echoPlugin()] })
  h.add('owner', 'owner')
  h.add('ana')
  h.add('bob')
  return h
}

const refusal = async (p: Promise<unknown>): Promise<GuardError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(GuardError)
    return e as GuardError
  }
  throw new Error('expected a refusal')
}

describe('actor staleness', () => {
  test('two principals through one session-resolved tool get two actors', async () => {
    const h = setup()
    const op = h.plugin('echo').operation('who') as ResolvedOperation
    // eharness resolves the function form of a tool once per session; the principal is a live getter
    let current: { id: string } | undefined = { id: 'ana' }
    const ctx = {
      get principal() {
        return current
      },
    }
    const resolveOnce = (c: typeof ctx) => ({
      execute: () => h.guard.run(op, {}, { principal: c.principal, session: frontSession() }),
    })
    const tool = resolveOnce(ctx)
    expect(await tool.execute()).toMatchObject({ person: 'ana' })
    current = { id: 'bob' }
    expect(await tool.execute()).toMatchObject({ person: 'bob' })
    current = { id: 'ana' }
    expect(await tool.execute()).toMatchObject({ person: 'ana' })
  })

  test('the context is built per call: the session facts of this call, not of the last', async () => {
    const h = setup()
    const a = await h.call('echo', 'who', {}, 'ana', { id: 'front:ana', kind: 'front' })
    const b = await h.call('echo', 'who', {}, 'ana', { id: 'front:ana:agent:t1', kind: 'worker' })
    expect(a).toMatchObject({ kind: 'front' })
    expect(b).toMatchObject({ kind: 'worker', session: 'front:ana:agent:t1' })
  })

  test('a person suspended after the tool was listed is refused on the next call', async () => {
    const h = setup()
    expect(await h.call('echo', 'say', { text: 'hi' }, 'ana')).toEqual({ text: 'hi' })
    h.suspend('ana')
    expect((await refusal(h.call('echo', 'say', { text: 'hi' }, 'ana'))).reason).toBe('status')
    h.restore('ana')
    expect(await h.call('echo', 'say', { text: 'hi' }, 'ana')).toEqual({ text: 'hi' })
  })

  test('a role change applies at once: a capability granted after the first refusal works', async () => {
    const h = setup()
    expect((await refusal(h.call('echo', 'admin', {}, 'ana'))).reason).toBe('capability')
    h.grant('ana', 'people.manage')
    expect(await h.call('echo', 'admin', {}, 'ana')).toEqual({ ok: true })
  })
})

describe('guard order and identical refusals', () => {
  test('no principal, an unknown person and a removed person are refused alike', async () => {
    const h = setup()
    h.remove('bob')
    const errors = [
      await refusal(h.call('echo', 'say', { text: 'x' }, undefined)),
      await refusal(h.call('echo', 'say', { text: 'x' }, 'nobody')),
      await refusal(h.call('echo', 'say', { text: 'x' }, 'bob')),
    ]
    for (const e of errors) {
      expect(e.code).toBe('NOT_FOUND')
      expect(e.message).toBe(NOT_FOUND_MESSAGE)
    }
    expect(errors.map((e) => e.reason)).toEqual(['actor', 'actor', 'actor'])
  })

  test('a suspended person is refused before the capability and the input are looked at', async () => {
    const h = setup()
    h.suspend('ana')
    const e = await refusal(h.call('echo', 'admin', { junk: true }, 'ana'))
    expect(e.reason).toBe('status')
  })

  test('capability is checked before the input: a caller without it learns nothing of the shape', async () => {
    const h = setup()
    const e = await refusal(h.call('echo', 'admin', { junk: 1 }, 'ana'))
    expect(e.code).toBe('NOT_FOUND')
    expect(e.reason).toBe('capability')
  })

  test('the reason is not enumerable and not in the message', async () => {
    const h = setup()
    const e = await refusal(h.call('echo', 'admin', {}, 'ana'))
    expect(Object.keys(e)).not.toContain('reason')
    expect(JSON.stringify(e)).not.toContain('capability')
    expect(e.message).not.toContain('capability')
  })

  test('an invalid input from an allowed caller is INVALID_INPUT', async () => {
    const h = setup()
    const e = await refusal(h.call('echo', 'say', { text: 5 }, 'ana'))
    expect(e.code).toBe('INVALID_INPUT')
    expect(e.message).not.toContain('5')
  })

  test('the owner holds every capability, a member only the defaults', async () => {
    const h = setup()
    expect(await h.call('echo', 'admin', {}, 'owner')).toEqual({ ok: true })
    expect((await refusal(h.call('echo', 'admin', {}, 'bob'))).code).toBe('NOT_FOUND')
  })
})

describe('audience', () => {
  test('a guest is refused unless the operation is public', async () => {
    const h = setup()
    h.addGuest('g1')
    expect(await h.call('echo', 'hello', {}, 'g1')).toEqual({ hello: 'hello' })
    const e = await refusal(h.call('echo', 'say', { text: 'x' }, 'g1'))
    expect(e.code).toBe('NOT_FOUND')
    expect(['capability', 'audience']).toContain(e.reason)
  })

  test('a guest is refused a user operation even for the capability `authenticated`', async () => {
    const h = memoryHost({ plugins: [echoPlugin()] })
    h.addGuest('g1')
    const op = h.plugin('echo').operation('say') as ResolvedOperation
    const authenticatedOnly: ResolvedOperation = {
      ...op,
      permission: { capability: 'authenticated' },
    }
    const e = await refusal(
      h.guard.run(
        authenticatedOnly,
        { text: 'x' },
        { principal: { id: 'g1' }, session: frontSession() },
      ),
    )
    expect(e.reason).toBe('audience')
  })

  test('a person passes a public operation too', async () => {
    const h = setup()
    expect(await h.call('echo', 'hello', {}, 'ana')).toEqual({ hello: 'hello' })
  })
})

describe('ACL step', () => {
  test('the owner of a resource reads it; another person gets the same refusal as for a missing one', async () => {
    const h = setup()
    const { id } = (await h.call('echo', 'put', { text: 'mine' }, 'ana')) as { id: string }
    expect(await h.call('echo', 'get', { id }, 'ana')).toEqual({ text: 'mine' })
    const denied = await refusal(h.call('echo', 'get', { id }, 'bob'))
    const missing = await refusal(h.call('echo', 'get', { id: 'item-999' }, 'bob'))
    expect(denied.message).toBe(missing.message)
    expect(denied.code).toBe(missing.code)
    expect(denied.reason).toBe('acl')
    expect(missing.reason).toBe('acl')
  })

  test('sharing through the ACL lets the other person in on the next call', async () => {
    const h = setup()
    const { id } = (await h.call('echo', 'put', { text: 'shared' }, 'ana')) as { id: string }
    h.acl.setEntry('echoitem', id, { subject: 'user:bob', bits: 4, effect: 'allow' }, 'ana')
    expect(await h.call('echo', 'get', { id }, 'bob')).toEqual({ text: 'shared' })
  })

  test("the instance owner reads another person's resource (root read)", async () => {
    const h = setup()
    const { id } = (await h.call('echo', 'put', { text: 'mine' }, 'ana')) as { id: string }
    expect(await h.call('echo', 'get', { id }, 'owner')).toEqual({ text: 'mine' })
  })
})

describe('rate limit', () => {
  test('the third call in the window is refused, and the window reopens on the clock', async () => {
    const h = setup()
    await h.call('echo', 'limited', {}, 'ana')
    await h.call('echo', 'limited', {}, 'ana')
    const e = await refusal(h.call('echo', 'limited', {}, 'ana'))
    expect(e.code).toBe('RATE_LIMITED')
    expect(e.retryAfterMs).toBeGreaterThan(0)
    // another person has their own budget
    await h.call('echo', 'limited', {}, 'bob')
    h.clock.advance(60_001)
    expect(await h.call('echo', 'limited', {}, 'ana')).toEqual({ ok: true })
  })
})

describe('audit', () => {
  test('a read is not audited, a write is, with the outcome only', async () => {
    const h = setup()
    await h.call('echo', 'say', { text: 'secret words' }, 'ana')
    expect(h.audit.rows).toEqual([])
    await h.call('echo', 'put', { text: 'secret words' }, 'ana')
    expect(h.audit.rows).toHaveLength(1)
    expect(h.audit.rows[0]).toMatchObject({
      kind: 'plugin.echo.put',
      actor: 'ana',
      detail: { outcome: 'ok' },
    })
    expect(JSON.stringify(h.audit.rows)).not.toContain('secret words')
  })

  test('a failing write records outcome error', async () => {
    const h = setup()
    await refusal(h.call('echo', 'boom', {}, 'ana'))
    expect(h.audit.rows[0]).toMatchObject({
      kind: 'plugin.echo.boom',
      detail: { outcome: 'error' },
    })
  })

  test('a denial is audited once per actor, operation and reason per window', async () => {
    const h = setup()
    for (let i = 0; i < 3; i++) await refusal(h.call('echo', 'admin', {}, 'ana'))
    expect(h.audit.kinds()).toEqual(['plugin.denied'])
    expect(h.audit.rows[0]?.detail).toEqual({
      plugin: 'echo',
      operation: 'admin',
      reason: 'capability',
    })
    h.clock.advance(10 * 60_000 + 1)
    await refusal(h.call('echo', 'admin', {}, 'ana'))
    expect(h.audit.kinds()).toEqual(['plugin.denied', 'plugin.denied'])
  })

  test('an unknown principal writes no row (nobody to blame)', async () => {
    const h = setup()
    await refusal(h.call('echo', 'say', { text: 'x' }, 'nobody'))
    expect(h.audit.rows).toEqual([])
  })
})

describe('errors and output', () => {
  test('an unexpected error is INTERNAL with a generic message', async () => {
    const h = setup()
    const e = await refusal(h.call('echo', 'boom', {}, 'ana'))
    expect(e.code).toBe('INTERNAL')
    expect(e.message).not.toContain('secret-detail')
  })

  test('an OperationError NOT_FOUND shows the standard text, not the plugin text', async () => {
    const h = setup()
    h.acl.createResource({ kind: 'echoitem', id: 'item-x', ownerId: 'ana' })
    const e = await refusal(h.call('echo', 'get', { id: 'item-x' }, 'ana'))
    expect(e.code).toBe('NOT_FOUND')
    expect(e.message).toBe(NOT_FOUND_MESSAGE)
  })

  test('undeclared output fields never leave', async () => {
    const h = setup()
    expect(await h.call('echo', 'leaky', {}, 'ana')).toEqual({ ok: true })
  })
})

describe('visibility of the catalog', () => {
  test('visible depends on actor facts and the declaration only', async () => {
    const h = setup()
    const plugin = h.plugin('echo')
    const member = await h.directory.resolve('ana')
    const owner = await h.directory.resolve('owner')
    const names = (f: typeof member, s: 'ai' | 'http' | 'call') =>
      h.guard.catalog([plugin], f, s).map((o) => o.name)
    expect(names(member, 'ai')).not.toContain('admin')
    expect(names(member, 'ai')).not.toContain('quiet')
    expect(names(owner, 'ai')).toContain('admin')
    expect(names(member, 'http')).toContain('quiet')
    expect(names(undefined, 'ai')).toEqual([])
  })

  test('sharing or creating resources does not change the catalog', async () => {
    const h = setup()
    const plugin = h.plugin('echo')
    const before = h.guard
      .catalog([plugin], await h.directory.resolve('bob'), 'ai')
      .map((o) => o.name)
    const { id } = (await h.call('echo', 'put', { text: 'x' }, 'ana')) as { id: string }
    h.acl.setEntry('echoitem', id, { subject: 'user:bob', bits: 4, effect: 'allow' }, 'ana')
    const after = h.guard
      .catalog([plugin], await h.directory.resolve('bob'), 'ai')
      .map((o) => o.name)
    expect(after).toEqual(before)
  })

  test('a guest sees only public operations on the HTTP surface, and on the AI surface only those marked for guests', async () => {
    const h = setup()
    h.addGuest('g1')
    const guest = await h.directory.resolve('g1')
    expect(h.guard.catalog([h.plugin('echo')], guest, 'http').map((o) => o.name)).toEqual(['hello'])
    // `hello` is public but not marked `expose.guest`: a guest's model is not offered it
    expect(h.guard.catalog([h.plugin('echo')], guest, 'ai')).toEqual([])
  })

  test('expose.guest offers an operation to a guest model only, never to a person', async () => {
    const plugin = defineKeithPlugin({
      id: 'kiosk',
      version: '1.0.0',
      apiVersion: 1,
      operations: [
        defineOperation({
          name: 'board',
          description: 'Read the public board.',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          permission: { capability: 'authenticated' },
          audience: 'public',
          risk: 'read',
          expose: { ai: false, guest: true },
          run: () => ({ ok: true }),
        }),
      ],
    })
    const h = memoryHost({ plugins: [plugin] })
    h.add('ana')
    h.addGuest('g1')
    const names = async (who: string) =>
      h.guard.catalog([plugin], await h.directory.resolve(who), 'ai').map((o) => o.toolName)
    expect(await names('g1')).toEqual(['kiosk_board'])
    expect(await names('ana')).toEqual([])
    expect(await h.call('kiosk', 'board', {}, 'g1')).toEqual({ ok: true })
  })

  test('for a guest, k.people finds and names no one and k.access refuses with the one refusal', async () => {
    const plugin = defineKeithPlugin({
      id: 'probe',
      version: '1.0.0',
      apiVersion: 1,
      resources: { thing: { class: 'leaf' } },
      operations: [
        defineOperation({
          name: 'look',
          description: 'Probe the context.',
          input: z.object({}),
          output: z.object({
            found: z.boolean(),
            name: z.string().nullable(),
            access: z.string(),
            kind: z.string(),
            elevated: z.boolean(),
          }),
          permission: { capability: 'authenticated' },
          audience: 'public',
          risk: 'read',
          async run(_input, k) {
            let access = 'allowed'
            try {
              await k.access.share({ kind: 'thing', id: 'x', target: '@public', bits: 4 })
            } catch (e) {
              access = e instanceof GuardError ? e.code : 'other'
            }
            return {
              found: (await k.people.find('ana')) !== undefined,
              name: (await k.people.name('ana')) ?? null,
              access,
              kind: k.actor.kind,
              elevated: k.session.elevated,
            }
          },
        }),
      ],
    })
    const h = memoryHost({ plugins: [plugin] })
    h.add('ana')
    h.addGuest('g1')
    const asGuest = await h.call('probe', 'look', {}, 'g1', { elevated: true })
    expect(asGuest).toEqual({
      found: false,
      name: null,
      access: 'NOT_FOUND',
      kind: 'guest',
      elevated: false, // the caller said elevated: a guest is never elevated
    })
  })

  test('an operation that holds for review is refused for a guest, never queued', async () => {
    const plugin = defineKeithPlugin({
      id: 'held',
      version: '1.0.0',
      apiVersion: 1,
      operations: [
        defineOperation({
          name: 'ask',
          description: 'Needs the owner.',
          input: z.object({}),
          output: z.object({}),
          permission: { capability: 'authenticated' },
          audience: 'public',
          review: 'owner',
          run: () => ({}),
        }),
      ],
    })
    const h = memoryHost({ plugins: [plugin] })
    h.addGuest('g1')
    expect((await refusal(h.call('held', 'ask', {}, 'g1'))).code).toBe('NOT_FOUND')
  })

  test('a suspended person sees nothing', async () => {
    const h = setup()
    h.suspend('ana')
    expect(h.guard.catalog([h.plugin('echo')], await h.directory.resolve('ana'), 'ai')).toEqual([])
  })
})
