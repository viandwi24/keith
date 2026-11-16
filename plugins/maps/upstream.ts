// How the maps plugin reaches the free OpenStreetMap services (docs/specs/plugins/maps.md "Upstreams"): a generic User-Agent, a
// timeout, at most one request a second per host (the public instances ask for that), and a fallback to a second service when the
// first one fails.
import { OperationError } from '@keith/host'

/** Names the software only: never a person, an address or an instance. */
export const USER_AGENT = 'keith-maps/0.2 (self-hosted personal agent)'
export const TIMEOUT_MS = 8_000
/** One request a second per host: the usage policy of Nominatim, Photon and the FOSSGIS routing servers. */
export const MIN_GAP_MS = 1_000
/** A call that would wait longer than this for its turn is refused as busy instead. */
const MAX_WAIT_MS = 10_000

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type UpstreamFailure = 'timeout' | 'unreachable' | 'busy' | 'http' | 'unreadable'

/** A failed upstream request; `status` is the HTTP status for `http` and `busy`, `body` the parsed error body when there is one. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamFailure,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(kind)
    this.name = 'UpstreamError'
  }
}

export interface JsonRequest {
  signal: AbortSignal
  timeoutMs?: number
  /** A POST body; its content type goes with it. */
  body?: { text: string; type: string }
}

export interface Upstream {
  json(url: string, request: JsonRequest): Promise<unknown>
  /** A text answer (an XML list), at most 8 MiB. */
  text(url: string, request: JsonRequest): Promise<string>
  /** A binary answer (a GTFS-Realtime feed), at most 8 MiB. */
  bytes(url: string, request: JsonRequest): Promise<Uint8Array>
}

/** The largest text or binary answer read. */
export const MAX_BYTES = 8 * 1024 * 1024

/**
 * `fetch` is injectable for tests; `minGapMs` spaces the requests to one host (0 in tests); `now` and `sleep` drive the spacing.
 */
export function createUpstream(options: {
  fetch: FetchLike
  minGapMs?: number | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Upstream {
  const gap = options.minGapMs ?? MIN_GAP_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const nextAt = new Map<string, number>()

  /** Waits for this host's next free slot and takes it. */
  async function turn(host: string): Promise<void> {
    if (gap <= 0) return
    const t = now()
    const at = Math.max(t, nextAt.get(host) ?? 0)
    if (at - t > MAX_WAIT_MS) throw new UpstreamError('busy')
    nextAt.set(host, at + gap)
    if (at > t) await sleep(at - t)
  }

  /** One request to `url` after this host's turn; transport failures become `UpstreamError`. */
  async function send(url: string, request: JsonRequest, accept: string): Promise<Response> {
    await turn(new URL(url).host)
    try {
      return await options.fetch(url, {
        method: request.body === undefined ? 'GET' : 'POST',
        headers: {
          'user-agent': USER_AGENT,
          accept,
          ...(request.body === undefined ? {} : { 'content-type': request.body.type }),
        },
        body: request.body?.text ?? null,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(request.timeoutMs ?? TIMEOUT_MS),
        ]),
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new UpstreamError(timedOut ? 'timeout' : 'unreachable')
    }
  }

  /** The answer's body as bytes, at most `MAX_BYTES`; an error status or a larger body throws. */
  async function body(response: Response): Promise<Uint8Array> {
    if (response.status === 429) throw new UpstreamError('busy', 429)
    if (!response.ok) throw new UpstreamError('http', response.status)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_BYTES) throw new UpstreamError('unreadable')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_BYTES) throw new UpstreamError('unreadable')
    return bytes
  }

  return {
    async json(url, request) {
      const response = await send(url, request, 'application/json')
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        parsed = undefined
      }
      if (response.status === 429) throw new UpstreamError('busy', 429)
      if (!response.ok) throw new UpstreamError('http', response.status, parsed)
      if (parsed === undefined) throw new UpstreamError('unreadable')
      return parsed
    },
    async text(url, request) {
      return new TextDecoder().decode(
        await body(await send(url, request, 'text/xml, text/plain, */*')),
      )
    },
    async bytes(url, request) {
      return body(await send(url, request, 'application/x-protobuf, application/octet-stream, */*'))
    },
  }
}

/** The message (safe to show) for an upstream failure of `what` ("the map search", "the route service"). */
export function failure(what: string, error: unknown): OperationError {
  if (error instanceof OperationError) return error
  const kind = error instanceof UpstreamError ? error.kind : 'unreachable'
  switch (kind) {
    case 'timeout':
      return new OperationError('CONFLICT', `${what} did not answer in time; try again`)
    case 'busy':
      return new OperationError('CONFLICT', `${what} is busy (rate limited); try again in a minute`)
    case 'http':
      return new OperationError(
        'CONFLICT',
        `${what} failed (HTTP ${(error as UpstreamError).status})`,
      )
    case 'unreadable':
      return new OperationError('CONFLICT', `${what} gave an unreadable answer`)
    default:
      return new OperationError('CONFLICT', `${what} could not be reached; try again`)
  }
}

/**
 * Tries each service in order and returns the first answer that `accept` takes. A service that throws an `UpstreamError` or gives an
 * answer `accept` refuses passes to the next; an `OperationError` stops at once (a definite answer, such as "no route"). When every
 * service fails, the first failure is told.
 */
export async function firstOf<T>(
  what: string,
  tries: (() => Promise<T>)[],
  accept: (value: T) => boolean = () => true,
): Promise<T> {
  let first: unknown
  let empty: T | undefined
  for (const attempt of tries) {
    try {
      const value = await attempt()
      if (accept(value)) return value
      empty ??= value
    } catch (error) {
      if (error instanceof OperationError) throw error
      first ??= error
    }
  }
  if (empty !== undefined) return empty
  throw failure(what, first)
}
