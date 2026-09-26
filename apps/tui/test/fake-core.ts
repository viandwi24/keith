import {
  type CoreFrameType,
  type FrameData,
  LoginRequest,
  type MessageDto,
  type MessageId,
  makeFrame,
  type NodeFrame,
  type PersonDto,
  parseNodeFrame,
  type ThreadDto,
  WS_CLOSE_CODES,
} from '@keith/protocol'
import type { Server, ServerWebSocket } from 'bun'

/**
 * A tiny stand-in for the core, built on `@keith/protocol` schemas: `POST /v1/auth/login` and the
 * `/v1/ws` socket with `hello`/`welcome`, `thread.open`/`thread.opened` and a scripted streaming
 * reply to `input.text`. It listens on 127.0.0.1 with a random port and never touches the network.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A valid prefixed ULID from a counter, e.g. `thr_01J8ZQ3K4M0000000000000001`. */
export function fakeId<P extends string>(prefix: P, n: number): `${P}_${string}` {
  let body = ''
  let rest = n
  for (let i = 0; i < 16; i++) {
    body = CROCKFORD[rest % 32] + body
    rest = Math.floor(rest / 32)
  }
  return `${prefix}_01J8ZQ3K4M${body}`
}

type SocketData = { token: string; valid: boolean; threadOpen: boolean }

export type FakeCoreOptions = {
  username?: string
  password?: string
  /** The assistant's reply to a user input. Streamed word by word. */
  reply?: (text: string) => string
  /** Emit a `tool.activity` pair before the reply. */
  toolActivity?: boolean
  /** Pause between streamed chunks, in ms. */
  tickMs?: number
}

export type FakeCore = {
  readonly url: string
  readonly port: number
  readonly person: PersonDto
  readonly thread: ThreadDto
  readonly messages: MessageDto[]
  /** Every node frame received, in order. */
  readonly received: NodeFrame[]
  /** Number of `hello`s received (one per connection). */
  readonly hellos: number
  readonly nodeId: `nod_${string}`
  /** Sends an unsolicited assistant message to every socket with the thread open (I-11). */
  pushProactive(text: string): Promise<void>
  /** Sends `ping` to every socket. Returns the frame ids. */
  ping(): string[]
  /** Invalidates every issued token (the next connect is closed with 4003). */
  revokeTokens(): void
  /** Closes every socket with the given code. */
  dropConnections(code?: number): void
  stop(): Promise<void>
  /** Starts again on the same port, keeping the thread and its history. */
  restart(): Promise<void>
}

export function startFakeCore(opts: FakeCoreOptions = {}): FakeCore {
  const username = opts.username ?? 'tony'
  const password = opts.password ?? 'jarvis'
  const reply = opts.reply ?? ((text: string) => `You said: ${text}`)
  const person: PersonDto = { id: fakeId('per', 1), name: 'Tony', tier: 'owner' }
  const nodeId = fakeId('nod', 1)
  const thread: ThreadDto = {
    id: fakeId('thr', 1),
    kind: 'direct',
    title: 'main',
    participants: [person],
    state: 'idle',
    updatedAt: 1,
  }
  const messages: MessageDto[] = []
  const received: NodeFrame[] = []
  const tokens = new Set<string>()
  const sockets = new Set<ServerWebSocket<SocketData>>()
  let counter = 100
  let hellos = 0
  let port = 0
  let server: Server<SocketData> | null = null

  const nextId = () => {
    counter += 1
    return counter
  }

  const send = <T extends CoreFrameType>(
    ws: ServerWebSocket<SocketData>,
    type: T,
    data: FrameData<T>,
    re?: string,
  ) => {
    ws.send(JSON.stringify(makeFrame(type, data, { id: `c${nextId()}`, ts: Date.now(), re })))
  }

  const broadcast = <T extends CoreFrameType>(type: T, data: FrameData<T>) => {
    for (const ws of sockets) if (ws.data.threadOpen) send(ws, type, data)
  }

  const setState = (state: ThreadDto['state']) => {
    thread.state = state
    broadcast('thread.state', { threadId: thread.id, state })
  }

  const tick = () => Bun.sleep(opts.tickMs ?? 2)

  const streamAssistant = async (text: string, proactive: boolean) => {
    const messageId: MessageId = fakeId('msg', nextId())
    setState('speaking')
    broadcast('message.started', { threadId: thread.id, messageId, proactive })
    const words = text.split(/(?<= )/)
    for (const word of words) {
      await tick()
      broadcast('message.delta', { threadId: thread.id, messageId, text: word })
    }
    const message: MessageDto = {
      id: messageId,
      threadId: thread.id,
      role: 'assistant',
      authorPersonId: null,
      modality: 'text',
      content: text,
      createdAt: Date.now(),
      ...(proactive ? { meta: { proactive: true } } : {}),
    }
    messages.push(message)
    broadcast('message.completed', { message })
    setState('idle')
  }

  const onInput = async (text: string) => {
    messages.push({
      id: fakeId('msg', nextId()),
      threadId: thread.id,
      role: 'user',
      authorPersonId: person.id,
      modality: 'text',
      content: text,
      createdAt: Date.now(),
    })
    setState('thinking')
    await tick()
    if (opts.toolActivity) {
      const messageId: MessageId = fakeId('msg', nextId())
      const base = { threadId: thread.id, messageId, toolCallId: 'call_1', name: 'web.search' }
      broadcast('tool.activity', { ...base, status: 'started', summary: 'searching' })
      await tick()
      broadcast('tool.activity', { ...base, status: 'completed', summary: '3 results' })
    }
    await streamAssistant(reply(text), false)
  }

  const onFrame = (ws: ServerWebSocket<SocketData>, frame: NodeFrame) => {
    received.push(frame)
    switch (frame.type) {
      case 'hello':
        hellos += 1
        send(
          ws,
          'welcome',
          { nodeId, person, protocol: 1, server: { name: 'keith-fake', version: '0.0.0' } },
          frame.id,
        )
        return
      case 'thread.open':
        ws.data.threadOpen = true
        send(
          ws,
          'thread.opened',
          { thread, messages: messages.slice(-(frame.data.historyLimit ?? 50)) },
          frame.id,
        )
        return
      case 'input.text':
        void onInput(frame.data.text)
        return
      case 'input.cancel':
        setState('idle')
        return
      default:
        return
    }
  }

  const listen = () => {
    server = Bun.serve<SocketData>({
      hostname: '127.0.0.1',
      port,
      fetch: async (req, srv) => {
        const url = new URL(req.url)
        if (url.pathname === '/v1/auth/login' && req.method === 'POST') {
          const body = LoginRequest.safeParse(await req.json().catch(() => null))
          if (!body.success) {
            return Response.json({ error: { code: 'INVALID_REQUEST', message: 'bad body' } }, { status: 400 })
          }
          if (body.data.username !== username || body.data.password !== password) {
            return Response.json(
              { error: { code: 'UNAUTHORIZED', message: 'bad credentials' } },
              { status: 401 },
            )
          }
          const token = `tok-${nextId()}`
          tokens.add(token)
          return Response.json({ token, person, expiresAt: Date.now() + 86_400_000 })
        }
        if (url.pathname === '/v1/ws') {
          const token = url.searchParams.get('token') ?? ''
          if (srv.upgrade(req, { data: { token, valid: tokens.has(token), threadOpen: false } }))
            return undefined
          return new Response('upgrade failed', { status: 400 })
        }
        return Response.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 })
      },
      websocket: {
        open(ws) {
          if (!ws.data.valid) {
            ws.close(WS_CLOSE_CODES.invalidToken, 'invalid token')
            return
          }
          sockets.add(ws)
        },
        message(ws, raw) {
          const result = parseNodeFrame(typeof raw === 'string' ? raw : raw.toString())
          if (!result.ok) {
            send(ws, 'error', {
              code: result.code === 'UNKNOWN_FRAME' ? 'UNKNOWN_FRAME' : 'INVALID_FRAME',
              message: result.message,
            })
            return
          }
          onFrame(ws, result.frame)
        },
        close(ws) {
          sockets.delete(ws)
        },
      },
    })
    port = server.port ?? 0
  }

  listen()

  return {
    get url() {
      return `http://127.0.0.1:${port}`
    },
    get port() {
      return port
    },
    person,
    thread,
    messages,
    received,
    get hellos() {
      return hellos
    },
    nodeId,
    pushProactive: (text) => streamAssistant(text, true),
    ping() {
      const ids: string[] = []
      for (const ws of sockets) {
        const id = `ping${nextId()}`
        ids.push(id)
        ws.send(JSON.stringify(makeFrame('ping', {}, { id, ts: Date.now() })))
      }
      return ids
    },
    revokeTokens() {
      tokens.clear()
    },
    dropConnections(code = 1001) {
      for (const ws of sockets) ws.close(code, 'dropped')
    },
    async stop() {
      for (const ws of sockets) ws.close(1001, 'going away')
      sockets.clear()
      // Bun 1.3.11: the promise of `stop(true)` never settles once a WebSocket has closed, but the
      // port is released right away, so it is not awaited.
      server?.stop(true).catch((error: unknown) => console.error('fake core stop failed', error))
      server = null
      await Bun.sleep(1)
    },
    async restart() {
      if (server) await this.stop()
      listen()
    },
  }
}
