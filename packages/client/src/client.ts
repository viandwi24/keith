import {
  type AuditMineInput,
  type BrainEvent,
  type KeithContract,
  type MyAuditEvent,
  type PluginFeedEvent,
  parseBrainEvent,
  parsePluginEvent,
  type ViewMenu,
} from '@keith/contracts'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { readUIMessageStream, type UIMessage } from 'ai'
import {
  type ActivityFeed,
  type AnswerResponse,
  ATTENTION_EVENTS,
  type AttentionItemWire,
  type AttentionList,
  type ChatSession,
  createActivityFeed,
  createAttentionList,
  createChatSession,
  createHarnessClient,
  type HarnessClient,
  type ResyncReason,
} from 'eharness/client'
import { type LogsApi, logsApiOf } from './activity-logs.ts'
import { type ChatContextApi, chatContextApiOf } from './chat-context.ts'
import { type DreamingApi, dreamingApiOf } from './dreaming.ts'
import { StepUpError, stepUp } from './password.ts'
import { type PersonaApi, personaApiOf } from './persona.ts'
import { type RoomsApi, roomsApiOf } from './rooms.ts'
import { fetchViewMenu, ViewMenuError } from './view/menu.ts'
import { type OpenViewOptions, openView, type ViewConnection } from './view/open-view.ts'

/** An approval (or other item) that waits for the owner, as `GET /attention` lists it. */
export type AttentionItem = AttentionItemWire

/** The owner's inbox: an eharness `AttentionList` plus the three approval answers. */
export interface KeithAttention extends AttentionList {
  /** Allow this call once. */
  approve(item: AttentionItem): Promise<AnswerResponse>
  /** Deny this call; `reason` is told to the model. */
  deny(item: AttentionItem, reason?: string): Promise<AnswerResponse>
  /** Allow this call and the same grant (node + capability) for the rest of the session. */
  approveForSession(item: AttentionItem): Promise<AnswerResponse>
}

/** Activity events that refetch the inbox: the library's plus the amygdala's wait. */
export const KEITH_ATTENTION_EVENTS: readonly string[] = [
  ...ATTENTION_EVENTS,
  'brain.amygdala.wait',
]

/** Characters after which the core clips a tool or data payload in a history read (`?clip=`). */
export const CHAT_CLIP = 2000

export interface KeithClientOptions {
  /** Core URL, e.g. `http://localhost:7420`. */
  baseUrl: string
  /** Owner token (`Authorization: Bearer`). Omit on the local socket (`fetch` with `unix`): there the socket is the login. */
  token?: string
  fetch?: typeof fetch
  /**
   * The Unix socket `fetch` talks to (`socketFetch(path)`). Plugin views upgrade over it as `ws+unix`, so a client with no
   * token can open one: the socket's principal is resolved as for HTTP (a locked socket answers 423, trust `none` needs a token).
   */
  socketPath?: string
}

export interface KeithClient {
  /** Chat, history and interrupts (`eharness/http` under `/sessions`). */
  harness: HarnessClient
  /** The Keith contract (`/rpc`): health, providers, model roles. */
  rpc: ContractRouterClient<KeithContract>
  /** The shared rooms (`rpc.rooms.*`) as one typed object; the transcript of one room is `createRoomEvents` (rooms.ts). */
  rooms: RoomsApi
  /** The persona and the reply style (`rpc.persona.*`) as one typed object (persona.ts). */
  persona: PersonaApi
  /** The reset and compaction of the front session (`rpc.chat.*`) as one typed object (chat-context.ts). */
  chatContext: ChatContextApi
  /** The memory dreaming of the caller's own memory (`rpc.dream.*`) as one typed object (dreaming.ts). */
  dreaming: DreamingApi
  /** The activity logs of model calls (`rpc.logs.*`) as one typed object (activity-logs.ts). */
  logs: LogsApi
  /** The audit log as the person may read it. */
  audit: {
    /**
     * The lines about this person: who looked at or changed something of theirs, newest first (`admin.audit.mine`,
     * every role). `before` is the `id` of the last line of the previous page. The owner may pass `person` to read
     * another person's lines.
     */
    mine(input?: AuditMineInput): Promise<MyAuditEvent[]>
  }
  /**
   * Log out: revoke the credential this client uses (`auth.logout`). Afterwards every call is 401.
   * A no-op on the local socket (the socket is the login). The caller removes the stored token.
   */
  revokeSelf(): Promise<void>
  /**
   * Step up this client's session with the PIN or the password (`POST /auth/step-up`); resolves with
   * `elevatedUntil` (epoch ms). Rejects with a `StepUpError` (also `unauthorized` when the client
   * has no token: the local socket is always elevated and never needs it).
   */
  stepUp(secret: { pin: string } | { password: string }): Promise<{ elevatedUntil: number }>
  /**
   * The plugin terminal views this person may open (`GET /plugins/tui/menu`, docs/specs/plugin-views.md). Rejects with
   * `ViewMenuError` (`unauthorized` for a 401, else `unavailable`).
   */
  viewMenu(): Promise<ViewMenu>
  /**
   * Open a plugin terminal view over `/plugins/views/ws` with this client's credential, or over the local socket
   * (`socketPath`, no token needed). Without either it throws `ViewMenuError('unauthorized')`.
   */
  openView(options: Omit<OpenViewOptions, 'core' | 'credential'>): ViewConnection
  /** A chat session for an AI SDK `Chat` / `useChat` (eharness/client). */
  chat(sessionId: string): ChatSession
  /**
   * Keep a chat session in step with the feed (a session from `chat()` is attached already; call
   * this for one a UI hook created). While it is busy the feed pings the core; after a core
   * restart or a resync it refetches, then follows the turn when one still runs. Returns detach.
   */
  attachChat(session: ChatSession): () => void
  /**
   * Tell the client a chat session raised a toast (call it from the session's `notify`). On
   * `level === 'error'` an attached, idle session asks the core whether the turn runs and re-attaches
   * (`followServerTurn`): a send whose response stream dropped before the first words is reported
   * as a failed send by eharness, which does not follow, although the core keeps the turn running.
   * Ignored for `info` and for a session that is not attached. Never throws.
   */
  reportChatNotice(session: ChatSession, level: 'info' | 'error'): void
  /**
   * Send one text message and yield the assistant message as it streams (each value is the whole
   * message so far). Without a chat framework: scripts, tests, simple UIs.
   */
  /** Send a message and stream the answer; without `sessionId`, your own front session (from `auth.whoami`). */
  reply(text: string, sessionId?: string): AsyncGenerator<UIMessage>
  /**
   * The activity feed (`/activity/stream`): one lazy eharness `ActivityFeed` per client, started by
   * its first subscriber. History is not replayed: the first connection delivers only new events;
   * refetch state (e.g. `rpc.tasks.list`) on `subscribeResync`. Type records with `brainEventsOf`.
   */
  feed(): ActivityFeed
  /**
   * What waits for the owner (`/attention`): one lazy `AttentionList` per client, attached to
   * `feed()` so it refetches on {@link KEITH_ATTENTION_EVENTS} and on every resync. Answers are
   * optimistic (the item leaves at once; a failure puts it back, except 404/409: it stays gone and
   * the error is rethrown). Call `refresh()` once for the first list; items are oldest first as
   * the core lists them. Attaching subscribes to the feed but does not start it.
   */
  attention(): KeithAttention
}

/** The typed brain event of an activity record, or undefined for any other record. */
export function brainEventOf(record: { type: string; payload: unknown }): BrainEvent | undefined {
  return parseBrainEvent(record)
}

/** The typed plugin event of an activity record (`plugin.<id>.<event>`), or undefined for any other record. */
export function pluginEventOf(record: {
  type: string
  payload: unknown
}): PluginFeedEvent | undefined {
  return parsePluginEvent(record)
}

/**
 * The front session of a person: `front:<personId>` for generation 0 (get the id from `rpc.auth.whoami()`), and
 * `front:<personId>:g<n>` for generation `n` (the current one is the last of `rpc.chat.generations()`).
 */
export const frontSessionOf = (personId: string, generation = 0): string =>
  generation === 0 ? `front:${personId}` : `front:${personId}:g${generation}`

export function createKeithClient(options: KeithClientOptions): KeithClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const headers = (): Record<string, string> =>
    options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }
  const harness = createHarnessClient({
    baseUrl,
    headers,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const link = new RPCLink({
    url: `${baseUrl}/rpc`,
    headers,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const rpc: ContractRouterClient<KeithContract> = createORPCClient(link)

  let feed: ActivityFeed | undefined
  let attention: KeithAttention | undefined
  const chats = new Set<ChatSession>()
  const bootListeners = new Set<(restarted: boolean) => void>()
  /** Per attached session: recover after a failed send (see `reportChatNotice`). */
  const sendFailed = new Map<ChatSession, () => void>()
  const feedOf = (): ActivityFeed => {
    feed ??= createActivityFeed({
      client: harness,
      isBusy: () => [...chats].some((c) => c.get().busy),
      onBoot: (_id, restarted) => {
        if (restarted) for (const fn of [...bootListeners]) fn(true)
      },
    })
    return feed
  }
  const attachChat = (session: ChatSession): (() => void) => {
    chats.add(session)
    let running = false
    let again = false
    const recover = async (): Promise<void> => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          await session.refetch()
          if (await isRunning(harness, session.sessionId)) await session.follow()
        } while (again)
      } finally {
        running = false
      }
    }
    // a send failed (the response stream dropped before the first words): the core may still run the
    // turn. `failed` stays set until a probe reached the core, so a feed reconnect retries it.
    let failed = false
    let probing = false
    const recoverSend = async (): Promise<void> => {
      failed = true
      if (probing) return
      probing = true
      try {
        // the failed send is still `sending` for a moment: followServerTurn skips a busy session
        // `busy` is computed from the chat status the UI rendered last: refresh it while waiting
        for (let i = 0; i < 40; i++) {
          session.refreshBusy()
          if (!session.get().busy) break
          await sleep(50)
        }
        for (let attempt = 0; attempt < 6 && failed; attempt++) {
          if (attempt > 0) await sleep(500 * attempt)
          if (session.get().busy) {
            failed = false // something else (a follow, a new send) took over
            return
          }
          if (!(await reachable(harness, session.sessionId))) continue
          failed = false
          await session.followServerTurn()
        }
      } finally {
        probing = false
      }
    }
    sendFailed.set(session, () => void recoverSend())
    const onResync = (reason: ResyncReason): void => {
      const state = session.get()
      if (failed && !state.busy) {
        void recoverSend()
        return
      }
      // the first connect: init() loads the history; a turn this chat reads is not disturbed
      if (reason === 'connect' && (!state.loaded || state.busy)) return
      if (state.busy) return
      void recover()
    }
    const onBoot = (): void => {
      if (failed && !session.get().busy) void recoverSend()
      else if (!session.get().busy) void recover()
    }
    // a turn the core started on its own (a wake after a worker report, an event, another tab):
    // the feed announces it; follow it, and refetch what it stored once it is over. One loop at
    // a time: records that arrive meanwhile only set a flag.
    let wantFollow = false
    let wantStored = false
    let serving = false
    const serve = async (): Promise<void> => {
      if (serving) return
      serving = true
      try {
        while (wantFollow || wantStored) {
          if (wantFollow) {
            wantFollow = false
            await session.followServerTurn()
          }
          if (wantStored) {
            wantStored = false
            await session.storedElsewhere()
          }
        }
      } finally {
        serving = false
      }
    }
    const onRecord = (record: { type: string; sessionId: string | null }): void => {
      if (record.sessionId !== session.sessionId) return
      // a busy session already reads its own turn (followServerTurn skips it too)
      if (record.type === 'turn-started' && !session.get().busy) wantFollow = true
      // storedElsewhere refetches now, or after the turn this chat streams
      else if (record.type === 'turn-ended') wantStored = true
      else return
      void serve()
    }
    const offResync = feedOf().subscribeResync(onResync)
    const offEvents = feedOf().subscribeEvents(onRecord)
    bootListeners.add(onBoot)
    return () => {
      chats.delete(session)
      sendFailed.delete(session)
      bootListeners.delete(onBoot)
      offResync()
      offEvents()
    }
  }

  return {
    harness,
    rpc,
    rooms: roomsApiOf({ rpc }),
    persona: personaApiOf({ rpc }),
    chatContext: chatContextApiOf({ rpc }),
    dreaming: dreamingApiOf({ rpc }),
    logs: logsApiOf({ rpc }),
    audit: { mine: (input = {}) => rpc.admin.audit.mine(input) },
    stepUp: (secret) => {
      if (options.token === undefined)
        return Promise.reject(new StepUpError('unauthorized', 'this client has no credential'))
      return stepUp({
        core: baseUrl,
        token: options.token,
        ...secret,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    },
    revokeSelf: async () => {
      await rpc.auth.logout()
    },
    viewMenu: () => {
      if (options.token === undefined && options.socketPath === undefined)
        return Promise.reject(new ViewMenuError('unauthorized', 'this client has no credential'))
      return fetchViewMenu({
        core: baseUrl,
        ...(options.token === undefined ? {} : { credential: options.token }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    },
    openView: (viewOptions) => {
      if (options.token === undefined && options.socketPath === undefined)
        throw new ViewMenuError('unauthorized', 'this client has no credential')
      return openView({
        ...viewOptions,
        core: baseUrl,
        ...(options.token === undefined ? {} : { credential: options.token }),
        ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
      })
    },
    feed: feedOf,
    attention: () => {
      if (attention === undefined) {
        const list = createAttentionList({ client: harness, events: KEITH_ATTENTION_EVENTS })
        list.attach(feedOf())
        const approval = (item: AttentionItem, answer: { approved: boolean; reason?: string }) =>
          list.answer(item, { kind: 'approval', ...answer })
        attention = {
          ...list,
          approve: (item) => approval(item, { approved: true }),
          deny: (item, reason) =>
            approval(
              item,
              reason === undefined ? { approved: false } : { approved: false, reason },
            ),
          approveForSession: (item) =>
            list.answer(item, { kind: 'approval', approved: true, remember: 'session' }),
        }
      }
      return attention
    },
    attachChat,
    reportChatNotice: (session, level) => {
      if (level === 'error') sendFailed.get(session)?.()
    },
    chat: (sessionId) => {
      const session = createChatSession({ client: harness, sessionId, clip: CHAT_CLIP })
      attachChat(session)
      return session
    },
    async *reply(text, sessionId) {
      const target =
        sessionId ??
        frontSessionOf(
          (await rpc.auth.whoami()).personId,
          (await rpc.chat.generations()).at(-1)?.generation ?? 0,
        )
      const message: UIMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
      }
      const sent = await harness.sessions.send(target, message)
      if (sent.kind === 'queued' || sent.response.body === null) return
      const chunks = sent.response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(sseToChunks())
      yield* readUIMessageStream({ stream: chunks })
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether the core answers a snapshot read of the session. */
async function reachable(harness: HarnessClient, sessionId: string): Promise<boolean> {
  try {
    await harness.sessions.get(sessionId)
    return true
  } catch {
    return false
  }
}

/** Whether the core says a turn of the session runs (`running` or an active turn). */
async function isRunning(harness: HarnessClient, sessionId: string): Promise<boolean> {
  try {
    const snapshot = await harness.sessions.get(sessionId)
    return snapshot.running || (snapshot.activeTurn ?? null) !== null
  } catch {
    return false
  }
}

/** Server-sent events of a UI message stream → the JSON chunks. */
function sseToChunks(): TransformStream<string, never> {
  let buffer = ''
  return new TransformStream({
    transform(text, controller) {
      buffer += text
      let end = buffer.indexOf('\n\n')
      while (end !== -1) {
        const event = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data !== '' && data !== '[DONE]') controller.enqueue(JSON.parse(data) as never)
        }
        end = buffer.indexOf('\n\n')
      }
    },
  })
}
