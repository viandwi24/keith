import {
  AUDIO_FRAME_KIND,
  type AudioFrame,
  type AudioStreamId,
  type CoreFrameType,
  decodeAudioFrame,
  encodeAudioFrame,
  type FrameData,
  LoginRequest,
  type MessageDto,
  type MessageId,
  MessagesQuery,
  makeFrame,
  type NodeFrame,
  type PersonDto,
  parseNodeFrame,
  type ThreadDto,
  type UiBlock,
  uiBlockToText,
  WS_CLOSE_CODES,
} from '@keith/protocol'
import type { Server, ServerWebSocket } from 'bun'

/**
 * A tiny stand-in for the core, built on `@keith/protocol` schemas, for the tests of every client
 * (`@keith/client`, the TUI, the web app): the HTTP API (`login`, `logout`, `me`, `threads`,
 * `messages` paging) and the `/v1/ws` socket with `hello`/`welcome`, `thread.open`/`thread.opened`,
 * a scripted streaming reply to `input.text` (optionally with tool activity and a UI block), pushed
 * proactive messages and `ui.render` frames, and audio (phase 3): it records the node's binary
 * frames and can speak a stream of PCM16 chunks to `audio.out@1` sockets. It listens on 127.0.0.1 with a random port and never
 * touches the network. Test-only: it uses `Bun.serve`.
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

type SocketData = { token: string; valid: boolean; threadOpen: boolean; capabilities: string[] }

export type FakeCoreOptions = {
  username?: string
  password?: string
  /** The assistant's reply to a user input. Streamed word by word. */
  reply?: (text: string) => string
  /** Emit a `tool.activity` pair before the reply. */
  toolActivity?: boolean
  /** A UI block attached to the reply: sent as `ui.render` mid-stream and kept on the message. */
  replyUi?: (text: string) => UiBlock | undefined
  /** Pause between streamed chunks, in ms. */
  tickMs?: number
  /** Seeds the thread with this many history messages (alternating user and assistant). */
  history?: number
  /** Answers requests outside `/v1` (e.g. a built web app's files). Default: 404. */
  serve?: ((req: Request) => Response | Promise<Response>) | undefined
}

export type PushAudioOptions = {
  /** PCM16 chunks, sent as kind-2 binary frames with sequence 0, 1, 2, … */
  chunks: Int16Array[]
  /** Announced in `audio.start`. Default 24 000. */
  sampleRate?: number
  messageId?: MessageId
  /** Send `audio.end` after the last chunk. Default true. */
  end?: boolean
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
  /** Every binary frame received that decoded, in order. */
  readonly receivedAudio: AudioFrame[]
  readonly nodeId: `nod_${string}`
  /** Sends an unsolicited assistant message to every socket with the thread open (I-11). */
  pushProactive(text: string): Promise<void>
  /**
   * Sends a `ui.render` frame to every socket with the thread open that declared `ui.render@1`,
   * as the core does. Without `messageId` the block floats in the thread.
   */
  pushUi(block: UiBlock, opts?: { messageId?: MessageId; fallbackText?: string }): void
  /**
   * Speaks one stream to every socket with the thread open that declared `audio.out@1`:
   * `audio.start`, the chunks as binary frames, then `audio.end`. Returns the stream id.
   */
  pushAudio(opts: PushAudioOptions): AudioStreamId
  /** Sends `audio.stop` for a stream (barge-in) to the same sockets. */
  stopAudio(streamId: AudioStreamId): void
  /** Sets the thread's turn state and broadcasts `thread.state` (e.g. `listening` on VAD start). */
  setTurnState(state: ThreadDto['state']): void
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
  const receivedAudio: AudioFrame[] = []
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

  const broadcast = <T extends CoreFrameType>(type: T, data: FrameData<T>, capability?: string) => {
    for (const ws of sockets) {
      if (!ws.data.threadOpen) continue
      if (capability && !ws.data.capabilities.includes(capability)) continue
      send(ws, type, data)
    }
  }

  const renderUi = (block: UiBlock, messageId: MessageId | undefined, fallbackText?: string) => {
    broadcast(
      'ui.render',
      {
        threadId: thread.id,
        ...(messageId ? { messageId } : {}),
        block,
        fallbackText: fallbackText ?? uiBlockToText(block),
      },
      'ui.render@1',
    )
  }

  const audioSockets = () =>
    [...sockets].filter((ws) => ws.data.threadOpen && ws.data.capabilities.includes('audio.out@1'))

  const pushAudio = (o: PushAudioOptions): AudioStreamId => {
    const streamId = fakeId('msg', nextId()).slice('msg_'.length)
    const messageId = o.messageId ?? fakeId('msg', nextId())
    for (const ws of audioSockets()) {
      send(ws, 'audio.start', {
        threadId: thread.id,
        messageId,
        streamId,
        codec: 'pcm16',
        sampleRate: o.sampleRate ?? 24_000,
      })
      for (const [sequence, chunk] of o.chunks.entries()) {
        const payload = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        ws.send(encodeAudioFrame({ kind: AUDIO_FRAME_KIND.out, streamId, sequence, payload }))
      }
      if (o.end ?? true) send(ws, 'audio.end', { streamId })
    }
    return streamId
  }

  const onBinary = (ws: ServerWebSocket<SocketData>, raw: Uint8Array) => {
    const result = decodeAudioFrame(raw)
    if (!result.ok) {
      send(ws, 'error', { code: 'INVALID_FRAME', message: result.message })
      return
    }
    receivedAudio.push(result.frame)
  }

  const setState = (state: ThreadDto['state']) => {
    thread.state = state
    broadcast('thread.state', { threadId: thread.id, state })
  }

  const tick = () => Bun.sleep(opts.tickMs ?? 2)

  const streamAssistant = async (text: string, proactive: boolean, ui?: UiBlock) => {
    const messageId: MessageId = fakeId('msg', nextId())
    setState('speaking')
    broadcast('message.started', { threadId: thread.id, messageId, proactive })
    const words = text.split(/(?<= )/)
    for (const [i, word] of words.entries()) {
      await tick()
      broadcast('message.delta', { threadId: thread.id, messageId, text: word })
      if (ui && i === 0) renderUi(ui, messageId)
    }
    const message: MessageDto = {
      id: messageId,
      threadId: thread.id,
      role: 'assistant',
      authorPersonId: null,
      modality: 'text',
      content: text,
      createdAt: Date.now(),
      ...(ui ? { ui: [ui] } : {}),
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
    await streamAssistant(reply(text), false, opts.replyUi?.(text))
  }

  for (let i = 0; i < (opts.history ?? 0); i++) {
    const user = i % 2 === 0
    messages.push({
      id: fakeId('msg', nextId()),
      threadId: thread.id,
      role: user ? 'user' : 'assistant',
      authorPersonId: user ? person.id : null,
      modality: 'text',
      content: `history ${i + 1}`,
      createdAt: i + 1,
    })
  }

  const authorized = (req: Request): boolean => {
    const header = req.headers.get('authorization') ?? ''
    return header.startsWith('Bearer ') && tokens.has(header.slice('Bearer '.length))
  }

  const errorResponse = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status })

  const api = (req: Request, url: URL): Response => {
    if (!authorized(req)) return errorResponse(401, 'UNAUTHORIZED', 'invalid token')
    if (url.pathname === '/v1/auth/logout' && req.method === 'POST') {
      tokens.delete((req.headers.get('authorization') ?? '').slice('Bearer '.length))
      return Response.json({ ok: true })
    }
    if (url.pathname === '/v1/me') return Response.json({ person })
    if (url.pathname === '/v1/threads') return Response.json({ threads: [thread] })
    if (url.pathname === `/v1/threads/${thread.id}/messages`) {
      const query = MessagesQuery.safeParse(Object.fromEntries(url.searchParams))
      if (!query.success) return errorResponse(400, 'INVALID_REQUEST', 'bad query')
      const { before, limit } = query.data
      const end = before ? messages.findIndex((m) => m.id === before) : messages.length
      if (end === -1) return errorResponse(404, 'NOT_FOUND', 'unknown message')
      const start = Math.max(0, end - limit)
      return Response.json({ messages: messages.slice(start, end), hasMore: start > 0 })
    }
    return errorResponse(404, 'NOT_FOUND', 'not found')
  }

  const onFrame = (ws: ServerWebSocket<SocketData>, frame: NodeFrame) => {
    received.push(frame)
    switch (frame.type) {
      case 'hello':
        hellos += 1
        ws.data.capabilities = frame.data.capabilities
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
          const data: SocketData = { token, valid: tokens.has(token), threadOpen: false, capabilities: [] }
          if (srv.upgrade(req, { data })) return undefined
          return new Response('upgrade failed', { status: 400 })
        }
        if (!url.pathname.startsWith('/v1/') && opts.serve) return opts.serve(req)
        return api(req, url)
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
          if (typeof raw !== 'string') {
            onBinary(ws, raw)
            return
          }
          const result = parseNodeFrame(raw)
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
    receivedAudio,
    pushAudio,
    stopAudio(streamId) {
      for (const ws of audioSockets()) send(ws, 'audio.stop', { streamId })
    },
    setTurnState: (state) => setState(state),
    nodeId,
    pushProactive: (text) => streamAssistant(text, true),
    pushUi: (block, o = {}) => renderUi(block, o.messageId, o.fallbackText),
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
