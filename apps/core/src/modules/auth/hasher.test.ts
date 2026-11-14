import { describe, expect, test } from 'bun:test'
import { ARGON2, createHasher, HasherBusyError, MAX_CONCURRENT_HASHES } from './hasher.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A secret assembled at runtime (scanners flag key-shaped literals). */
const secret = (n: string) => `test-secret-${n}-${'x'.repeat(8)}`

describe('hasher', () => {
  test('the real cost is pinned in the PHC string: argon2id, 64 MiB, 2 passes', async () => {
    expect(ARGON2).toEqual({ algorithm: 'argon2id', memoryCost: 65_536, timeCost: 2 })
    const hasher = createHasher()
    const phc = await hasher.hash(secret('a'))
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=65536,t=2,p=\d+\$/)
    expect(await hasher.verify(secret('a'), phc)).toBe(true)
    expect(await hasher.verify(secret('b'), phc)).toBe(false)
  })

  test('a cheaper test cost still produces argon2id and verifies', async () => {
    const hasher = createHasher({ memoryCost: 1024, timeCost: 1 })
    const phc = await hasher.hash(secret('c'))
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,/)
    expect(await hasher.verify(secret('c'), phc)).toBe(true)
  })

  test('no stored hash verifies against a dummy and is always false', async () => {
    const hasher = createHasher({ memoryCost: 1024, timeCost: 1 })
    expect(await hasher.verify(secret('d'), undefined)).toBe(false)
    expect(await hasher.verify(secret('d'), 'not a phc string')).toBe(false)
  })

  test('the same password in two unicode forms matches (NFKC)', async () => {
    const hasher = createHasher({ memoryCost: 1024, timeCost: 1 })
    const phc = await hasher.hash('café long enough passphrase')
    expect(await hasher.verify('café long enough passphrase', phc)).toBe(true)
  })

  test('at most two hashes run at once; the rest queue', async () => {
    expect(MAX_CONCURRENT_HASHES).toBe(2)
    let active = 0
    let peak = 0
    const hasher = createHasher({
      engine: {
        async hash() {
          active++
          peak = Math.max(peak, active)
          await sleep(25)
          active--
          return 'h'
        },
        verify: async () => true,
      },
    })
    await Promise.all(Array.from({ length: 7 }, (_, i) => hasher.hash(secret(String(i)))))
    expect(peak).toBe(2)
  })

  test('a caller that waits too long gets HasherBusyError', async () => {
    const hasher = createHasher({
      concurrency: 1,
      queueTimeoutMs: 20,
      engine: {
        hash: async () => {
          await sleep(120)
          return 'h'
        },
        verify: async () => true,
      },
    })
    const first = hasher.hash(secret('1'))
    const second = hasher.hash(secret('2'))
    await expect(second).rejects.toBeInstanceOf(HasherBusyError)
    expect(await first).toBe('h')
    // the slot is free again
    expect(await hasher.hash(secret('3'))).toBe('h')
  })
})
