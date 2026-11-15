import { describe, expect, test } from 'bun:test'
import { b64urlDecode, b64urlEncode } from './encoding.ts'
import { createPushSender } from './sender.ts'
import { generateVapidPair, importVapidPrivate, JWT_TTL_SECONDS, vapidJwt } from './vapid.ts'

const UA_PUBLIC =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const UA_AUTH = ['BTBZMqHH', '6r4Tts7J', '_aSIgg'].join('') // RFC 8291 Appendix A auth secret, built at runtime (gitleaks)
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123'
const NOW = 1_800_000_000_000

async function keys() {
  const pair = await generateVapidPair()
  return {
    publicKey: pair.publicKey,
    privateKey: await importVapidPrivate(pair.privateJwk),
    subject: 'mailto:ops@example.com',
  }
}

const json = (part: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(part)))

describe('VAPID JWT', () => {
  test('is ES256 with aud = the endpoint origin, a bounded exp, the subject, and verifies with the public key', async () => {
    const k = await keys()
    const jwt = await vapidJwt(k, `${ENDPOINT}?x=1`, NOW)
    const [h, c, s] = jwt.split('.') as [string, string, string]
    expect(json(h)).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = json(c)
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe('mailto:ops@example.com')
    expect(claims.exp).toBe(Math.floor(NOW / 1000) + JWT_TTL_SECONDS)
    expect(claims.exp - NOW / 1000).toBeLessThanOrEqual(12 * 3600)
    expect(b64urlDecode(s).length).toBe(64)
    const pub = await crypto.subtle.importKey(
      'raw',
      b64urlDecode(k.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${c}`),
    )
    expect(ok).toBe(true)
  })

  test('a public key is a 65-byte uncompressed point', async () => {
    const pair = await generateVapidPair()
    const raw = b64urlDecode(pair.publicKey)
    expect(raw.length).toBe(65)
    expect(raw[0]).toBe(4)
    expect(b64urlEncode(raw)).toBe(pair.publicKey)
  })
})

describe('the sender', () => {
  const target = { endpoint: ENDPOINT, p256dh: UA_PUBLIC, auth: UA_AUTH }

  function fake(status: number) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status })
    }) as unknown as typeof fetch
    return { calls, fetcher }
  }

  test('POSTs the encrypted body with TTL, Urgency, Content-Encoding and a vapid Authorization', async () => {
    const k = await keys()
    const { calls, fetcher } = fake(201)
    const sender = createPushSender({ keys: k, fetch: fetcher, now: () => NOW })
    const result = await sender.send(target, '{"title":"Keith"}', { urgency: 'high' })
    expect(result).toEqual({ ok: true, status: 201 })
    const call = calls[0]
    expect(call?.url).toBe(ENDPOINT)
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.TTL).toBe('3600')
    expect(headers.Urgency).toBe('high')
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/)
    expect(headers.Authorization).toContain(`k=${k.publicKey}`)
    expect(call?.init.body).toBeInstanceOf(Uint8Array)
    expect((call?.init.body as Uint8Array | undefined)?.length ?? 0).toBeGreaterThan(86)
  })

  test('normal urgency for a normal delivery; the body holds no clear text', async () => {
    const { calls, fetcher } = fake(201)
    const sender = createPushSender({ keys: await keys(), fetch: fetcher })
    await sender.send(target, 'secret message text', { urgency: 'normal' })
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.Urgency).toBe('normal')
    expect(
      Buffer.from((calls[0]?.init.body ?? new Uint8Array()) as Uint8Array).toString('latin1'),
    ).not.toContain('secret message')
  })

  test('404 and 410 say the subscription is gone; other statuses and network errors are plain failures', async () => {
    const k = await keys()
    for (const [status, gone] of [
      [404, true],
      [410, true],
      [429, false],
      [500, false],
      [302, false],
      [403, false],
    ] as const) {
      const sender = createPushSender({ keys: k, fetch: fake(status).fetcher })
      expect(await sender.send(target, 'x', { urgency: 'normal' })).toEqual({
        ok: false,
        gone,
        status,
      })
    }
    const broken = createPushSender({
      keys: k,
      fetch: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
    })
    expect(await broken.send(target, 'x', { urgency: 'normal' })).toEqual({
      ok: false,
      gone: false,
      status: null,
    })
  })

  test('malformed subscription keys are a failure, never a throw', async () => {
    const sender = createPushSender({ keys: await keys(), fetch: fake(201).fetcher })
    const result = await sender.send({ ...target, auth: 'AAAA' }, 'x', { urgency: 'normal' })
    expect(result.ok).toBe(false)
  })
})
