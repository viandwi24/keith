import { describe, expect, test } from 'bun:test'
import { GUEST_BEARER_PREFIX } from '@keith/contracts'
import {
  createBearerStore,
  createIpHasher,
  guestTokenOf,
  newGuestToken,
  TOMBSTONE_MS,
} from './guest-bearer.ts'
import { createStartLimiter } from './guest-limiter.ts'

describe('guest bearer', () => {
  test('a token is keith_g_ plus 43 random characters and never looks like another credential', () => {
    const a = newGuestToken()
    expect(a.startsWith(GUEST_BEARER_PREFIX)).toBe(true)
    expect(a).toHaveLength(GUEST_BEARER_PREFIX.length + 43)
    expect(newGuestToken()).not.toBe(a)
    // not a legacy owner token (`keith_` + 43 characters): the e2e test proves the main listener 401s it
    expect(/^keith_[A-Za-z0-9_-]{43}$/.test(a)).toBe(false)
    const request = (value: string) =>
      new Request('http://x/', { headers: { authorization: value } })
    expect(guestTokenOf(request(`Bearer ${a}`))).toBe(a)
    expect(guestTokenOf(request(`bearer ${a}`))).toBe(a)
    expect(guestTokenOf(request(`Bearer keith_${'a'.repeat(43)}`))).toBeUndefined()
    expect(
      guestTokenOf(request(`Bearer keith_s_${'a'.repeat(12)}_${'b'.repeat(43)}`)),
    ).toBeUndefined()
    expect(guestTokenOf(new Request('http://x/'))).toBeUndefined()
  })

  test('the store binds a token to its session and address, and answers 410 data to the right holder only', () => {
    let at = 1_000
    const store = createBearerStore(() => at)
    const token = newGuestToken()
    store.add('s1', token, 'ipA')
    expect(store.check('s1', token, 'ipA')).toEqual({ ok: true })
    expect(store.check('s1', token, 'ipB')).toEqual({ ok: false, why: 'ip' })
    expect(store.check('s1', newGuestToken(), 'ipA')).toEqual({ ok: false, why: 'token' })
    expect(store.check('nope', token, 'ipA')).toEqual({ ok: false, why: 'unknown' })
    store.end('s1', 'idle')
    expect(store.check('s1', token, 'ipA')).toEqual({ ok: false, why: 'ended', reason: 'idle' })
    expect(store.check('s1', token, 'ipB')).toEqual({ ok: false, why: 'ip' })
    at += TOMBSTONE_MS
    expect(store.check('s1', token, 'ipA')).toEqual({ ok: false, why: 'unknown' })
    expect(store.size).toBe(0)
  })

  test('tombstones are bounded', () => {
    const store = createBearerStore()
    for (let i = 0; i < 1200; i++) {
      store.add(`s${i}`, newGuestToken(), 'ip')
      store.end(`s${i}`, 'closed')
    }
    expect(store.size).toBeLessThanOrEqual(1000)
  })
})

describe('ip hashes', () => {
  test('stable within a day, different across days, never the address', () => {
    let at = Date.UTC(2026, 10, 9, 12)
    const hasher = createIpHasher(() => at)
    const today = hasher.daily('192.168.1.5')
    expect(today).toMatch(/^[0-9a-f]{12}$/)
    expect(hasher.daily('192.168.1.5')).toBe(today)
    expect(hasher.daily('192.168.1.6')).not.toBe(today)
    expect(hasher.bind('192.168.1.5')).toHaveLength(64)
    at += 24 * 3_600_000
    expect(hasher.daily('192.168.1.5')).not.toBe(today)
    expect(hasher.bind('192.168.1.5')).toBe(hasher.bind('192.168.1.5'))
    expect(today).not.toContain('192')
    // another process (another key) cannot be linked
    expect(createIpHasher(() => at).bind('192.168.1.5')).not.toBe(hasher.bind('192.168.1.5'))
  })
})

describe('start limiter', () => {
  test('N per window per key, then the window slides', () => {
    let at = 0
    let max = 2
    const limiter = createStartLimiter({ max: () => max, windowMs: 1000, now: () => at })
    expect(limiter.take('a').allowed).toBe(true)
    expect(limiter.take('a').allowed).toBe(true)
    const third = limiter.take('a')
    expect(third.allowed).toBe(false)
    if (!third.allowed) expect(third.retryAfterMs).toBeGreaterThanOrEqual(1000)
    expect(limiter.take('b').allowed).toBe(true)
    at += 1001
    expect(limiter.take('a').allowed).toBe(true)
    max = 1
    expect(limiter.take('a').allowed).toBe(false)
    limiter.sweep()
    at += 5000
    limiter.sweep()
    expect(limiter.size).toBe(0)
  })
})
