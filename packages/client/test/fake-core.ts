import {
  AUDIO_FRAME_KIND,
  type AudioFrame,
  type AudioStreamId,
  type CoreFrameType,
  decodeAudioFrame,
  encodeAudioFrame,
  type FrameData,
  InviteAcceptRequest,
  LoginRequest,
  type MessageDto,
  type MessageId,
  MessagesQuery,
  makeFrame,
  type NodeFrame,
  type PersonDto,
  parseNodeFrame,
  type RelaySender,
  type ThreadDto,
  type ThreadId,
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
 * frames and can speak a stream of PCM16 chunks to `audio.out@1` sockets. Phase 5: group threads
 * (`addGroup`) in `GET /v1/threads` and `thread.open`, `thread.close`, pushed `thread.updated` /
 * `thread.removed`, and `POST /v1/auth/invite`. It listens on 127.0.0.1 with a random port and
 * never touches the network. Test-only: it uses `Bun.serve`.
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

type SocketData = {
  token: string
  valid: boolean
  /** The thread this socket has open (one at a time, like the real nodes), or null. */
  openThread: ThreadId | null
  capabilities: string[]
}

/** The invite code `POST /v1/auth/invite` accepts by default (43 characters, like a real one). */
export const FAKE_INVITE_CODE = 'fake-invite-code-0123456789abcdefghijklmnopq'

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
  /** Phase 5: the code `POST /v1/auth/invite` accepts once. Default `FAKE_INVITE_CODE`. */
  inviteCode?: string
  /** Phase 5: usernames that belong to someone else: an invite with one answers 400. */
  takenUsernames?: string[]
}

/** Phase 5: a group thread for `FakeCore.addGroup`. The fake person is always a participant. */
export type FakeGroupOptions = {
  title: string
  purpose?: string
  /** The other current participants. */
  others?: PersonDto[]
  formerParticipants?: PersonDto[]
  /** History messages: text, and who wrote it (a person id, or null for the Mind). */
  messages?: { content: string; authorPersonId: PersonDto['id'] | null }[]
  /** Default: newer than every existing thread. */
  updatedAt?: number
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
  /** The person's main (direct) thread. */
  readonly thread: ThreadDto
  /** The main thread's messages. */
  readonly messages: MessageDto[]
  /** Phase 5: the threads `GET /v1/threads` lists (the main thread and the groups), in no order. */
  readonly threads: ThreadDto[]
  /** Phase 5: the messages of any thread. */
  messagesOf(threadId: ThreadId): MessageDto[]
  /** Phase 5: the thread a socket has open, one entry per connected socket. */
  openThreads(): (ThreadId | null)[]
  /** Phase 5: the username and password a login accepts now (an accepted invite changes them). */
  readonly credentials: { username: string; password: string }
  /** Every node frame received, in order. */
  readonly received: NodeFrame[]
  /** Number of `hello`s received (one per connection). */
  readonly hellos: number
  /** Every binary frame received that decoded, in order. */
  readonly receivedAudio: AudioFrame[]
  readonly nodeId: `nod_${string}`
  /**
   * Sends an unsolicited assistant message to every socket with the thread open (I-11). Phase 5:
   * `threadId` (default main) and `relayFrom` (the message's `meta.relayFrom`).
   */
  pushProactive(text: string, opts?: { threadId?: ThreadId; relayFrom?: RelaySender[] }): Promise<MessageDto>
  /**
   * Phase 5: adds a group thread the person is a participant of. It is listed at once, and
   * `thread.updated` goes to every connected socket (as when a group is created or joined).
   */
  addGroup(opts: FakeGroupOptions): ThreadDto
  /** Phase 5: replaces a listed thread (same id) and sends `thread.updated` to every socket. */
  pushThreadUpdated(thread: ThreadDto): void
  /**
   * Phase 5: the person left the thread. It is no longer listed or openable, and `thread.removed`
   * goes to every socket; the sockets that had it open are detached from it.
   */
  pushThreadRemoved(threadId: ThreadId): void
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
  const threads: ThreadDto[] = [thread]
  const threadMessages = new Map<ThreadId, MessageDto[]>([[thread.id, messages]])
  const credentials = { username, password }
  let inviteCode: string | null = opts.inviteCode ?? FAKE_INVITE_CODE
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

  const messagesOf = (threadId: ThreadId): MessageDto[] => {
    let list = threadMessages.get(threadId)
    if (!list) {
      list = []
      threadMessages.set(threadId, list)
    }
    return list
  }

  const findThread = (threadId: ThreadId): ThreadDto | undefined => threads.find((t) => t.id === threadId)

  /** Sends to every socket with `threadId` open (and `capability`, when given). */
  const broadcast = <T extends CoreFrameType>(
    type: T,
    data: FrameData<T>,
    capability?: string,
    threadId: ThreadId = thread.id,
  ) => {
    for (const ws of sockets) {
      if (ws.data.openThread !== threadId) continue
      if (capability && !ws.data.capabilities.includes(capability)) continue
      send(ws, type, data)
    }
  }

  const broadcastAll = <T extends CoreFrameType>(type: T, data: FrameData<T>) => {
    for (const ws of sockets) send(ws, type, data)
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
    [...sockets].filter(
      (ws) => ws.data.openThread === thread.id && ws.data.capabilities.includes('audio.out@1'),
    )

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

  const setState = (state: ThreadDto['state'], target: ThreadDto = thread) => {
    target.state = state
    broadcast('thread.state', { threadId: target.id, state }, undefined, target.id)
  }

  const tick = () => Bun.sleep(opts.tickMs ?? 2)

  const streamAssistant = async (
    text: string,
    proactive: boolean,
    ui?: UiBlock,
    target: ThreadDto = thread,
    relayFrom?: RelaySender[],
  ): Promise<MessageDto> => {
    const messageId: MessageId = fakeId('msg', nextId())
    const threadId = target.id
    setState('speaking', target)
    broadcast('message.started', { threadId, messageId, proactive }, undefined, threadId)
    const words = text.split(/(?<= )/)
    for (const [i, word] of words.entries()) {
      await tick()
      broadcast('message.delta', { threadId, messageId, text: word }, undefined, threadId)
      if (ui && i === 0) renderUi(ui, messageId)
    }
    const meta = { ...(proactive ? { proactive: true } : {}), ...(relayFrom ? { relayFrom } : {}) }
    const message: MessageDto = {
      id: messageId,
      threadId,
      role: 'assistant',
      authorPersonId: null,
      modality: 'text',
      content: text,
      createdAt: Date.now(),
      ...(ui ? { ui: [ui] } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    }
    messagesOf(threadId).push(message)
    broadcast('message.completed', { message }, undefined, threadId)
    setState('idle', target)
    return message
  }

  const onInput = async (text: string, target: ThreadDto) => {
    const threadId = target.id
    messagesOf(threadId).push({
      id: fakeId('msg', nextId()),
      threadId,
      role: 'user',
      authorPersonId: person.id,
      modality: 'text',
      content: text,
      createdAt: Date.now(),
    })
    setState('thinking', target)
    await tick()
    if (opts.toolActivity) {
      const messageId: MessageId = fakeId('msg', nextId())
      const base = { threadId, messageId, toolCallId: 'call_1', name: 'web.search' }
      broadcast('tool.activity', { ...base, status: 'started', summary: 'searching' }, undefined, threadId)
      await tick()
      broadcast('tool.activity', { ...base, status: 'completed', summary: '3 results' }, undefined, threadId)
    }
    await streamAssistant(reply(text), false, opts.replyUi?.(text), target)
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
    if (url.pathname === '/v1/threads') return Response.json({ threads })
    const page = /^\/v1\/threads\/([^/]+)\/messages$/.exec(url.pathname)
    const listed = page ? threads.find((t) => t.id === decodeURIComponent(page[1] ?? '')) : undefined
    if (listed) {
      const query = MessagesQuery.safeParse(Object.fromEntries(url.searchParams))
      if (!query.success) return errorResponse(400, 'INVALID_REQUEST', 'bad query')
      const { before, limit } = query.data
      const messages = messagesOf(listed.id)
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
      case 'thread.open': {
        const target = frame.data.threadId === undefined ? thread : findThread(frame.data.threadId)
        if (!target) {
          send(ws, 'error', { code: 'FORBIDDEN', message: 'not a participant of this thread' }, frame.id)
          return
        }
        ws.data.openThread = target.id
        const history = messagesOf(target.id).slice(-(frame.data.historyLimit ?? 50))
        send(ws, 'thread.opened', { thread: target, messages: history }, frame.id)
        return
      }
      case 'thread.close':
        if (ws.data.openThread === frame.data.threadId) ws.data.openThread = null
        return
      case 'input.text': {
        const target = findThread(frame.data.threadId)
        if (!target || ws.data.openThread !== target.id) {
          send(ws, 'error', { code: 'FORBIDDEN', message: 'thread not open' }, frame.id)
          return
        }
        void onInput(frame.data.text, target)
        return
      }
      case 'input.cancel': {
        const target = findThread(frame.data.threadId)
        if (target) setState('idle', target)
        return
      }
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
          if (body.data.username !== credentials.username || body.data.password !== credentials.password) {
            return Response.json(
              { error: { code: 'UNAUTHORIZED', message: 'bad credentials' } },
              { status: 401 },
            )
          }
          const token = `tok-${nextId()}`
          tokens.add(token)
          return Response.json({ token, person, expiresAt: Date.now() + 86_400_000 })
        }
        if (url.pathname === '/v1/auth/invite' && req.method === 'POST') {
          const body = InviteAcceptRequest.safeParse(await req.json().catch(() => null))
          if (!body.success) {
            return Response.json({ error: { code: 'INVALID_REQUEST', message: 'bad body' } }, { status: 400 })
          }
          if (inviteCode === null || body.data.code !== inviteCode) {
            return Response.json(
              { error: { code: 'UNAUTHORIZED', message: 'invalid invite code' } },
              { status: 401 },
            )
          }
          if (opts.takenUsernames?.includes(body.data.username)) {
            return Response.json(
              { error: { code: 'INVALID_REQUEST', message: `username '${body.data.username}' is taken` } },
              { status: 400 },
            )
          }
          inviteCode = null
          credentials.username = body.data.username
          credentials.password = body.data.password
          // Accepting ends the person's old sessions.
          tokens.clear()
          const token = `tok-${nextId()}`
          tokens.add(token)
          return Response.json({ token, person, expiresAt: Date.now() + 86_400_000 })
        }
        if (url.pathname === '/v1/ws') {
          const token = url.searchParams.get('token') ?? ''
          const data: SocketData = { token, valid: tokens.has(token), openThread: null, capabilities: [] }
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
    threads,
    messagesOf,
    openThreads: () => [...sockets].map((ws) => ws.data.openThread),
    credentials,
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
    pushProactive(text, o = {}) {
      const target = o.threadId === undefined ? thread : findThread(o.threadId)
      if (!target) throw new Error(`fake core: unknown thread ${o.threadId}`)
      return streamAssistant(text, true, undefined, target, o.relayFrom)
    },
    addGroup(o) {
      const group: ThreadDto = {
        id: fakeId('thr', nextId()),
        kind: 'group',
        title: o.title,
        participants: [person, ...(o.others ?? [])],
        state: 'idle',
        updatedAt: o.updatedAt ?? Math.max(...threads.map((t) => t.updatedAt)) + 1,
        ...(o.purpose !== undefined ? { purpose: o.purpose } : {}),
        ...(o.formerParticipants ? { formerParticipants: o.formerParticipants } : {}),
      }
      threads.push(group)
      const list = messagesOf(group.id)
      for (const [i, m] of (o.messages ?? []).entries()) {
        list.push({
          id: fakeId('msg', nextId()),
          threadId: group.id,
          role: m.authorPersonId === null ? 'assistant' : 'user',
          authorPersonId: m.authorPersonId,
          modality: 'text',
          content: m.content,
          createdAt: i + 1,
        })
      }
      broadcastAll('thread.updated', { thread: group })
      return group
    },
    pushThreadUpdated(updated) {
      const index = threads.findIndex((t) => t.id === updated.id)
      if (index === -1) threads.push(updated)
      else threads[index] = updated
      broadcastAll('thread.updated', { thread: updated })
    },
    pushThreadRemoved(threadId) {
      const index = threads.findIndex((t) => t.id === threadId)
      if (index !== -1) threads.splice(index, 1)
      broadcastAll('thread.removed', { threadId })
      for (const ws of sockets) if (ws.data.openThread === threadId) ws.data.openThread = null
    },
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
