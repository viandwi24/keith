import { describe, expect, test } from 'bun:test'
import {
  GUEST_BANNER,
  GUEST_BEARER_PREFIX,
  GUEST_HTTP_ERROR_CODES,
  GuestEndReasonSchema,
} from '@keith/contracts'
import {
  createGuestClient,
  GUEST_END_TEXT,
  GUEST_FAILURE_OF_CODE,
  GuestError,
  type GuestFailureKind,
  guestFailureText,
} from './guest.ts'

// built at runtime: a fake bearer, never a literal
const TOKEN = `${GUEST_BEARER_PREFIX}${'A'.repeat(43)}`
const LIMITS = { maxTurns: 20, maxInputChars: 2048, idleMs: 1_800_000, absoluteMs: 7_200_000 }
const STARTED = {
  sessionId: 'guest:abc',
  token: TOKEN,
  expiresAt: 1_900_000_000_000,
  limits: LIMITS,
  notice: GUEST_BANNER,
}
const STATUS = { enabled: true, available: true, banner: GUEST_BANNER, limits: LIMITS }

interface Seen {
  method: string
  path: string
  auth: string | null
  body: string
}
function fake(handle: (req: Request, seen: Seen) => Response | Promise<Response>): {
  fetch: typeof fetch
  seen: Seen[]
} {
  const seen: Seen[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init)
    const entry: Seen = {
      method: req.method,
      path: new URL(req.url).pathname,
      auth: req.headers.get('authorization'),
      body: req.method === 'GET' ? '' : await req.text(),
    }
    seen.push(entry)
    return handle(req, entry)
  }) as typeof fetch
  return { fetch: fn, seen }
}
const error = (
  code: string,
  status: number,
  extra: object = {},
  headers: Record<string, string> = {},
) => Response.json({ error: { code, message: 'x', ...extra } }, { status, headers })
const sse = (...chunks: object[]) =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream', 'x-keith-guest-turns-left': '19' },
  })

async function failure(run: () => Promise<unknown>): Promise<GuestError> {
  try {
    await run()
  } catch (e) {
    if (e instanceof GuestError) return e
    throw e
  }
  throw new Error('expected a GuestError')
}

describe('createGuestClient', () => {
  test('status reads the open route with no credential', async () => {
    const { fetch, seen } = fake(() => Response.json(STATUS))
    const client = createGuestClient({ baseUrl: 'http://10.0.0.5:7421/', fetch })
    expect(await client.status()).toEqual(STATUS)
    expect(seen).toEqual([{ method: 'GET', path: '/guest/status', auth: null, body: '' }])
  })

  test('open keeps the bearer in memory only: the session view has no token', async () => {
    const { fetch, seen } = fake(() => Response.json(STARTED, { status: 201 }))
    const client = createGuestClient({ baseUrl: 'http://h:7421', fetch })
    const session = await client.open()
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ clientKind: 'tui' })
    expect(session.sessionId).toBe('guest:abc')
    expect(JSON.stringify(client.session)).not.toContain(TOKEN)
    expect(JSON.stringify(Object.keys(client))).not.toContain('token')
  })

  test('chat sends the bearer and one text part, then yields meta, text, tools and finish', async () => {
    const { fetch, seen } = fake((req) =>
      req.method === 'POST' && new URL(req.url).pathname.endsWith('/chat')
        ? sse(
            { type: 'start' },
            { type: 'tool-input-available', toolCallId: 't1', toolName: 'notes_public_list' },
            { type: 'tool-output-available', toolCallId: 't1', output: {} },
            { type: 'text-start', id: 'x' },
            { type: 'text-delta', id: 'x', delta: 'Hel' },
            { type: 'text-delta', id: 'x', delta: 'lo' },
            { type: 'finish', messageMetadata: { eharness: { stop: 'end-turn', model: 'm' } } },
          )
        : Response.json(STARTED, { status: 201 }),
    )
    const client = createGuestClient({ baseUrl: 'http://h:7421', fetch })
    await client.open()
    const events = []
    for await (const e of client.chat('hi')) events.push(e)
    expect(events).toEqual([
      { type: 'meta', turnsLeft: 19, watched: false },
      { type: 'tool', id: 't1', name: 'notes_public_list', state: 'running' },
      { type: 'tool', id: 't1', name: '', state: 'done' },
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'finish', stop: 'end-turn' },
    ])
    const sent = seen.at(-1)
    expect(sent?.path).toBe('/guest/sessions/guest%3Aabc/chat')
    expect(sent?.auth).toBe(`Bearer ${TOKEN}`)
    const body = JSON.parse(sent?.body ?? '{}')
    expect(body.messages[0].parts).toEqual([{ type: 'text', text: 'hi' }])
  })

  test('the watched header and a stream error chunk are surfaced', async () => {
    const { fetch } = fake((req) =>
      new URL(req.url).pathname.endsWith('/chat')
        ? new Response(`data: ${JSON.stringify({ type: 'error', errorText: 'nope' })}\n\n`, {
            headers: { 'content-type': 'text/event-stream', 'x-keith-guest-watched': '1' },
          })
        : Response.json(STARTED, { status: 201 }),
    )
    const client = createGuestClient({ baseUrl: 'http://h', fetch })
    await client.open()
    const events = []
    for await (const e of client.chat('x')) events.push(e)
    expect(events).toEqual([
      { type: 'meta', turnsLeft: undefined, watched: true },
      { type: 'error', text: 'nope' },
    ])
  })

  test('interrupt and end call their routes; end forgets the session', async () => {
    const { fetch, seen } = fake((req) =>
      req.method === 'POST' && new URL(req.url).pathname === '/guest/session'
        ? Response.json(STARTED, { status: 201 })
        : Response.json({ ended: true }),
    )
    const client = createGuestClient({ baseUrl: 'http://h', fetch })
    await client.open()
    await client.interrupt()
    await client.end()
    expect(
      seen.slice(1).map((s) => `${s.method} ${s.path} ${s.auth === `Bearer ${TOKEN}`}`),
    ).toEqual([
      'POST /guest/sessions/guest%3Aabc/interrupt true',
      'DELETE /guest/sessions/guest%3Aabc true',
    ])
    expect(client.session).toBeUndefined()
    // a second end and an interrupt with no session call nothing
    await client.end()
    await client.interrupt()
    expect(seen).toHaveLength(3)
  })

  test('chat without a session is unauthorized before any request', async () => {
    const { fetch, seen } = fake(() => Response.json({}))
    const client = createGuestClient({ baseUrl: 'http://h', fetch })
    const e = await failure(async () => {
      for await (const _ of client.chat('x')) void _
    })
    expect(e.kind).toBe('unauthorized')
    expect(seen).toHaveLength(0)
  })
})

describe('every error code is a clear state', () => {
  const STATUS_OF: Record<string, number> = {
    GUEST_UNAUTHORIZED: 401,
    GUEST_DISABLED: 403,
    GUEST_ZONE: 403,
    GUEST_RATE_LIMITED: 429,
    GUEST_BUSY: 429,
    GUEST_CAP: 429,
    GUEST_UNAVAILABLE: 503,
    GUEST_SESSION_ENDED: 410,
    GUEST_NOT_FOUND: 404,
    GUEST_BAD_REQUEST: 400,
  }
  for (const code of GUEST_HTTP_ERROR_CODES) {
    test(`${code} from open`, async () => {
      const { fetch } = fake(() => error(code, STATUS_OF[code] ?? 500, {}, { 'retry-after': '42' }))
      const e = await failure(() => createGuestClient({ baseUrl: 'http://h', fetch }).open())
      expect(e.kind).toBe(GUEST_FAILURE_OF_CODE[code] as GuestFailureKind)
      expect(e.details.code).toBe(code)
      expect(e.message.length).toBeGreaterThan(10)
      expect(e.message).toBe(guestFailureText(e))
      expect(e.retryAfter).toBe(42)
    })
  }

  test('every end reason has its own sentence, and a 410 carries it', async () => {
    for (const reason of GuestEndReasonSchema.options) {
      const { fetch } = fake((req) =>
        new URL(req.url).pathname === '/guest/session'
          ? Response.json(STARTED, { status: 201 })
          : error('GUEST_SESSION_ENDED', 410, { details: { reason } }),
      )
      const client = createGuestClient({ baseUrl: 'http://h', fetch })
      await client.open()
      const e = await failure(async () => {
        for await (const _ of client.chat('x')) void _
      })
      expect(e.kind).toBe('ended')
      expect(e.reason).toBe(reason)
      expect(e.message).toBe(GUEST_END_TEXT[reason])
      // the dead session is forgotten
      expect(client.session).toBeUndefined()
    }
  })

  test('a 409 with no code is "turn running", a bare 401 is unauthorized, a bare 429 is busy', async () => {
    for (const [status, kind] of [
      [409, 'turn-running'],
      [401, 'unauthorized'],
      [429, 'busy'],
      [413, 'bad-request'],
      [500, 'unavailable'],
    ] as const) {
      const { fetch } = fake((req) =>
        new URL(req.url).pathname === '/guest/session'
          ? Response.json(STARTED, { status: 201 })
          : new Response('nope', { status }),
      )
      const client = createGuestClient({ baseUrl: 'http://h', fetch })
      await client.open()
      const e = await failure(async () => {
        for await (const _ of client.chat('x')) void _
      })
      expect(e.kind).toBe(kind)
    }
  })

  test('a network failure is "unreachable"; a bad body is "protocol"', async () => {
    const down = createGuestClient({
      baseUrl: 'http://h',
      fetch: (() => Promise.reject(new TypeError('connect refused'))) as unknown as typeof fetch,
    })
    expect((await failure(() => down.status())).kind).toBe('unreachable')
    expect((await failure(() => down.open())).kind).toBe('unreachable')
    const odd = createGuestClient({
      baseUrl: 'http://h',
      fetch: (async () => Response.json({ nonsense: true })) as unknown as typeof fetch,
    })
    expect((await failure(() => odd.status())).kind).toBe('protocol')
    expect((await failure(() => odd.open())).kind).toBe('protocol')
    // interrupt and end never reject
    await down.interrupt()
    await down.end()
  })

  test('a stream that drops mid-answer is "unreachable"', async () => {
    const { fetch } = fake((req) =>
      new URL(req.url).pathname === '/guest/session'
        ? Response.json(STARTED, { status: 201 })
        : new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"a"}\n\n'))
                c.error(new Error('reset'))
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
    )
    const client = createGuestClient({ baseUrl: 'http://h', fetch })
    await client.open()
    const events: string[] = []
    const e = await failure(async () => {
      for await (const ev of client.chat('x')) events.push(ev.type)
    })
    expect(events[0]).toBe('meta')
    expect(e.kind).toBe('unreachable')
  })
})
