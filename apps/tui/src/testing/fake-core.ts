import { type BudgetStatus, ROLE_CAPABILITIES } from '@keith/contracts'
import type { UIMessage } from 'ai'
import { isSensitive } from './fake-admin.ts'
import { createAuth } from './fake-auth.ts'
import {
  type FakeCore,
  type FakeCoreOptions,
  type FakeRecord,
  type FakeStepUp,
  MEMBER,
} from './fake-core-types.ts'
import { createFakeGuest } from './fake-guest.ts'
import { createFakePresence } from './fake-presence.ts'
import { createStepUp } from './fake-step-up.ts'
import { createFakeViews } from './fake-views.ts'

export { type FakeCore, type FakeCoreOptions, type FakeRecord, type FakeStepUp, MEMBER }

const sse = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`

/**
 * A stand-in for the core in TUI tests: `/sessions/*` like eharness/http (history, snapshot,
 * streaming chat) and `/rpc/*` like the oRPC RPC protocol. Only what the TUI calls.
 */
export function startFakeCore(options: FakeCoreOptions = {}): FakeCore {
  const seen: string[] = []
  const guest = createFakeGuest(options.guest)
  const presence = createFakePresence(options.presence)
  const viewRoutes = options.views === undefined ? undefined : createFakeViews(options.views)
  const history: UIMessage[] = [...(options.history ?? [])]
  const log: Record<string, unknown>[] = []
  const attention: unknown[] = [...(options.attention ?? [])]
  const answers: FakeCore['answers'] = []
  let answerStatus = 0
  const step = createStepUp(options.stepUp)
  const stepUps = step.requests
  const refuseStep = step.refuse
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const chats: FakeCore['chats'] = []
  let revoked = options.revoked === true
  let logouts = 0
  const auth = createAuth(
    options.auth,
    () => {
      revoked = false
    },
    options.flow,
  )
  let boot = 'fake'
  let down = false
  let downStatus = 503
  let running = false
  let dropAfter: number | undefined
  let dropUntil: (() => boolean) | undefined
  let dropped: { id: string; text: string } | undefined
  let turns = 0
  const budget: BudgetStatus = {
    scope: 'owner',
    limitUsd: 20,
    spentUsd: 0,
    reservedUsd: 0,
    remainingUsd: 20,
    periodStart: Date.UTC(2026, 9, 1),
    periodEnd: Date.UTC(2026, 10, 1),
    unpriced: [],
    ...options.budget,
  }
  const settle = (): BudgetStatus => {
    budget.remainingUsd =
      budget.limitUsd === null
        ? null
        : Math.max(0, budget.limitUsd - budget.spentUsd - budget.reservedUsd)
    return budget
  }
  settle()
  const words = (text: string): string[] => text.split(' ').map((w, i) => (i === 0 ? w : ` ${w}`))
  const answerResponse = (
    text: string,
    cutAfter: number | undefined,
    until: (() => boolean) | undefined,
  ): Response => {
    const id = `a-${++turns}`
    const parts = words(text)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        if (cutAfter === 0) {
          // cut before a single byte: the client never sees the assistant message
          const start = Date.now()
          while (until !== undefined && !until() && Date.now() - start < 10_000) await Bun.sleep(10)
          running = true
          dropped = { id, text }
          c.error(new Error('connection dropped'))
          return
        }
        c.enqueue(encoder.encode(sse({ type: 'start', messageId: id })))
        c.enqueue(encoder.encode(sse({ type: 'text-start', id: 't' })))
        for (const delta of parts) {
          if (cutAfter !== undefined && sent === cutAfter) {
            const start = Date.now()
            while (until !== undefined && !until() && Date.now() - start < 10_000)
              await Bun.sleep(10)
            running = true
            dropped = { id, text }
            c.error(new Error('connection dropped'))
            return
          }
          c.enqueue(encoder.encode(sse({ type: 'text-delta', id: 't', delta })))
          sent++
          await Bun.sleep(5)
        }
        c.enqueue(encoder.encode(sse({ type: 'text-end', id: 't' })))
        c.enqueue(encoder.encode(sse({ type: 'finish' })))
        c.enqueue(encoder.encode('data: [DONE]\n\n'))
        history.push({ id, role: 'assistant', parts: [{ type: 'text', text }] })
        c.close()
      },
    })
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    })
  }
  /** The whole answer again (a replay), then the turn is over and the answer is stored. */
  const replayResponse = ({ id, text }: { id: string; text: string }): Response => {
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(encoder.encode(sse({ type: 'start', messageId: id })))
        c.enqueue(encoder.encode(sse({ type: 'text-start', id: 't' })))
        for (const delta of words(text)) {
          c.enqueue(encoder.encode(sse({ type: 'text-delta', id: 't', delta })))
          await Bun.sleep(5)
        }
        c.enqueue(encoder.encode(sse({ type: 'text-end', id: 't' })))
        c.enqueue(encoder.encode(sse({ type: 'finish' })))
        c.enqueue(encoder.encode('data: [DONE]\n\n'))
        history.push({ id, role: 'assistant', parts: [{ type: 'text', text }] })
        dropped = undefined
        running = false
        c.close()
      },
    })
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    })
  }
  const encoder = new TextEncoder()
  const write = (text: string) => {
    for (const c of streams) c.enqueue(encoder.encode(text))
  }
  // keeps the client's idle watchdog (13 s) quiet in long tests
  const keepAlive = setInterval(() => write(': keep-alive\n\n'), 4000)
  const activityStream = (): Response => {
    if (down) return new Response('down', { status: downStatus })
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        streams.add(c)
        c.enqueue(
          encoder.encode(
            `retry: 1000\n\n: connected\n\nevent: boot\ndata: ${JSON.stringify({ boot })}\n\n`,
          ),
        )
      },
      cancel() {
        if (controller !== undefined) streams.delete(controller)
      },
    })
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  }
  const server = Bun.serve({
    ...(options.unix === undefined ? { port: 0 } : { unix: options.unix }),
    websocket: viewRoutes?.websocket ?? { message() {} },
    async fetch(request, srv) {
      const url = new URL(request.url)
      seen.push(`${request.method} ${url.pathname}`)
      if (url.pathname === '/health')
        return Response.json({ status: 'ok', version: '0.0.0', sha: 'abc1234', boot })
      if (options.guest !== undefined) {
        const answered = await guest.handle(request, url)
        if (answered !== undefined) return answered
      }
      const signIn = await auth.handle(request, url.pathname)
      if (signIn !== undefined) return signIn
      if (viewRoutes !== undefined && !revoked) {
        const answered = viewRoutes.handle(request, url, srv as never)
        if (answered === 'upgraded') return undefined
        if (answered !== undefined) return answered
      }
      if (revoked) {
        return url.pathname.startsWith('/rpc/')
          ? Response.json(
              {
                json: {
                  defined: false,
                  code: 'UNAUTHORIZED',
                  status: 401,
                  message: 'unauthorized',
                },
              },
              { status: 401 },
            )
          : new Response('unauthorized', { status: 401 })
      }
      if (url.pathname === '/activity/stream') return activityStream()
      if (url.pathname === '/activity') {
        if (down) return new Response('down', { status: downStatus })
        const after = Number(url.searchParams.get('after') ?? 0)
        const events = log.filter((r) => (r.seq as number) > after)
        return Response.json({ events, lastSeq: log.length })
      }
      if (url.pathname === '/auth/step-up' && request.method === 'POST')
        return step.handle(
          (await request.json().catch(() => ({}))) as { pin?: string; password?: string },
        )
      if (url.pathname === '/attention') return Response.json({ items: attention })
      const answer = /^\/attention\/([^/]+)\/answer$/.exec(url.pathname)
      if (answer !== null && request.method === 'POST') {
        const id = decodeURIComponent(answer[1] ?? '')
        const body = (await request.json()) as FakeCore['answers'][number]['body']
        answers.push({ id, body })
        if (options.waitingForOwner?.includes(id) === true)
          return Response.json(
            {
              error: {
                code: 'KEITH_WAITING_FOR_OWNER',
                message: 'this waits for the owner to approve it',
              },
            },
            { status: 403 },
          )
        const refused = refuseStep(false)
        if (refused !== undefined) return refused
        if (answerStatus !== 0) {
          const code = answerStatus === 409 ? 'EH_HTTP_ALREADY_ANSWERED' : 'EH_HTTP_ERROR'
          return Response.json(
            { error: { code, message: 'queue rejects the answer' } },
            { status: answerStatus },
          )
        }
        const at = attention.findIndex((i) => (i as { id?: string }).id === id)
        if (at !== -1) attention.splice(at, 1)
        return Response.json({ status: 'resumed', id, sessionId: body.sessionId })
      }
      if (url.pathname.startsWith('/rpc/')) {
        const name = url.pathname.slice(5)
        const body = (await request.json().catch(() => ({}))) as { json?: unknown }
        if (name === 'tasks/stop' || isSensitive(name)) {
          const refused = refuseStep(true)
          if (refused !== undefined) return refused
        }
        const builtin: Record<string, (input?: unknown) => unknown> = {
          ...presence.handlers,
          'budget/get': () => settle(),
          'auth/logout': () => {
            logouts++
            revoked = true
            return { ok: true }
          },
          'auth/whoami': () => {
            const role = options.whoami?.role ?? 'owner'
            return {
              personId: 'owner',
              name: 'Owner',
              username: 'owner',
              role,
              via: 'tcp',
              credentialKind: 'token',
              elevated: false,
              capabilities: [...ROLE_CAPABILITIES[role]],
              ...options.whoami,
            }
          },
        }
        const handler = options.rpc?.[name] ?? builtin[name]
        if (handler === undefined) return new Response('not found', { status: 404 })
        try {
          return Response.json({ json: await handler(body.json) })
        } catch (error) {
          // a handler that throws is an oRPC error (the client rejects with its message); a code and a status
          // on the error (`CONFLICT` 409, ...) are the RPC error's own
          const message = error instanceof Error ? error.message : String(error)
          const coded = error as { code?: unknown; status?: unknown }
          const code = typeof coded.code === 'string' ? coded.code : 'INTERNAL_SERVER_ERROR'
          const status = typeof coded.status === 'number' ? coded.status : 500
          return Response.json({ json: { defined: false, code, status, message } }, { status })
        }
      }
      const match = /^\/sessions\/([^/]+)(\/.*)?$/.exec(url.pathname)
      const rest = match?.[2] ?? ''
      if (rest === '/messages') return Response.json({ messages: history })
      if (rest === '' && request.method === 'GET') {
        return Response.json({
          id: match?.[1],
          running,
          busy: null,
          activeTurn: null,
          pending: null,
          usage: null,
        })
      }
      if (rest === '/chat/stream') {
        return dropped === undefined ? new Response(null, { status: 204 }) : replayResponse(dropped)
      }
      if (rest === '/chat' && request.method === 'POST') {
        const body = (await request.json()) as { message?: UIMessage; messages?: UIMessage[] }
        const user = body.message ?? body.messages?.at(-1)
        const meta = body as { trigger?: string; messageId?: string }
        chats.push({
          ...(meta.trigger === undefined ? {} : { trigger: meta.trigger }),
          ...(meta.messageId === undefined ? {} : { messageId: meta.messageId }),
          ...(user === undefined
            ? {}
            : { text: user.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }),
        })
        if (user !== undefined) history.push(user)
        const cut = dropAfter
        const until = dropUntil
        dropAfter = undefined
        dropUntil = undefined
        return answerResponse(options.reply ?? 'Hello from Keith.', cut, until)
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: options.unix === undefined ? server.url.href : 'http://localhost/',
    seen,
    views: viewRoutes?.views,
    attention,
    answers,
    stepUps,
    logins: auth.logins,
    identified: auth.identified,
    flowAnswers: auth.flowAnswers,
    firstOwnerSets: auth.firstOwnerSets,
    devices: auth.devices,
    get logouts() {
      return logouts
    },
    decideDevice: (decision) => auth.setDevice(decision),
    failAnswers: (status) => {
      answerStatus = status
    },
    chats,
    guest: guest.state,
    presence,
    dropNextAnswer: (afterWords, until) => {
      dropAfter = afterWords
      dropUntil = until
    },
    reboot: (id) => {
      boot = id
      write(`event: boot\ndata: ${JSON.stringify({ boot })}\n\n`)
    },
    feedDown: (value, status = 503) => {
      down = value
      downStatus = status
      if (!value) return
      for (const c of streams) {
        try {
          c.close()
        } catch {
          // already closed by the client
        }
      }
      streams.clear()
    },
    revoke: () => {
      revoked = true
      for (const c of streams) {
        try {
          c.close()
        } catch {
          // already closed by the client
        }
      }
      streams.clear()
    },
    setRunning: (value) => {
      running = value
    },
    pushHistory: (message) => {
      history.push(message)
    },
    spend(usd) {
      budget.spentUsd += usd
      this.emit({ type: 'budget-changed', payload: { budget: settle() } })
    },
    emit(record) {
      const full = {
        agentId: null,
        sessionId: null,
        ...record,
        seq: log.length + 1,
        createdAt: Date.now(),
      }
      log.push(full)
      write(`id:${full.seq}\nevent:${record.type}\ndata:${JSON.stringify(full)}\n\n`)
    },
    resync: () => write(`event: resync\ndata: ${JSON.stringify({ seq: log.length })}\n\n`),
    streams: () => streams.size,
    stop() {
      clearInterval(keepAlive)
      for (const c of streams) {
        try {
          c.close()
        } catch {
          // already closed by the client
        }
      }
      streams.clear()
      server.stop(true)
    },
  }
}
