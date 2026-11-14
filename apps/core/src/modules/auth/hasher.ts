/**
 * Argon2id for passwords and PINs (docs/specs/auth.md). The cost is pinned (`memoryCost: 65536`
 * KiB = 64 MiB, `timeCost: 2`) and a global semaphore keeps at most two hashes or verifies running,
 * so a flood of logins cannot exhaust memory: the rest queue and give up after five seconds.
 */

/** Pinned argon2id parameters (OWASP's second option; ~80 ms on a laptop). */
export const ARGON2 = { algorithm: 'argon2id', memoryCost: 65_536, timeCost: 2 } as const
/** At most this many hashes or verifies run at once. */
export const MAX_CONCURRENT_HASHES = 2
/** A caller waits at most this long for a slot. */
export const HASH_QUEUE_TIMEOUT_MS = 5000

/** No slot became free in time: the route answers a uniform 503. */
export class HasherBusyError extends Error {
  constructor() {
    super('too many password checks at once')
    this.name = 'HasherBusyError'
  }
}

export interface HasherOptions {
  /** Test only: a cheaper cost. Production uses {@link ARGON2}. */
  memoryCost?: number
  timeCost?: number
  concurrency?: number
  queueTimeoutMs?: number
  /** Test only: replaces `Bun.password` (to count concurrency without real hashing). */
  engine?: {
    hash(secret: string, params: typeof ARGON2 | HashParams): Promise<string>
    verify(secret: string, phc: string): Promise<boolean>
  }
}

interface HashParams {
  algorithm: 'argon2id'
  memoryCost: number
  timeCost: number
}

export interface Hasher {
  /** A PHC string (`$argon2id$v=19$m=65536,t=2,p=1$...`). */
  hash(secret: string): Promise<string>
  /**
   * Whether `secret` matches `phc`. With `phc` undefined it verifies against a dummy hash of the
   * same cost and answers false, so an unknown account costs the same time as a wrong password.
   */
  verify(secret: string, phc: string | undefined): Promise<boolean>
}

/** NFKC, so the same password typed on two keyboards hashes the same. */
export const normalizeSecret = (text: string): string => text.normalize('NFKC')

export function createHasher(options: HasherOptions = {}): Hasher {
  const params = {
    algorithm: ARGON2.algorithm,
    memoryCost: options.memoryCost ?? ARGON2.memoryCost,
    timeCost: options.timeCost ?? ARGON2.timeCost,
  }
  const engine = options.engine ?? Bun.password
  const limit = options.concurrency ?? MAX_CONCURRENT_HASHES
  const timeoutMs = options.queueTimeoutMs ?? HASH_QUEUE_TIMEOUT_MS
  let active = 0
  const waiting: Array<{ go: () => void; timer: ReturnType<typeof setTimeout> }> = []

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry = {
        go: () => {
          clearTimeout(entry.timer)
          resolve()
        },
        timer: setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1)
          reject(new HasherBusyError())
        }, timeoutMs),
      }
      waiting.push(entry)
    })
  }
  const release = (): void => {
    const next = waiting.shift()
    if (next === undefined) active--
    else next.go() // the slot passes straight to the next waiter
  }
  const limited = async <T>(run: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await run()
    } finally {
      release()
    }
  }

  let dummy: Promise<string> | undefined
  const dummyHash = (): Promise<string> => {
    dummy ??= limited(() => engine.hash(crypto.randomUUID(), params))
    return dummy
  }
  return {
    hash: (secret) => limited(() => engine.hash(normalizeSecret(secret), params)),
    async verify(secret, phc) {
      const stored = phc ?? (await dummyHash())
      const ok = await limited(async () => {
        try {
          return await engine.verify(normalizeSecret(secret), stored)
        } catch {
          return false // a malformed stored hash never matches
        }
      })
      return phc !== undefined && ok
    },
  }
}
