import { createGuestClient, type GuestClient } from '@keith/client'
import {
  GUEST_BANNER,
  GUEST_BEARER_PREFIX,
  type GuestEndReason,
  type GuestHttpErrorCode,
} from '@keith/contracts'

/** Behaviour of the fake guest listener (`/guest/*`), served by the fake core when `guest` is set. */
export interface FakeGuestOptions {
  /** `GET /guest/status` (default: enabled and available). */
  status?: { enabled?: boolean; available?: boolean }
  /** `POST /guest/session` is refused with this code (and status) instead of a session. */
  refuseOpen?: { code: GuestHttpErrorCode; status: number; retryAfter?: number }
  /** Answer text of every chat turn, streamed in a few deltas (default `Hello, visitor.`). */
  reply?: string
  /** Messages the session may send (default 20). */
  maxTurns?: number
  /** The chat that carries this 1-based number answers 410 with this reason (the session ended meanwhile). */
  endAt?: { turn: number; reason: GuestEndReason }
  /** Add `x-keith-guest-watched: 1` to chat answers (the owner peeked). */
  watched?: boolean
}

export interface FakeGuest {
  /** Handle a request when it is under `/guest/`; `undefined` for any other path. */
  handle(request: Request, url: URL): Promise<Response | undefined>
  /** What the guest routes saw. */
  state: {
    opened: number
    chats: string[]
    interrupts: number
    deleted: number
    /** The `Authorization` header of every session call (the token is a runtime-built fake). */
    auths: Array<string | null>
  }
}

const encoder = new TextEncoder()
const sse = (chunk: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
const error = (
  code: string,
  status: number,
  extra: object = {},
  headers: Record<string, string> = {},
) => Response.json({ error: { code, message: code.toLowerCase(), ...extra } }, { status, headers })

/** A stand-in for the guest listener: only what the guest client calls. */
export function createFakeGuest(options: FakeGuestOptions = {}): FakeGuest {
  const maxTurns = options.maxTurns ?? 20
  const limits = { maxTurns, maxInputChars: 2048, idleMs: 1_800_000, absoluteMs: 7_200_000 }
  // built at runtime: a fake bearer, never a literal
  const token = `${GUEST_BEARER_PREFIX}${'G'.repeat(43)}`
  const sessionId = 'guest:fake'
  let live = false
  let turns = 0
  const state: FakeGuest['state'] = { opened: 0, chats: [], interrupts: 0, deleted: 0, auths: [] }
  return {
    state,
    async handle(request, url) {
      if (!url.pathname.startsWith('/guest/')) return undefined
      if (url.pathname === '/guest/status')
        return Response.json({
          enabled: options.status?.enabled ?? true,
          available: options.status?.available ?? true,
          banner: GUEST_BANNER,
          limits,
        })
      if (url.pathname === '/guest/session' && request.method === 'POST') {
        const refuse = options.refuseOpen
        if (refuse !== undefined)
          return error(
            refuse.code,
            refuse.status,
            {},
            refuse.retryAfter === undefined ? {} : { 'retry-after': String(refuse.retryAfter) },
          )
        state.opened++
        live = true
        turns = 0
        return Response.json(
          { sessionId, token, expiresAt: Date.now() + 7_200_000, limits, notice: GUEST_BANNER },
          { status: 201 },
        )
      }
      const route = /^\/guest\/sessions\/([^/]+)(\/.*)?$/.exec(url.pathname)
      if (route === null) return error('GUEST_NOT_FOUND', 404)
      state.auths.push(request.headers.get('authorization'))
      if (request.headers.get('authorization') !== `Bearer ${token}`)
        return error('GUEST_UNAUTHORIZED', 401)
      const rest = route[2] ?? ''
      if (request.method === 'DELETE' && rest === '') {
        if (!live) return error('GUEST_SESSION_ENDED', 410, { details: { reason: 'closed' } })
        live = false
        state.deleted++
        return Response.json({ ended: true })
      }
      if (rest === '/interrupt') {
        state.interrupts++
        return Response.json({ target: 'none' })
      }
      if (rest === '/chat' && request.method === 'POST') {
        if (!live) return error('GUEST_SESSION_ENDED', 410, { details: { reason: 'closed' } })
        const body = (await request.json()) as {
          messages?: Array<{ parts: Array<{ text?: string }> }>
        }
        const text =
          body.messages
            ?.at(-1)
            ?.parts.map((p) => p.text ?? '')
            .join('') ?? ''
        turns++
        if (options.endAt !== undefined && turns === options.endAt.turn) {
          live = false
          return error('GUEST_SESSION_ENDED', 410, { details: { reason: options.endAt.reason } })
        }
        state.chats.push(text)
        const words = (options.reply ?? 'Hello, visitor.')
          .split(' ')
          .map((w, i) => (i === 0 ? w : ` ${w}`))
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(sse({ type: 'start' }))
            c.enqueue(sse({ type: 'text-start', id: 't' }))
            for (const delta of words) {
              c.enqueue(sse({ type: 'text-delta', id: 't', delta }))
              await Bun.sleep(5)
            }
            c.enqueue(sse({ type: 'text-end', id: 't' }))
            c.enqueue(sse({ type: 'finish' }))
            c.enqueue(encoder.encode('data: [DONE]\n\n'))
            c.close()
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'x-keith-guest-turns-left': String(Math.max(0, maxTurns - turns)),
            ...(options.watched === true ? { 'x-keith-guest-watched': '1' } : {}),
          },
        })
      }
      return error('GUEST_NOT_FOUND', 404)
    },
  }
}

/** A real `GuestClient` whose fetch is served by a `FakeGuest` in process (no port). */
export function guestHarness(options: FakeGuestOptions = {}): {
  client: GuestClient
  fake: FakeGuest
} {
  const fake = createFakeGuest(options)
  const client = createGuestClient({
    baseUrl: 'http://guest.test',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as string, init)
      return (
        (await fake.handle(request, new URL(request.url))) ?? new Response('nf', { status: 404 })
      )
    }) as typeof fetch,
  })
  return { client, fake }
}
