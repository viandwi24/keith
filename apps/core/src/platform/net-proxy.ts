/**
 * The core's outbound fetch for public resources (docs/specs/net-proxy.md). Any part of the core that pulls a public file from the
 * internet on a person's behalf goes through it, so every such request carries Keith's User-Agent, at most `perHost` requests reach one
 * host at a time, answers are kept in a disk cache for their max-age, and a stale copy covers an upstream failure. The first user is
 * the plugin net route (`/plugins/<id>/net/*`, thalamus), which serves map tiles to sandboxed plugin pages.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type NetFetch = (url: string, init: RequestInit) => Promise<Response>

export interface NetProxyOptions {
  /** Where cached answers live (`<dataDir>/cache/net`): never carried by a backup. */
  cacheDir: string
  /** Sent on every upstream request, e.g. `keith/0.3.0 (self-hosted personal agent)`. */
  userAgent: string
  fetch?: NetFetch
  now?: () => number
  /** Requests in flight to one host at once (OSM's tile policy asks for at most 2). Default 2. */
  perHost?: number
  /** Requests waiting for one host before new ones are refused with 503. Default 64. */
  queue?: number
  /** Largest answer kept or relayed. Default 4 MiB. */
  maxBytes?: number
  /** How long an answer without a max-age is fresh. Default 7 days. */
  defaultTtlMs?: number
  /** Upstream timeout. Default 15 s. */
  timeoutMs?: number
  /** The cache is pruned (oldest first) back under this size. Default 256 MiB. */
  maxCacheBytes?: number
}

export type NetResult =
  | { ok: true; body: Uint8Array; type: string; from: 'cache' | 'upstream' | 'stale' }
  | { ok: false; status: 400 | 404 | 413 | 415 | 502 | 503 | 504; reason: string }

export interface NetProxy {
  /**
   * GET a public https `url` whose answer type is one of `accept` (exact media types, parameters ignored). Never follows a redirect
   * (an answer must come from the host that was asked) and never sends a cookie or credential.
   */
  get(url: string, accept: readonly string[], options?: GetOptions): Promise<NetResult>
}

export interface GetOptions {
  /**
   * A live resource (a traffic camera's latest frame): kept this long at most, below the usual one-hour floor, and still served stale
   * when the upstream fails.
   */
  liveMs?: number
  /**
   * Names the type of an answer that came untyped (`application/octet-stream` or no type) from its bytes; the answer is kept only
   * when the name is one of `accept`. A host that serves images as octet-stream (Singapore's traffic cameras) still works.
   */
  sniff?: (body: Uint8Array) => string | undefined
}

interface Meta {
  url: string
  type: string
  expires: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The fresh life of an answer: its `max-age` clamped to [1 h, 30 d], `no-store` = 0, else the default. */
export function freshFor(cacheControl: string | null, fallback: number): number {
  if (cacheControl === null) return fallback
  if (/(^|,)\s*no-store\s*(,|$)/i.test(cacheControl)) return 0
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl)
  if (m === null) return fallback
  return Math.min(30 * DAY, Math.max(HOUR, Number(m[1]) * 1000))
}

const mediaType = (value: string | null): string =>
  (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

/** A queue that lets `limit` tasks per key run at once and refuses past `waiting`. */
function gate(limit: number, waiting: number) {
  const lanes = new Map<string, { running: number; queue: (() => void)[] }>()
  return async <T>(key: string, task: () => Promise<T>): Promise<T | 'busy'> => {
    let lane = lanes.get(key)
    if (lane === undefined) {
      lane = { running: 0, queue: [] }
      lanes.set(key, lane)
    }
    const l = lane
    if (l.running >= limit) {
      if (l.queue.length >= waiting) return 'busy'
      await new Promise<void>((go) => l.queue.push(go))
    }
    l.running++
    try {
      return await task()
    } finally {
      l.running--
      const next = l.queue.shift()
      if (next !== undefined) next()
      else if (l.running === 0) lanes.delete(key)
    }
  }
}

/** Reads a body up to `max` bytes; undefined when it is larger. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | undefined> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > max) return undefined
  if (res.body === null) return new Uint8Array()
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > max) return undefined
    parts.push(chunk)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

export function createNetProxy(options: NetProxyOptions): NetProxy {
  const fetchImpl: NetFetch = options.fetch ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024
  const ttl = options.defaultTtlMs ?? 7 * DAY
  const timeout = options.timeoutMs ?? 15_000
  const maxCache = options.maxCacheBytes ?? 256 * 1024 * 1024
  const run = gate(options.perHost ?? 2, options.queue ?? 64)
  let writes = 0

  const pathsOf = (url: string) => {
    const hex = createHash('sha256').update(url).digest('hex')
    const dir = join(options.cacheDir, hex.slice(0, 2))
    return { dir, body: join(dir, hex), meta: join(dir, `${hex}.json`) }
  }

  const readCache = async (url: string) => {
    const p = pathsOf(url)
    try {
      const meta = (await Bun.file(p.meta).json()) as Meta
      if (meta.url !== url) return undefined
      return { meta, body: new Uint8Array(await Bun.file(p.body).arrayBuffer()) }
    } catch {
      return undefined
    }
  }

  const writeCache = async (meta: Meta, body: Uint8Array) => {
    const p = pathsOf(meta.url)
    try {
      await mkdir(p.dir, { recursive: true, mode: 0o700 })
      // body first, then the meta that points at it, each through a temp name: a reader never sees half a file
      await Bun.write(`${p.body}.tmp`, body)
      await rename(`${p.body}.tmp`, p.body)
      await Bun.write(`${p.meta}.tmp`, JSON.stringify(meta))
      await rename(`${p.meta}.tmp`, p.meta)
    } catch {
      return
    }
    if (++writes % 200 === 0) void prune()
  }

  /** Oldest files out until the cache fits `maxCacheBytes`. */
  const prune = async () => {
    try {
      const files: { path: string; size: number; mtime: number }[] = []
      for (const sub of await readdir(options.cacheDir)) {
        const dir = join(options.cacheDir, sub)
        for (const name of await readdir(dir)) {
          const path = join(dir, name)
          const s = await stat(path)
          files.push({ path, size: s.size, mtime: s.mtimeMs })
        }
      }
      let total = files.reduce((sum, f) => sum + f.size, 0)
      files.sort((a, b) => a.mtime - b.mtime)
      for (const f of files) {
        if (total <= maxCache) break
        await rm(f.path, { force: true })
        total -= f.size
      }
    } catch {
      // a prune that fails leaves the cache as it was; the next one tries again
    }
  }

  return {
    async get(url, accept, getOptions = {}) {
      let host: string
      try {
        const u = new URL(url)
        if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') throw new Error()
        host = u.host
      } catch {
        return { ok: false, status: 400, reason: 'not a public https url' }
      }
      const cached = await readCache(url)
      if (cached !== undefined && cached.meta.expires > now())
        return { ok: true, body: cached.body, type: cached.meta.type, from: 'cache' }
      const stale = (status: 502 | 503 | 504, reason: string): NetResult =>
        cached !== undefined
          ? { ok: true, body: cached.body, type: cached.meta.type, from: 'stale' }
          : { ok: false, status, reason }

      const answer = await run(host, async (): Promise<NetResult> => {
        let res: Response
        try {
          res = await fetchImpl(url, {
            method: 'GET',
            redirect: 'error',
            credentials: 'omit',
            headers: { 'user-agent': options.userAgent, accept: accept.join(', ') },
            signal: AbortSignal.timeout(timeout),
          })
        } catch (e) {
          const timedOut = e instanceof Error && e.name === 'TimeoutError'
          return stale(
            timedOut ? 504 : 502,
            timedOut ? 'upstream timed out' : 'upstream unreachable',
          )
        }
        if (res.status === 404 || res.status === 410)
          return { ok: false, status: 404, reason: 'not found upstream' }
        if (!res.ok) return stale(502, `upstream answered ${res.status}`)
        const sent = mediaType(res.headers.get('content-type'))
        const untyped = sent === '' || sent === 'application/octet-stream'
        if (!accept.includes(sent) && !(untyped && getOptions.sniff !== undefined))
          return { ok: false, status: 415, reason: `upstream sent ${sent || 'no type'}` }
        const body = await readCapped(res, maxBytes)
        if (body === undefined)
          return { ok: false, status: 413, reason: 'upstream answer too large' }
        const type = accept.includes(sent) ? sent : (getOptions.sniff?.(body) ?? '')
        if (!accept.includes(type))
          return { ok: false, status: 415, reason: `upstream sent ${sent || 'no type'}` }
        const usual = freshFor(res.headers.get('cache-control'), ttl)
        const life =
          getOptions.liveMs === undefined
            ? usual
            : Math.min(usual, Math.max(1_000, getOptions.liveMs))
        if (life > 0) await writeCache({ url, type, expires: now() + life }, body)
        return { ok: true, body, type, from: 'upstream' }
      })
      return answer === 'busy' ? stale(503, 'too many requests to this host') : answer
    },
  }
}
