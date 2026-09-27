import type { Clock, IdPrefix, Ids } from './types.ts'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16
const MAX_TIME = 2 ** 48 - 1

export type IdsDeps = {
  clock: Clock
  /** Returns `n` random bytes. Default: `crypto.getRandomValues`. */
  randomBytes?: ((n: number) => Uint8Array) | undefined
}

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) throw new RangeError(`ulid time out of range: ${ms}`)
  let rest = ms
  let out = ''
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD.charAt(rest % 32) + out
    rest = Math.floor(rest / 32)
  }
  return out
}

/** Random part as 16 base32 digits (values 0..31). */
function randomDigits(bytes: Uint8Array): number[] {
  const digits: number[] = []
  for (let i = 0; i < RANDOM_LEN; i++) digits.push((bytes[i] ?? 0) % 32)
  return digits
}

/**
 * Prefixed ULID generator (R-12). Monotonic: ids generated in the same millisecond (or while the
 * clock goes backwards) increment the random part, so they sort in generation order.
 */
export function createIds(deps: IdsDeps): Ids {
  const randomBytes = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)))
  let lastTime = -1
  let lastRandom: number[] = []

  const nextBody = (): string => {
    const now = deps.clock.now()
    if (now > lastTime) {
      lastTime = now
      lastRandom = randomDigits(randomBytes(RANDOM_LEN))
    } else {
      // Same (or earlier) millisecond: increment the random part by one.
      let i = RANDOM_LEN - 1
      while (i >= 0 && lastRandom[i] === 31) {
        lastRandom[i] = 0
        i--
      }
      if (i < 0) {
        lastTime += 1
      } else {
        lastRandom[i] = (lastRandom[i] ?? 0) + 1
      }
    }
    return encodeTime(lastTime) + lastRandom.map((d) => CROCKFORD.charAt(d)).join('')
  }

  return {
    next<P extends IdPrefix>(prefix: P): `${P}_${string}` {
      return `${prefix}_${nextBody()}`
    },
  }
}
