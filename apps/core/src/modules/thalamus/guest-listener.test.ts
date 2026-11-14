import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { networkInterfaces } from 'node:os'
import { scriptedProvider } from 'eharness/testing'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { createGuestListener, type GuestListener } from './guest-listener.ts'

let booted: BootedCore
let listener: GuestListener
beforeAll(async () => {
  booted = await bootCore(
    {},
    {
      definitions: [
        scriptedProvider({
          id: 'pricey',
          models: { cheap: [{ text: 'ok' }] },
          info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
        }),
      ],
    },
  )
  await booted.local.rpc.providers.put({ providerId: 'pricey' })
  await booted.local.rpc.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
  listener = createGuestListener({ http: booted.core.guestHttp, port: 0, pollMs: 0 })
})
afterAll(async () => {
  await listener.stop()
  await booted.stop()
})

const refused = async (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/health`).then(
    () => false,
    () => true,
  )

describe('the guest listener', () => {
  test('there is no listener while guests are off; it opens with enable and closes with the kill switch', async () => {
    listener.reconcile()
    expect(listener.port()).toBeUndefined()
    await booted.local.rpc.admin.guests.set({ enabled: true, zones: ['loopback', 'lan'] })
    listener.reconcile()
    const port = listener.port() as number
    expect(port).toBeGreaterThan(0)
    // a real socket: the peer is 127.0.0.1 (loopback zone), the Host carries the real port
    const status = await fetch(`http://127.0.0.1:${port}/guest/status`)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ enabled: true, available: true })
    expect(
      (await fetch(`http://127.0.0.1:${port}/rpc/health/get`, { method: 'POST' })).status,
    ).toBe(404)
    expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200)
    // a Host that is not this listener's is refused before the app runs
    const rebind = await fetch(`http://127.0.0.1:${port}/guest/status`, {
      headers: { host: `rebind.evil.example:${port}` },
    })
    expect(rebind.status).toBe(421)

    await booted.local.rpc.admin.guests.killswitch({ on: true })
    listener.reconcile()
    expect(listener.port()).toBeUndefined()
    expect(await refused(port)).toBe(true)
  })

  test("a visitor that types this machine's LAN address is served (Host is that address, the peer is on the LAN)", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find(
        (i) =>
          i !== undefined &&
          i.family === 'IPv4' &&
          !i.internal &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address),
      )
    if (lan === undefined) return // no private IPv4 interface here: nothing to dial
    await booted.local.rpc.admin.guests.set({ enabled: true, zones: ['lan'] })
    listener.reconcile()
    const port = listener.port() as number
    const res = await fetch(`http://${lan.address}:${port}/guest/status`)
    expect(res.status).toBe(200)
    // dialling our own LAN address makes the peer that address: zone `lan` is allowed, so guests are on
    expect(await res.json()).toMatchObject({ enabled: true })
    // and a loopback peer is not in the allowed zones now
    const loop = await fetch(`http://127.0.0.1:${port}/guest/status`)
    expect(await loop.json()).toMatchObject({ enabled: false })
  })

  test('GET /guest/status is rate limited per address: the 31st poll in a minute is a generic 429', async () => {
    await booted.local.rpc.admin.guests.set({ enabled: true, zones: ['loopback'] })
    listener.reconcile()
    const port = listener.port() as number
    const url = `http://127.0.0.1:${port}/guest/status`
    // earlier tests of this file polled too: count until the first refusal, which is within the window's 30
    let calls = 0
    let res = await fetch(url)
    while (res.status === 200 && calls < 40) {
      calls++
      res = await fetch(url)
    }
    expect(calls).toBeLessThanOrEqual(30)
    const limited = res
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).not.toBeNull()
    expect(await limited.text()).not.toContain('loopback')
    // the start window is its own bucket: a status poll does not spend the starts
    expect(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status)).toBe(200)
  })

  test('behind a trusted proxy each visitor (by X-Forwarded-For) has its own status window', async () => {
    await booted.local.rpc.admin.guests.set({
      enabled: true,
      zones: ['loopback'],
      trustedProxy: 'x-forwarded-for',
      proxyAddrs: ['127.0.0.1'],
    })
    listener.reconcile()
    const port = listener.port() as number
    const url = `http://127.0.0.1:${port}/guest/status`
    const poll = (visitor: string) => fetch(url, { headers: { 'x-forwarded-for': visitor } })
    // visitor A uses up its window (the first 30 that are not refused), visitor B starts with a fresh one
    let refusedA = false
    for (let i = 0; i < 35 && !refusedA; i++) refusedA = (await poll('198.51.100.1')).status === 429
    expect(refusedA).toBe(true)
    expect((await poll('198.51.100.2')).status).toBe(200)
    await booted.local.rpc.admin.guests.set({ trustedProxy: 'none', proxyAddrs: [] })
  })

  test('a port that cannot be opened is logged once and does not take anything down', async () => {
    const warnings: string[] = []
    let tries = 0
    const second = createGuestListener({
      http: booted.core.guestHttp,
      pollMs: 0,
      serve: () => {
        tries += 1
        throw new Error('EADDRINUSE')
      },
      log: { info: () => undefined, warn: (m) => warnings.push(m) },
    })
    await booted.local.rpc.admin.guests.set({ enabled: true, zones: ['loopback'] })
    second.reconcile()
    second.reconcile()
    expect(second.port()).toBeUndefined()
    expect(tries).toBe(1)
    expect(warnings).toHaveLength(1)
    await second.stop()
  })
})
