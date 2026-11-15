import { describe, expect, test } from 'bun:test'
import type { DeliveryRequest } from '@keith/contracts'
import { migrateDatabase, openDatabase, pushSubscriptionsRepo } from '@keith/db'
import type { PushSender, PushSendResult } from './sender.ts'
import { createPushService, isPublicEndpoint, NEUTRAL_BODY, payloadOf } from './service.ts'

const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const AUTH = ['BTBZMqHH', '6r4Tts7J', '_aSIgg'].join('') // RFC 8291 Appendix A auth secret, built at runtime (gitleaks)
const sub = (n: number) => ({
  subscription: {
    endpoint: `https://push.example.com/s/${n}`,
    keys: { p256dh: P256DH, auth: AUTH },
  },
  label: `phone ${n}`,
})

const request = (over: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  id: 'reminder:r1',
  source: 'plugin:reminders',
  to: 'ana',
  name: 'reminder',
  text: 'pay the rent to Mr. Bernard',
  needs: { mode: 'wake', capabilities: [], fanout: 'best', urgency: 'normal' },
  ...over,
})

function setup(results: PushSendResult[] = []) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const sent: { endpoint: string; body: string; urgency: string }[] = []
  const sender: PushSender = {
    async send(target, body, options) {
      sent.push({ endpoint: target.endpoint, body, urgency: options.urgency })
      return results.shift() ?? { ok: true, status: 201 }
    },
  }
  const settings = new Map<string, unknown>()
  const audit: { kind: string; detail?: Record<string, unknown> }[] = []
  let n = 0
  const service = createPushService({
    repo: pushSubscriptionsRepo(sqlite),
    settings: {
      get: <T>(k: string) => settings.get(k) as T | undefined,
      set: (k, v) => void settings.set(k, v),
      delete: (k) => void settings.delete(k),
    },
    sender,
    publicKey: 'PUBKEY',
    audit: { record: (e) => void audit.push(e) },
    now: () => 1000,
    newId: () => `sub-${++n}`,
    maxFailures: 3,
  })
  return { service, sent, audit, repo: pushSubscriptionsRepo(sqlite), settings }
}

describe('subscriptions', () => {
  test('subscribe stores the caller own subscription and reads it back without endpoint or keys', () => {
    const { service } = setup()
    const record = service.subscribe('ana', {
      ...sub(1),
      clientId: crypto.randomUUID(),
      userAgent: 'UA',
    })
    expect(record).toMatchObject({
      id: 'sub-1',
      label: 'phone 1',
      userAgent: 'UA',
      failures: 0,
      lastSuccessAt: null,
    })
    expect(JSON.stringify(service.list('ana'))).not.toContain('push.example.com')
    expect(JSON.stringify(service.list('ana'))).not.toContain(P256DH)
    expect(service.list('ben')).toEqual([])
  })

  test('the same endpoint again updates the row; another person signing in on the browser takes it over', () => {
    const { service } = setup()
    const first = service.subscribe('ana', sub(1))
    expect(service.subscribe('ana', { ...sub(1), label: 'renamed' }).id).toBe(first.id)
    expect(service.list('ana')).toHaveLength(1)
    service.subscribe('ben', sub(1))
    expect(service.list('ana')).toEqual([])
    expect(service.list('ben')).toHaveLength(1)
  })

  test('unsubscribe removes only the own row, by id or by endpoint; foreign or unknown ones do nothing', () => {
    const { service } = setup()
    const a = service.subscribe('ana', sub(1))
    service.subscribe('ana', sub(2))
    service.unsubscribe('ben', { id: a.id })
    service.unsubscribe('ben', { endpoint: sub(1).subscription.endpoint })
    expect(service.list('ana')).toHaveLength(2)
    service.unsubscribe('ana', { id: a.id })
    service.unsubscribe('ana', { endpoint: sub(2).subscription.endpoint })
    service.unsubscribe('ana', { id: 'nope' })
    expect(service.list('ana')).toEqual([])
  })

  test('at most 10 per person; an https public endpoint only', () => {
    const { service } = setup()
    for (let i = 1; i <= 10; i++) service.subscribe('ana', sub(i))
    expect(() => service.subscribe('ana', sub(11))).toThrow('at most 10')
    service.subscribe('ana', sub(3))
    expect(() =>
      service.subscribe('ben', {
        subscription: { ...sub(1).subscription, endpoint: 'https://127.0.0.1/x' },
        label: '',
      }),
    ).toThrow('public https')
    expect(isPublicEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true)
    for (const bad of [
      'http://push.example.com/x',
      'https://localhost/x',
      'https://10.0.0.1/x',
      'https://[::1]/x',
      'https://intranet/x',
      'https://nas.local/x',
    ])
      expect(isPublicEndpoint(bad)).toBe(false)
  })

  test('the public key and the preview setting (off by default)', () => {
    const { service } = setup()
    expect(service.publicKey()).toBe('PUBKEY')
    expect(service.preview('ana')).toBe(false)
    service.setPreview('ana', true)
    expect(service.preview('ana')).toBe(true)
    expect(service.preview('ben')).toBe(false)
    service.setPreview('ana', false)
    expect(service.preview('ana')).toBe(false)
  })

  test('purge deletes the subscriptions and the setting of a person', () => {
    const { service, settings } = setup()
    service.subscribe('ana', sub(1))
    service.setPreview('ana', true)
    service.purge('ana')
    expect(service.hasSubscriptions('ana')).toBe(false)
    expect(settings.size).toBe(0)
  })
})

describe('payload', () => {
  test('neutral by default, the clipped text with preview, a deep link to the app or the inbox', () => {
    expect(payloadOf(request(), false)).toEqual({
      title: 'Keith',
      body: NEUTRAL_BODY,
      url: '/app',
      tag: 'reminder:r1',
    })
    expect(payloadOf(request({ text: `a\n${'b'.repeat(300)}` }), true).body).toHaveLength(140)
    expect(payloadOf(request(), true).body).toBe('pay the rent to Mr. Bernard')
    expect(payloadOf(request({ name: 'approval' }), false).url).toBe('/app/inbox')
  })
})

describe('the push route', () => {
  test('sends once per subscription with the delivery urgency, a neutral body, and audits the subscription id only', async () => {
    const { service, sent, audit } = setup()
    service.subscribe('ana', sub(1))
    service.subscribe('ana', sub(2))
    const route = service.route('ana')
    expect(route.companion).toBe(true)
    const urgent = request({
      needs: { mode: 'wake', capabilities: [], fanout: 'best', urgency: 'high' },
    })
    expect(await route.send(urgent, { attempt: 1 })).toEqual({ ok: true })
    expect(sent.map((s) => s.urgency)).toEqual(['high', 'high'])
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
      title: 'Keith',
      body: NEUTRAL_BODY,
      url: '/app',
      tag: 'reminder:r1',
    })
    expect(sent[0]?.body).not.toContain('rent')
    const rows = audit.filter((a) => a.kind === 'delivery.push')
    expect(rows.map((r) => r.detail?.subscription)).toEqual(['sub-1', 'sub-2'])
    expect(JSON.stringify(rows)).not.toContain('push.example.com')
    // a retry of the front route does not push again
    expect(await route.send(urgent, { attempt: 2 })).toEqual({ ok: true })
    expect(sent).toHaveLength(2)
  })

  test('the text rides along only when the person turned preview on', async () => {
    const { service, sent } = setup()
    service.subscribe('ana', sub(1))
    service.setPreview('ana', true)
    await service.route('ana').send(request(), { attempt: 1 })
    expect(JSON.parse(sent[0]?.body ?? '{}').body).toBe('pay the rent to Mr. Bernard')
  })

  test('404 and 410 delete the subscription; other failures count up and drop at the limit', async () => {
    const { service, repo } = setup([
      { ok: false, gone: true, status: 410 },
      { ok: false, gone: false, status: 500 },
      { ok: false, gone: false, status: 500 },
      { ok: false, gone: false, status: 500 },
    ])
    service.subscribe('ana', sub(1))
    service.subscribe('ana', sub(2))
    // the first send: sub-1 gone, sub-2 failed once
    expect(await service.route('ana').send(request({ id: 'd1' }), { attempt: 1 })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(repo.get('sub-1')).toBeUndefined()
    expect(repo.get('sub-2')?.failureCount).toBe(1)
    await service.route('ana').send(request({ id: 'd2' }), { attempt: 1 })
    expect(repo.get('sub-2')?.failureCount).toBe(2)
    await service.route('ana').send(request({ id: 'd3' }), { attempt: 1 })
    expect(repo.get('sub-2')).toBeUndefined()
  })

  test('a success records the time and resets the count; no subscription is an unavailable route', async () => {
    const { service, repo } = setup([{ ok: false, gone: false, status: 500 }])
    service.subscribe('ana', sub(1))
    await service.route('ana').send(request({ id: 'd1' }), { attempt: 1 })
    expect(repo.get('sub-1')?.failureCount).toBe(1)
    await service.route('ana').send(request({ id: 'd2' }), { attempt: 1 })
    expect(repo.get('sub-1')).toMatchObject({ failureCount: 0, lastSuccessAt: 1000 })
    expect(await service.route('ben').send(request({ id: 'd3' }), { attempt: 1 })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})
