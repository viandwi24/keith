import { afterEach, describe, expect, test } from 'bun:test'
import { AuthPolicySchema, IdentifyResponseSchema } from '@keith/contracts'
import { caller, cleanup, harness, LOOP, member, PASS, post } from '../../testing/auth-harness.ts'

afterEach(cleanup)

const identify = (h: ReturnType<typeof harness>, identifier: string, peer = LOOP) =>
  h.routes.identify(post({ identifier }), peer)
const answerFlow = (
  h: ReturnType<typeof harness>,
  flowId: string,
  password: string,
  peer = LOOP,
  method = 'password',
) => h.routes.flow(post({ method, answer: { password } }), peer, flowId)
const flowIdOf = async (res: Response): Promise<string> =>
  IdentifyResponseSchema.parse(await res.json()).flowId

async function seeded() {
  const h = harness()
  await member(h, 'ana')
  await h.people.rename('ana', { name: 'Ana Banana' }, caller)
  await h.aliases.add('ana', 'email', 'Ana@Example.com', caller)
  await h.aliases.add('ana', 'phone', '+62 812-3456-7890', caller)
  return h
}

describe('POST /auth/identify', () => {
  test('known, alias, unknown and display name answer with the same status and shape', async () => {
    const h = await seeded()
    const typed = ['ana', 'ANA@example.com', '+6281234567890', '0123456789', 'nobody', 'Ana Banana']
    const shapes: string[] = []
    const sizes = new Set<number>()
    for (const identifier of typed) {
      const res = await identify(h, identifier)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const text = await res.text()
      const body = IdentifyResponseSchema.parse(JSON.parse(text))
      sizes.add(text.length)
      shapes.push(JSON.stringify({ ...body, flowId: body.flowId.length }))
    }
    expect(new Set(shapes).size).toBe(1)
    expect(sizes.size).toBe(1)
  })

  test('the list depends on the zone only and marks the default', async () => {
    const h = await seeded()
    const local = IdentifyResponseSchema.parse(await (await identify(h, 'ana')).json())
    expect(local.context).toBe('loopback')
    expect(local.methods.map((m) => [m.id, m.available])).toEqual([
      ['device', true],
      ['pin', true],
      ['password', true],
      ['token', true],
    ])
    expect(local.methods.find((m) => m.default)?.id).toBe('pin')
    expect(
      local.methods.find((m) => m.id === 'password')?.firstStep.fields.map((f) => f.name),
    ).toEqual(['password'])
    const far = IdentifyResponseSchema.parse(
      await (await identify(h, 'ana', { via: 'tcp', ip: '8.8.8.8', forwarded: false })).json(),
    )
    expect(far.context).toBe('public')
    expect(far.methods.find((m) => m.id === 'password')).toMatchObject({ available: false })
    expect(far.methods.find((m) => m.id === 'pin')).toMatchObject({ available: false })
    expect(far.methods.some((m) => m.default)).toBe(false)
  })

  test('a bad body is 400 and a loopback peer with forwarding headers is public', async () => {
    const h = await seeded()
    expect((await h.routes.identify(post({}), LOOP)).status).toBe(400)
    expect((await h.routes.identify(post({ identifier: '  ' }), LOOP)).status).toBe(400)
    const proxied = await h.routes.identify(post({ identifier: 'ana' }), {
      ...LOOP,
      forwarded: true,
    })
    expect(IdentifyResponseSchema.parse(await proxied.json()).context).toBe('public')
  })

  test('limits count the same for a known and an unknown identifier', async () => {
    const h = await seeded()
    const run = async (identifier: string) => {
      const codes: number[] = []
      for (let i = 0; i < 12; i += 1) codes.push((await identify(h, identifier)).status)
      return codes
    }
    expect(await run('ana')).toEqual(await run('nobody-at-all'))
    const codes = await run('ana')
    expect(codes.every((c) => c === 429)).toBe(true)
  })

  test('the address limit applies to every identifier', async () => {
    const h = await seeded()
    let last = 200
    for (let i = 0; i < 70; i += 1) last = (await identify(h, `name${i}`)).status
    expect(last).toBe(429)
    // another address is unaffected
    expect(
      (await identify(h, 'ana', { via: 'tcp', ip: '127.0.0.2', forwarded: false })).status,
    ).toBe(200)
  })
})

describe('POST /auth/flow/:id', () => {
  test('signs in by username, email and phone; a display name never works', async () => {
    const h = await seeded()
    for (const typed of ['ana', 'Ana@Example.com', '+62 812 3456 7890']) {
      const res = await answerFlow(h, await flowIdOf(await identify(h, typed)), PASS('ana'))
      expect(res.status).toBe(200)
      const { credential } = (await res.json()) as { credential: string }
      expect(credential.startsWith('keith_s_')).toBe(true)
    }
    const named = await answerFlow(h, await flowIdOf(await identify(h, 'Ana Banana')), PASS('ana'))
    expect(named.status).toBe(401)
  })

  test('a wrong secret is the same 401 for a known, an unknown and a no-login identifier', async () => {
    const h = await seeded()
    await member(h, 'bob')
    h.sqlite.query("UPDATE people SET can_login = 0 WHERE username = 'bob'").run()
    const outcomes: string[] = []
    for (const typed of ['ana', 'nobody', 'bob']) {
      for (const secret of [
        'wrong secret here ok',
        typed === 'bob' ? PASS('bob') : 'x'.repeat(16),
      ]) {
        const res = await answerFlow(h, await flowIdOf(await identify(h, typed)), secret)
        outcomes.push(`${res.status} ${await res.text()}`)
      }
    }
    expect(new Set(outcomes)).toEqual(new Set(['401 {"error":"invalid_credentials"}']))
  })

  test('lockout state is shared with the decoy path and with /auth/login', async () => {
    const h = await seeded()
    // five failures by flow on the real person, then the legacy login is throttled as well
    for (let i = 0; i < 5; i += 1) {
      await answerFlow(h, await flowIdOf(await identify(h, 'ana')), 'wrong wrong wrong')
    }
    const login = await h.routes.login(post({ username: 'ana', password: PASS('ana') }), LOOP)
    expect(login.status).toBe(429)
    // the decoy is throttled after the same count, with the same body
    for (let i = 0; i < 5; i += 1) {
      await answerFlow(h, await flowIdOf(await identify(h, 'ghost')), 'wrong wrong wrong')
    }
    const real = await answerFlow(h, await flowIdOf(await identify(h, 'ana')), PASS('ana'))
    const decoy = await answerFlow(h, await flowIdOf(await identify(h, 'ghost')), PASS('ana'))
    expect(real.status).toBe(decoy.status)
    expect(await real.text()).toBe(await decoy.text())
  })

  test('the same database work and the same number of hashes for known and unknown', async () => {
    let verifies = 0
    const engine = {
      hash: (s: string, p: Parameters<typeof Bun.password.hash>[1]) => Bun.password.hash(s, p),
      verify: (s: string, phc: string) => {
        verifies += 1
        return Bun.password.verify(s, phc)
      },
    }
    const h = harness({ engine: engine as never })
    await member(h, 'ana')
    verifies = 0
    const measure = async (typed: string) => {
      let queries = 0
      const original = h.sqlite.query.bind(h.sqlite)
      h.sqlite.query = ((sql: string) => {
        queries += 1
        return original(sql)
      }) as never
      const before = verifies
      const id = await flowIdOf(await identify(h, typed))
      await answerFlow(h, id, 'not the password at all')
      h.sqlite.query = original as never
      return { queries, hashes: verifies - before }
    }
    await measure('warm-up') // the hourly prune of the throttle runs once
    const known = await measure('ana')
    const unknown = await measure('nobody')
    expect(unknown).toEqual(known)
    expect(known.hashes).toBe(1)
  })

  test('medians over many calls stay close (generous bound, not an absolute number)', async () => {
    const h = await seeded()
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
    const time = async (typed: string, peerIp: string) => {
      const peer = { via: 'tcp' as const, ip: peerIp, forwarded: false }
      const id = await flowIdOf(await identify(h, typed, peer))
      const start = performance.now()
      await answerFlow(h, id, 'not the password at all', peer)
      return performance.now() - start
    }
    const known: number[] = []
    const unknown: number[] = []
    for (let i = 0; i < 9; i += 1) {
      // a fresh address each round keeps the per-address wait out of the way
      known.push(await time('ana', `127.0.${i}.1`))
      unknown.push(await time('ghost', `127.0.${i}.2`))
    }
    const a = median(known)
    const b = median(unknown)
    expect(Math.abs(a - b)).toBeLessThan(Math.max(25, Math.max(a, b)))
  })

  test('unknown, expired and foreign flows are the same 404; a flow is single-use after success', async () => {
    const h = await seeded()
    expect((await answerFlow(h, 'a'.repeat(24), PASS('ana'))).status).toBe(404)
    expect((await answerFlow(h, 'short', PASS('ana'))).status).toBe(404)
    const id = await flowIdOf(await identify(h, 'ana'))
    const other = { via: 'tcp' as const, ip: '127.0.0.9', forwarded: false }
    expect((await answerFlow(h, id, PASS('ana'), other)).status).toBe(404)
    h.clock.t += 5 * 60_000 + 1
    expect((await answerFlow(h, id, PASS('ana'))).status).toBe(404)
    const fresh = await flowIdOf(await identify(h, 'ana'))
    expect((await answerFlow(h, fresh, PASS('ana'))).status).toBe(200)
    expect((await answerFlow(h, fresh, PASS('ana'))).status).toBe(404)
  })

  test('a flow is dropped after five wrong answers', async () => {
    const h = await seeded()
    const id = await flowIdOf(await identify(h, 'ana'))
    for (let i = 0; i < 4; i += 1)
      expect((await answerFlow(h, id, 'wrong wrong wrong')).status).toBe(401)
    expect((await answerFlow(h, id, 'wrong wrong wrong')).status).toBe(401)
    expect((await answerFlow(h, id, PASS('ana'))).status).toBe(404)
  })

  test('the password is refused from a far address, with the same 403 for any identity', async () => {
    const h = await seeded()
    const far = { via: 'tcp' as const, ip: '8.8.8.8', forwarded: false }
    const outcomes: string[] = []
    for (const typed of ['ana', 'nobody']) {
      const res = await answerFlow(
        h,
        await flowIdOf(await identify(h, typed, far)),
        PASS('ana'),
        far,
      )
      outcomes.push(`${res.status} ${await res.text()}`)
    }
    expect(outcomes).toEqual([
      '403 {"error":"login_not_allowed_here"}',
      '403 {"error":"login_not_allowed_here"}',
    ])
  })

  test('device and token are not flow answers; no secret reaches the audit log', async () => {
    const h = await seeded()
    const id = await flowIdOf(await identify(h, 'ana'))
    expect((await answerFlow(h, id, 'x', LOOP, 'token')).status).toBe(400)
    expect((await answerFlow(h, id, 'x', LOOP, 'nope')).status).toBe(400)
    await answerFlow(h, id, 'a wrong secret value')
    const text = JSON.stringify(h.events())
    expect(text).not.toContain('a wrong secret value')
    expect(text).not.toContain('Ana@Example.com')
    expect(text.toLowerCase()).not.toContain('ana@example.com')
  })
})

describe('aliases', () => {
  test('normalise, refuse a taken value or a username, and go with the person', async () => {
    const h = await seeded()
    await member(h, 'bob')
    await expect(h.aliases.add('bob', 'email', 'ana@example.com', caller)).rejects.toThrow(
      'already',
    )
    await expect(h.aliases.add('bob', 'email', 'ana', caller)).rejects.toThrow()
    await expect(h.aliases.add('bob', 'email', 'bob', caller)).rejects.toThrow()
    await expect(h.aliases.add('bob', 'phone', '12', caller)).rejects.toThrow()
    expect((await h.aliases.list('ana')).map((a) => a.value)).toEqual([
      '+6281234567890',
      'ana@example.com',
    ])
    await h.aliases.remove('ANA@example.com', caller)
    await expect(h.aliases.remove('ana@example.com', caller)).rejects.toThrow('no such alias')
    await h.people.remove('ana', caller)
    expect(h.identifiers.list('ana')).toEqual([])
    expect(h.events('person.alias.add').length).toBeGreaterThan(0)
  })
})

describe('a stored policy narrows by role and identifier kind at verify, never in the list', () => {
  const policyOf = (rule: Record<string, unknown>) =>
    AuthPolicySchema.parse({ rules: [{ method: 'password', zones: ['loopback'], ...rule }] })

  test('role: a member gets the uniform 401 after the same hash work; the list is unchanged', async () => {
    const h = harness({ policy: () => policyOf({ roles: ['owner'] }) })
    await member(h, 'ana')
    const listed = IdentifyResponseSchema.parse(await (await identify(h, 'ana')).json())
    expect(listed.methods.find((m) => m.id === 'password')?.available).toBe(true)
    const res = await answerFlow(h, listed.flowId, PASS('ana'))
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('{"error":"invalid_credentials"}')
    const ghost = await answerFlow(h, await flowIdOf(await identify(h, 'ghost')), PASS('ana'))
    expect(await ghost.text()).toBe('{"error":"invalid_credentials"}')
  })

  test('identifier kind: a username is refused where only an email is allowed', async () => {
    const h = harness({ policy: () => policyOf({ identifierKinds: ['email'] }) })
    await member(h, 'ana')
    await h.aliases.add('ana', 'email', 'ana@example.com', caller)
    expect(
      (await answerFlow(h, await flowIdOf(await identify(h, 'ana')), PASS('ana'))).status,
    ).toBe(401)
    expect(
      (await answerFlow(h, await flowIdOf(await identify(h, 'ana@example.com')), PASS('ana')))
        .status,
    ).toBe(200)
  })
})
