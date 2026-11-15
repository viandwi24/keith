import { Chat } from '@ai-sdk/svelte'
import {
  answerableOf,
  type ChatItem,
  CONTEXT_HOLD_TEXT,
  type ContextKind,
  type ContextPendingState,
  codeOf,
  currentGenerationOf,
  type DreamMark,
  draftRestoredOf,
  INITIAL_CONTEXT_PENDING,
  marksWith,
  mergeTasks,
  messageOf,
  type NoticeLevel,
  pendingKindOf,
  reduceContextPending,
  runContextCommand,
  SEND_REFUSED_TEXT,
  SESSION_BUSY_TEXT,
  type Settled,
  taskChangedOf,
  toItems,
  withDreamMarks,
} from '@keith/app-model'
import {
  type ChatSession,
  type ChatSessionState,
  frontSessionOf,
  type KeithClient,
  watchChatContext,
  watchChatContextPending,
} from '@keith/client/browser'
import type { Task } from '@keith/contracts'
import { toasts } from '../toasts/index.ts'
import { DreamActivity } from './dream-activity.svelte.ts'
import { helpRows, parseSubmitted, type Submitted } from './slash.ts'
import { type ChatPhase, phaseOf, progressKey } from './status.ts'

/** The last conversation messages that stay mounted. */
const MOUNTED = 200
/** How often a running turn is checked against the core (a silently dead reader is dropped). */
const STALL_CHECK_MS = 3000
const RECONNECTED = 'reconnected'

export interface ChatNotice {
  level: NoticeLevel
  rows: readonly string[]
}

export interface ChatOptions {
  client: KeithClient
  personId: string
  /** `/history`, `/tasks`, `/manage`: a path under the app base. */
  navigate(path: string): void
  /** The rows of `/whoami`. */
  whoami(): readonly string[]
}

/** The front chat of the signed-in person: one AI SDK `Chat` per generation, bound to an eharness chat session. */
export class ChatController {
  generation = $state(0)
  draft = $state('')
  /** A short line under the conversation (a failed send, "reconnected"); an app notice from a command. */
  toast = $state<{ level: NoticeLevel; text: string } | undefined>(undefined)
  notice = $state<ChatNotice | undefined>(undefined)
  settled = $state<Record<string, Settled>>({})
  tasks = $state<readonly Task[]>([])
  pendingState = $state<ContextPendingState>(INITIAL_CONTEXT_PENDING)
  sessionState = $state<ChatSessionState | undefined>(undefined)
  now = $state(Date.now())
  lastProgressAt = $state(Date.now())
  /** Bumped by every send: the list follows it to the bottom. */
  sends = $state(0)
  dream = new DreamActivity()

  chat = $state.raw<Chat | undefined>(undefined)
  session = $state.raw<ChatSession | undefined>(undefined)

  private readonly client: KeithClient
  private readonly options: ChatOptions
  private dreamMountSeq = 0
  private dreamMarks = $state<readonly DreamMark[]>([])
  private sent: string | undefined
  private answering = false
  private offState: (() => void) | undefined
  private offFeeds: (() => void)[] = []
  private root: (() => void) | undefined
  private latestRead = 0
  private compactedSeen = 0

  constructor(options: ChatOptions) {
    this.options = options
    this.client = options.client
  }

  messages = $derived(this.chat?.messages ?? [])
  items: ChatItem[] = $derived(toItems(this.messages.slice(-MOUNTED)))
  shownItems: ChatItem[] = $derived(withDreamMarks(this.items, this.dreamMarks))
  status = $derived(this.chat?.status ?? 'ready')
  busy = $derived(
    (this.sessionState?.busy ?? false) ||
      this.status === 'submitted' ||
      this.status === 'streaming',
  )
  pending: ContextKind | undefined = $derived(pendingKindOf(this.pendingState))
  last = $derived(this.items.at(-1))
  answerable = $derived(answerableOf(this.items, this.settled))
  phase: ChatPhase = $derived(
    phaseOf({
      status: this.status,
      busy: this.busy,
      answering: this.last?.kind === 'assistant',
      lastProgressAt: this.lastProgressAt,
      now: this.now,
    }),
  )
  interrupted = $derived(!this.busy && (this.session?.interrupted() ?? false))
  /** The stored notice of an interrupted turn already says it: the live row is not repeated. */
  storedInterrupted = $derived(
    this.last?.kind === 'notice' && this.last.code === 'EH_TURN_INTERRUPTED',
  )
  loaded = $derived(this.sessionState?.loaded ?? false)
  hasOlder = $derived(this.sessionState?.hasOlder ?? false)
  loadingOlder = $derived(this.sessionState?.loadingOlder ?? false)

  start(): void {
    this.stop()
    this.dream.start(this.client)
    this.dreamMountSeq = this.dream.lastSeq
    this.offFeeds.push(
      watchChatContext({ feed: this.client.feed(), refetch: () => this.readGeneration() }),
      watchChatContextPending({
        feed: this.client.feed(),
        onRecord: (record) => this.fold({ type: 'feed', record }),
        onResync: () => this.fold({ type: 'resync' }),
      }),
      this.client.feed().subscribeEvents((record) => {
        const task = taskChangedOf(record)
        if (task !== undefined) this.tasks = mergeTasks(this.tasks, [task])
      }),
    )
    void this.client.rpc.tasks.list({ limit: 20 }).then(
      (rows) => {
        this.tasks = mergeTasks(this.tasks, rows)
      },
      () => undefined,
    )
    this.bind(0)
    this.readGeneration()
    this.root = $effect.root(() => {
      // the clock and the stall check run only while a turn runs
      $effect(() => {
        if (!this.busy) return
        this.lastProgressAt = Date.now()
        const tick = setInterval(() => {
          this.now = Date.now()
        }, 1000)
        const check = setInterval(() => void this.session?.checkStalled(), STALL_CHECK_MS)
        return () => {
          clearInterval(tick)
          clearInterval(check)
        }
      })
      // anything the conversation changes counts as progress
      $effect(() => {
        progressKey(this.messages)
        this.lastProgressAt = Date.now()
        this.now = this.lastProgressAt
      })
      // `busy` is computed when the session patches: tell it when the chat status changed
      $effect(() => {
        this.status
        this.session?.refreshBusy()
        if (this.status === 'streaming') this.sent = undefined
      })
      // a `/compact` ended: read the stored messages again so the compaction marker shows
      $effect(() => {
        const n = this.pendingState.compacted
        if (n === this.compactedSeen) return
        this.compactedSeen = n
        void this.session?.refetch().catch(() => undefined)
      })
      // the dividers of the dreams that finished after this chat mounted, each after the item that was last then
      $effect(() => {
        this.dreamMarks = marksWith(
          this.dreamMarks,
          this.dream.finishes,
          this.dreamMountSeq,
          this.last?.id,
        ) as DreamMark[]
      })
      // the answer is being followed again: the error line gives way to a short note, then goes
      $effect(() => {
        if (this.sessionState?.following)
          this.toast =
            this.toast === undefined || this.toast.text === RECONNECTED
              ? this.toast
              : { level: 'info', text: RECONNECTED }
        else if (!this.busy && this.toast?.text === RECONNECTED) this.toast = undefined
      })
    })
  }

  stop(): void {
    this.root?.()
    this.root = undefined
    for (const off of this.offFeeds) off()
    this.offFeeds = []
    this.dream.stop()
    this.unbind()
  }

  private fold(event: Parameters<typeof reduceContextPending>[1]): void {
    this.pendingState = reduceContextPending(this.pendingState, event)
  }

  /** The current generation is the last of `chat.generations`; only the newest read counts. */
  private readGeneration(): void {
    const mine = ++this.latestRead
    this.client.chatContext.generations().then(
      (list) => {
        if (mine !== this.latestRead) return
        const next = currentGenerationOf(list)
        if (next !== this.generation) this.bind(next)
      },
      () => undefined,
    )
  }

  private unbind(): void {
    this.offState?.()
    this.offState = undefined
    this.session?.bind(undefined)
    this.session = undefined
    this.chat = undefined
    this.sessionState = undefined
  }

  private bind(generation: number): void {
    this.unbind()
    this.generation = generation
    this.settled = {}
    const session = this.client.chat(frontSessionOf(this.options.personId, generation), {
      notify: (level, text) => this.notify(level, text),
    })
    const chat = new Chat({ ...session.chatInit })
    session.bind(chat)
    this.session = session
    this.chat = chat
    this.offState = session.subscribe((s) => {
      this.sessionState = s
    })
    void session.init()
  }

  private notify(level: 'info' | 'error', text: string): void {
    const refused = this.sent
    if (text === SESSION_BUSY_TEXT && refused !== undefined) {
      this.sent = undefined
      this.draft = draftRestoredOf(this.draft, refused)
      this.toast = { level: 'warning', text: SEND_REFUSED_TEXT }
    } else this.toast = { level: level === 'error' ? 'error' : 'info', text }
  }

  /** Run what the composer holds. */
  submit(): void {
    const line = this.draft
    const parsed = parseSubmitted(line)
    if (parsed.kind === 'empty') return
    // a plain message waits while a context change runs: the draft stays, nothing is sent (the core refuses it)
    if (this.pending !== undefined && parsed.kind === 'message') {
      this.toast = { level: 'info', text: CONTEXT_HOLD_TEXT }
      return
    }
    this.draft = ''
    this.toast = undefined
    this.notice = undefined
    this.run(parsed)
  }

  private say(level: NoticeLevel, rows: readonly string[]): void {
    this.notice = { level, rows }
  }

  private run(parsed: Submitted): void {
    switch (parsed.kind) {
      case 'message':
        this.sendText(parsed.text)
        break
      case 'new':
      case 'compact':
        runContextCommand(parsed, {
          chatContext: this.client.chatContext,
          toast: (text, level) => toasts.push(text, { level }),
          say: (level, rows) => this.say(level, rows),
          pending: {
            begin: (kind) => this.fold({ type: 'local-start', kind }),
            end: (kind) => this.fold({ type: 'local-end', kind }),
          },
        })
        break
      case 'usage':
        this.say('info', [parsed.text])
        break
      case 'unknown':
        this.say('warning', [parsed.text])
        break
      case 'help':
        this.say('info', helpRows())
        break
      case 'whoami':
        this.say('info', this.options.whoami())
        break
      case 'history':
        this.options.navigate('/chat/history')
        break
      case 'goto':
        this.options.navigate(parsed.path)
        break
      case 'continue':
      case 'retry':
        if (this.session?.interrupted() !== true)
          this.toast = { level: 'info', text: 'No interrupted turn.' }
        else if (parsed.kind === 'continue') void this.session.continueTurn()
        else void this.session.retryTurn()
        break
      case 'empty':
        break
    }
  }

  /** Send a plain message (also used by the Continue and Retry buttons through `run`). */
  sendText(text: string): void {
    this.sent = text
    this.sends += 1
    void this.session?.send(text)
  }

  continueTurn(): void {
    this.run({ kind: 'continue' })
  }
  retryTurn(): void {
    this.run({ kind: 'retry' })
  }
  stopTurn(): void {
    if (this.busy) void this.session?.stop()
  }
  loadOlder(): Promise<number> {
    return this.session?.loadOlder() ?? Promise.resolve(0)
  }
  loadFull(messageId: string): Promise<unknown> {
    return this.session?.loadFull(messageId) ?? Promise.resolve(undefined)
  }
  dismissProblem(): void {
    this.session?.dismissProblem()
  }

  /** Answer an open question of a protocol run with one of its options. */
  answer(item: Extract<ChatItem, { kind: 'question' }>, option: string): void {
    if (this.answering || this.settled[item.id] !== undefined) return
    this.answering = true
    this.client.rpc.protocols
      .answer({ runId: item.runId, option })
      .then(
        () => {
          this.settled = { ...this.settled, [item.id]: { kind: 'answered', option } }
        },
        (error: unknown) => {
          if (codeOf(error) === 'CONFLICT') {
            this.settled = { ...this.settled, [item.id]: { kind: 'closed' } }
            this.toast = { level: 'warning', text: 'question closed' }
          } else this.toast = { level: 'error', text: messageOf(error) }
        },
      )
      .finally(() => {
        this.answering = false
      })
  }
}
