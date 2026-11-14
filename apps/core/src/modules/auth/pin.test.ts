import { afterEach, describe, expect, test } from 'bun:test'
import { IdentifyResponseSchema } from '@keith/contracts'
import {
  caller,
  cleanup,
  harness,
  LOOP,
  member,
  PASS,
  PIN,
  post,
} from '../../testing/auth-harness.ts'
import { PIN_ABSOLUTE_MS, PIN_IDLE_MS } from './policy.ts'
import type { LanNets } from './zone.ts'

afterEach(cleanup)

type H = ReturnType<typeof harness>
const LAN = { via: 'tcp' as const, ip: '192.168.1.20', forwarded: false }
const lanOf = (): LanNets => ({ contains: (ip) => ip?.startsWith('192.168.1.') === true })
const peerAt = (ip: string) => ({ via: 'tcp' as const, ip, forwarded: false })

const identify = async (h: H, identifier: string, peer = LOOP) =>
  IdentifyResponseSchema.parse(await (await h.routes.identify(post({ identifier }), peer)).json())
const pinAnswer = async (h: H, identifier: string, pin: string, peer = LOOP) => {
  const { flowId } = await identify(h, identifier, peer)
  return h.routes.flow(post({ method: 'pin', answer: { pin } }), peer, flowId)
}
const passwordAnswer = async (h: H, identifier: string, password: string, peer = LOOP) => {
  const { flowId } = await identify(h, identifier, peer)
  return h.routes.flow(post({ method: 'password', answer: { password } }), peer, flowId)
}
const bearer = (token: string) =>
  new Request('http://localhost/rpc', { headers: { authorization: `Bearer ${token}` } })

async function withPin(options: { insecure?: boolean } = {}) {
  const h = harness(options)
  await member(h, 'ana')
  await h.secrets.setPin('ana', PIN, caller)
  return h
}

describe('PIN sign-in', () => {
  test('starts a session of assurance 1 with the PIN lifetimes, from loopback', async () => {
    const h = await withPin()
    const res = await pinAnswer(h, 'ana', PIN)
    expect(res.status).toBe(200)
    const { credential } = (await res.json()) as { credential: string }
    const who = await h.resolver.resolve(bearer(credential))
    expect(who?.credential).toMatchObject({ kind: 'device', assurance: 1, methods: ['pin'] })
    const row = h.credentials.find(who?.credential?.id as string)
    expect(row?.idleExpiresAt).toBe(h.clock.t + PIN_IDLE_MS)
    expect(row?.absoluteExpiresAt).toBe(h.clock.t + PIN_ABSOLUTE_MS)
    expect(h.events('auth.login.ok').at(0)?.detail).toMatchObject({ method: 'pin' })
    h.clock.t += PIN_IDLE_MS + 1
    expect(await h.resolver.resolve(bearer(credential))).toBeUndefined()
  })

  test('works from the LAN and Tailscale; the password stays refused on the LAN', async () => {
    const h = await withPin()
    h.setLan(lanOf())
    const listed = await identify(h, 'ana', LAN)
    expect(listed.context).toBe('lan')
    expect(listed.methods.map((m) => [m.id, m.available])).toEqual([
      ['device', true],
      ['pin', true],
      ['password', false],
      ['token', true],
    ])
    expect(listed.methods.find((m) => m.default)?.id).toBe('pin')
    expect((await pinAnswer(h, 'ana', PIN, LAN)).status).toBe(200)
    const refused = await passwordAnswer(h, 'ana', PASS('ana'), LAN)
    expect(refused.status).toBe(403)
    const ts = peerAt('100.64.1.2')
    expect((await identify(h, 'ana', ts)).context).toBe('tailscale')
    expect((await pinAnswer(h, 'ana', PIN, ts)).status).toBe(200)
  })

  test('without the LAN wiring a private peer is public: no PIN', async () => {
    const h = await withPin()
    expect((await identify(h, 'ana', LAN)).methods.find((m) => m.id === 'pin')?.available).toBe(
      false,
    )
    expect((await pinAnswer(h, 'ana', PIN, LAN)).status).toBe(403)
  })

  test('never from the public zone, not even with the insecure login flag', async () => {
    const h = await withPin({ insecure: true })
    const far = peerAt('8.8.8.8')
    const listed = await identify(h, 'ana', far)
    expect(listed.context).toBe('public')
    expect(listed.methods.find((m) => m.id === 'pin')?.available).toBe(false)
    expect(listed.methods.find((m) => m.id === 'password')?.available).toBe(true)
    expect((await pinAnswer(h, 'ana', PIN, far)).status).toBe(403)
    // a loopback peer behind a proxy header is public as well
    expect((await pinAnswer(h, 'ana', PIN, { ...LOOP, forwarded: true })).status).toBe(403)
  })

  test('a wrong PIN is the same 401 for a known person, no PIN and an unknown identifier', async () => {
    const h = await withPin()
    await member(h, 'bob') // no PIN
    const seen: string[] = []
    for (const who of ['ana', 'bob', 'ghost']) {
      const res = await pinAnswer(h, who, '000000')
      seen.push(`${res.status} ${await res.text()}`)
    }
    expect(new Set(seen)).toEqual(new Set(['401 {"error":"invalid_credentials"}']))
  })

  test('shares the throttle with the password: wrong PINs delay the password too', async () => {
    const h = await withPin()
    for (let i = 0; i < 5; i += 1) await pinAnswer(h, 'ana', '000000')
    expect((await passwordAnswer(h, 'ana', PASS('ana'))).status).toBe(429)
    expect(
      (await h.routes.login(post({ username: 'ana', password: PASS('ana') }), LOOP)).status,
    ).toBe(429)
  })

  test('the work equals a password answer: same queries for a known and an unknown identifier', async () => {
    const h = await withPin()
    await pinAnswer(h, 'warm-up', '000000')
    const count = async (who: string) => {
      let queries = 0
      const original = h.sqlite.query.bind(h.sqlite)
      h.sqlite.query = ((sql: string) => {
        queries += 1
        return original(sql)
      }) as never
      await pinAnswer(h, who, '000000')
      h.sqlite.query = original as never
      return queries
    }
    expect(await count('ghost')).toBe(await count('ana'))
  })
})

describe('the person-wide delay on the LAN', () => {
  test('failures from one address delay every address on the LAN, never lock the owner, and alert', async () => {
    const h = harness()
    h.setLan(lanOf())
    await h.secrets.setPin('owner', PIN, caller)
    const a = peerAt('192.168.1.21')
    const b = peerAt('192.168.1.22')
    // five failures from several addresses (each below its own free count)
    for (let i = 0; i < 5; i += 1) {
      h.clock.t += 1000
      await pinAnswer(h, 'owner', '000000', peerAt(`192.168.1.${30 + i}`))
    }
    expect(h.events('auth.pin.alert')).toHaveLength(1)
    const delayed = await pinAnswer(h, 'owner', PIN, b)
    expect(delayed.status).toBe(429)
    expect(Number(delayed.headers.get('retry-after'))).toBeGreaterThan(0)
    // the same from the loopback is not delayed by the person-wide rule
    expect((await pinAnswer(h, 'owner', PIN, LOOP)).status).toBe(200)
    // never a lock: after the wait the right PIN signs in from the LAN
    for (let i = 0; i < 30; i += 1) {
      h.clock.t += 1000
      await pinAnswer(h, 'owner', '000000', peerAt(`192.168.2.${i}`))
    }
    h.clock.t += 40_000
    expect((await pinAnswer(h, 'owner', PIN, a)).status).toBe(200)
  })

  test('an unknown identifier is delayed in the same way', async () => {
    const h = harness()
    h.setLan(lanOf())
    for (let i = 0; i < 5; i += 1) {
      h.clock.t += 1000
      await pinAnswer(h, 'ghost', '000000', peerAt(`192.168.1.${30 + i}`))
    }
    const res = await pinAnswer(h, 'ghost', '000000', peerAt('192.168.1.99'))
    expect(res.status).toBe(429)
  })
})

describe('a PIN session cannot step up', () => {
  const stepUp = async (h: H, token: string, body: object) => {
    const request = post(body, { authorization: `Bearer ${token}` })
    return h.routes.stepUp(request, LOOP, await h.resolver.resolve(request))
  }
  const credentialOf = async (res: Response) =>
    ((await res.json()) as { credential: string }).credential

  test('403 for the PIN; a password session is not refused', async () => {
    const h = await withPin()
    const pinSession = await credentialOf(await pinAnswer(h, 'ana', PIN))
    const refused = await stepUp(h, pinSession, { pin: PIN })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'pin_session_cannot_step_up' })
    expect((await h.resolver.resolve(bearer(pinSession)))?.elevated).toBe(false)
    const passwordSession = await credentialOf(await passwordAnswer(h, 'ana', PASS('ana')))
    expect((await stepUp(h, passwordSession, { pin: PIN })).status).toBe(200)
  })

  test('the password confirms on a PIN session and a rotation raises the assurance', async () => {
    const h = await withPin()
    const pinSession = await credentialOf(await pinAnswer(h, 'ana', PIN))
    const res = await stepUp(h, pinSession, { password: PASS('ana'), rotate: true })
    expect(res.status).toBe(200)
    const fresh = await credentialOf(res)
    expect((await h.resolver.resolve(bearer(fresh)))?.credential).toMatchObject({
      assurance: 2,
      methods: ['pin', 'password'],
    })
  })

  test('a device-code or token session still steps up with the PIN, as before', async () => {
    const h = await withPin()
    const person = (await h.people.get('ana')).id
    const { createCredential } = await import('./credentials.ts')
    const made = await createCredential(h.credentials, {
      personId: person,
      kind: 'device',
      label: 'code',
    })
    expect((await stepUp(h, made.token, { pin: PIN })).status).toBe(200)
  })
})

describe('changing a PIN', () => {
  test('ends the sessions the PIN made and keeps the password ones', async () => {
    const h = await withPin()
    const pinSession = ((await (await pinAnswer(h, 'ana', PIN)).json()) as { credential: string })
      .credential
    const passSession = (
      (await (await passwordAnswer(h, 'ana', PASS('ana'))).json()) as { credential: string }
    ).credential
    await h.secrets.setPin('ana', '739104', caller)
    expect(await h.resolver.resolve(bearer(pinSession))).toBeUndefined()
    expect(await h.resolver.resolve(bearer(passSession))).toBeDefined()
    expect((await pinAnswer(h, 'ana', PIN)).status).toBe(401)
    expect((await pinAnswer(h, 'ana', '739104')).status).toBe(200)
  })
})
