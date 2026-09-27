// Threads: turn state, queued input, cancellation, focus, streaming to attached nodes, delivery
// flushes and arrival holds. See docs/architecture/core.md#threads-and-turn-state.

import {
  type CoreFrame,
  type ErrorCode,
  MESSAGES_PAGE,
  type MessageDto,
  makeFrame,
  type ThreadDto,
  uiBlockToText,
} from '@keith/protocol'
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type EventBus,
  isKeithError,
  KeithError,
  type KeithErrorCode,
  type Tool,
  type ToolAction,
  type ToolResult,
} from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { CoreServiceRegistry, CoreToolRegistry } from '../plugins/types.ts'
import type { DeliveryQueue, Scheduler } from '../scheduler/types.ts'
import type { NodeSink, Presence } from '../server/types.ts'
import type {
  Clock,
  Delivery,
  Ids,
  Logger,
  MessageId,
  NodeId,
  PersonDto,
  PersonId,
  ThreadId,
  TurnKind,
  TurnState,
  UiBlock,
} from '../shared/types.ts'
import type {
  AssistantMessageRecord,
  MessageMeta,
  MessageRecord,
  MessageUiEntry,
  Repositories,
  ThreadRecord,
  UserMessageRecord,
} from '../storage/types.ts'
import type { SpeechHandle, VoiceOutput } from '../voice/types.ts'
import { lowestTier, toMessageDto } from './messages.ts'
import type { Arrival, ContextBuilder, RunLoop, RunLoopEvent, RunLoopResult, ThreadManager } from './types.ts'
import { findUiAction, idsFreeIn, validUiBlock } from './ui.ts'

export type ThreadManagerDeps = {
  /** `voice` (phase 3) sets barge-in; absent, barge-in is on with no minimum duration. */
  config: Pick<KeithConfig, 'mind'> & Partial<Pick<KeithConfig, 'voice'>>
  repos: Pick<Repositories, 'persons' | 'threads' | 'messages' | 'nodes'>
  nodes: NodeSink
  presence: Pick<Presence, 'isPresent'>
  scheduler: Scheduler
  deliveries: Pick<DeliveryQueue, 'pendingFor' | 'markDelivered'>
  context: ContextBuilder
  runLoop: RunLoop
  events: Pick<EventBus, 'on' | 'emit'>
  ids: Ids
  clock: Clock
  log: Logger
  /**
   * Looks up the tool behind a clicked block (`ui.action`, phase 2). Without it every click
   * becomes the input "(clicked: <label>)".
   */
  tools?: Pick<CoreToolRegistry, 'get'> | undefined
  /** `t.services` for `onAction` runs. Without it, `get` throws `SERVICE_MISSING`. */
  services?: Pick<CoreServiceRegistry, 'get' | 'find'> | undefined
  /**
   * Phase 3: speaks audio-modality replies on the focus node. Without it every reply is text
   * only, exactly as in phase 2.
   */
  voice?: VoiceOutput | undefined
}

/** The ThreadManager plus lifecycle hooks for bootstrap and tests. */
export interface MindThreadManager extends ThreadManager {
  /** Resolves when no turn runs and no check is pending in any thread. Hold timers are not awaited. */
  idle(): Promise<void>
  /** Clears hold timers and unsubscribes from events (shutdown). */
  stop(): void
}

/** Shown (after any partial text) when a turn fails after retries. */
export const APOLOGY_TEXT = "Sorry, I couldn't finish that reply. Please try again."

const UI_CAPABILITY = 'ui.render@1'
const AUDIO_OUT_CAPABILITY = 'audio.out@1'
const MAIN_SLUG = 'main'

type Hold = { kind: 'greeting' | 'grace'; timer: ReturnType<typeof setTimeout> }

type Running = {
  controller: AbortController
  messageId: MessageId | null
  text: string
  /** The spoken reply of an audio-modality turn (phase 3). */
  speech: SpeechHandle | null
}

/** Speech on the focus node that becomes a barge-in once it lasts `voice.bargeInMinMs`. */
type PendingBargeIn = { nodeId: NodeId; timer: ReturnType<typeof setTimeout> }

type Runtime = {
  threadId: ThreadId
  participants: PersonId[]
  state: TurnState
  /** The node of the latest input (I-7). */
  focus: NodeId | null
  /** Inputs waiting for the next user turn. Persisted when that turn starts. */
  queue: UserMessageRecord[]
  running: Running | null
  pumping: boolean
  /** Set when something changed while the pump was deciding. */
  dirty: boolean
  hold: Hold | null
  /** The next user turn gets the pending deliveries in context (arrival). */
  arrivalDeliveries: boolean
  briefingDue: boolean
  flushRequested: boolean
  /** Work that must not interleave with a turn (appending a `ui.action` result). Runs first. */
  jobs: (() => Promise<void>)[]
  /** Phase 3: the node whose VAD reported speech that no input has followed yet. */
  listening: NodeId | null
  bargeIn: PendingBargeIn | null
}

type Work = { kind: TurnKind; inputs: UserMessageRecord[]; deliveries: Delivery[] }

type Outcome = 'ok' | 'cancelled' | 'failed'

type InputArgs = Parameters<ThreadManager['input']>[0]
type ActionArgs = Parameters<ThreadManager['action']>[0]

/** `t.services` when bootstrap passes no service registry. */
const NO_SERVICES: Pick<CoreServiceRegistry, 'get' | 'find'> = {
  get: (name) => {
    throw new KeithError('SERVICE_MISSING', `service '${name}' is not available`)
  },
  find: () => undefined,
}

export function createThreadManager(deps: ThreadManagerDeps): MindThreadManager {
  const { config, repos, nodes, ids, clock, events, log } = deps
  const runtimes = new Map<ThreadId, Promise<Runtime>>()
  const ready = new Map<ThreadId, Runtime>()
  const mainThreads = new Map<PersonId, Promise<ThreadRecord>>()
  const capabilities = new Map<NodeId, string[]>()
  const inflight = new Set<Promise<void>>()

  const unsubscribe = events.on('delivery.enqueued', (e) => {
    track(
      (async () => {
        const rt = await runtimeFor(e.data.threadId)
        rt.flushRequested = true
        kick(rt)
      })(),
    )
  })

  // Plumbing

  function track(p: Promise<void>): void {
    const guarded = p.catch((error: unknown) => {
      log.error('thread job failed', { error: String(error) })
    })
    inflight.add(guarded)
    void guarded.finally(() => inflight.delete(guarded))
  }

  function frameOpts() {
    const id = ids.next('trn')
    return { id: id.slice(id.indexOf('_') + 1), ts: clock.now() }
  }

  function broadcast(rt: Runtime, frame: CoreFrame, except?: NodeId): void {
    for (const n of nodes.attachedTo(rt.threadId)) if (n !== except) nodes.send(n, frame)
  }

  function setState(rt: Runtime, to: TurnState): void {
    const from = rt.state
    if (from === to) return
    rt.state = to
    broadcast(rt, makeFrame('thread.state', { threadId: rt.threadId, state: to }, frameOpts()))
    events.emit('thread.state_changed', { threadId: rt.threadId, from, to })
  }

  function present(rt: Runtime): boolean {
    return rt.participants.some((p) => deps.presence.isPresent(p))
  }

  async function rememberNode(nodeId: NodeId): Promise<void> {
    const record = await repos.nodes.get(nodeId)
    capabilities.set(nodeId, record?.capabilities ?? [])
  }

  function runtimeFor(threadId: ThreadId): Promise<Runtime> {
    let p = runtimes.get(threadId)
    if (!p) {
      p = (async () => {
        const participants = await repos.threads.participants(threadId)
        if (participants.length === 0) {
          throw new KeithError('NOT_FOUND', 'thread not found', { details: { threadId } })
        }
        const rt: Runtime = {
          threadId,
          participants: participants.map((x) => x.personId),
          state: 'idle',
          focus: null,
          queue: [],
          running: null,
          pumping: false,
          dirty: false,
          hold: null,
          arrivalDeliveries: false,
          briefingDue: false,
          flushRequested: false,
          jobs: [],
          listening: null,
          bargeIn: null,
        }
        ready.set(threadId, rt)
        return rt
      })()
      runtimes.set(threadId, p)
      p.catch(() => runtimes.delete(threadId))
    }
    return p
  }

  function mainThreadOf(personId: PersonId): Promise<ThreadRecord> {
    let p = mainThreads.get(personId)
    if (!p) {
      p = (async () => {
        const existing = await repos.threads.getBySlug(personId, MAIN_SLUG)
        if (existing) return existing
        const now = clock.now()
        const record: ThreadRecord = {
          id: ids.next('thr'),
          kind: 'direct',
          slug: MAIN_SLUG,
          title: 'Main',
          ownerPersonId: personId,
          summary: null,
          createdAt: now,
          updatedAt: now,
        }
        await repos.threads.create(record, [personId])
        return record
      })()
      mainThreads.set(personId, p)
      // Only the creation is shared; later opens re-read the record for a fresh `updatedAt`.
      void p.then(
        () => mainThreads.delete(personId),
        () => mainThreads.delete(personId),
      )
    }
    return p
  }

  async function personDtos(personIds: PersonId[]): Promise<PersonDto[]> {
    const out: PersonDto[] = []
    for (const id of personIds) {
      const p = await repos.persons.get(id)
      if (p) out.push({ id: p.id, name: p.name, tier: p.tier })
    }
    return out
  }

  // Holds and flush triggers

  function clearHold(rt: Runtime): void {
    if (rt.hold) clearTimeout(rt.hold.timer)
    rt.hold = null
  }

  function applyArrival(rt: Runtime, arrival: Arrival | null): void {
    const { briefing, holdMs, graceMs } = config.mind.arrival
    if (arrival === null || briefing === 'off') {
      checkSoon(rt)
      return
    }
    clearHold(rt)
    if (briefing === 'on-greeting') {
      rt.arrivalDeliveries = true
      const hold: Hold = { kind: 'greeting', timer: setTimeout(() => endHold(rt, hold), holdMs) }
      rt.hold = hold
    } else {
      const hold: Hold = { kind: 'grace', timer: setTimeout(() => endHold(rt, hold), graceMs) }
      rt.hold = hold
    }
  }

  function endHold(rt: Runtime, hold: Hold): void {
    if (rt.hold !== hold) return
    rt.hold = null
    if (hold.kind === 'greeting') {
      rt.arrivalDeliveries = false
      rt.flushRequested = true
    } else {
      rt.briefingDue = true
    }
    kick(rt)
  }

  /** Flush trigger (d). Runs on the next macrotask so the server sends `thread.opened` first. */
  function checkSoon(rt: Runtime): void {
    track(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          rt.flushRequested = true
          kick(rt)
          resolve()
        }, 0)
      }),
    )
  }

  // The per-thread pump: one turn at a time (single flight), FIFO input.

  function kick(rt: Runtime): void {
    if (rt.pumping) {
      rt.dirty = true
      return
    }
    track(pump(rt))
  }

  async function pump(rt: Runtime): Promise<void> {
    rt.pumping = true
    try {
      for (;;) {
        rt.dirty = false
        const job = rt.jobs.shift()
        if (job) {
          await job()
          continue
        }
        const work = await nextWork(rt)
        if (!work) {
          if (rt.dirty) continue
          return
        }
        const outcome = await runTurn(rt, work)
        // Flush trigger (b). Not after a failure or a cancel, so a broken delivery turn can't loop.
        if (outcome === 'ok') rt.flushRequested = true
      }
    } finally {
      rt.pumping = false
    }
  }

  async function nextWork(rt: Runtime): Promise<Work | null> {
    const canFlush = rt.hold === null && present(rt)
    if (rt.queue.length > 0) {
      if (canFlush) {
        const pending = await deps.deliveries.pendingFor(rt.threadId)
        if (pending.some((d) => d.urgency === 'critical')) {
          return { kind: 'delivery', inputs: [], deliveries: pending }
        }
      }
      const inputs = rt.queue.splice(0)
      const withDeliveries = rt.arrivalDeliveries
      rt.arrivalDeliveries = false
      const deliveries = withDeliveries ? await deps.deliveries.pendingFor(rt.threadId) : []
      return { kind: 'user', inputs, deliveries }
    }
    if (rt.briefingDue) {
      rt.briefingDue = false
      if (present(rt)) {
        rt.flushRequested = false
        return { kind: 'briefing', inputs: [], deliveries: await deps.deliveries.pendingFor(rt.threadId) }
      }
    }
    if (rt.flushRequested && canFlush) {
      rt.flushRequested = false
      const pending = await deps.deliveries.pendingFor(rt.threadId)
      if (pending.length > 0) return { kind: 'delivery', inputs: [], deliveries: pending }
    }
    return null
  }

  // Turns

  async function runTurn(rt: Runtime, work: Work): Promise<Outcome> {
    const running: Running = {
      controller: new AbortController(),
      messageId: null,
      text: '',
      speech: null,
    }
    rt.running = running
    const turnId = ids.next('trn')
    setState(rt, 'thinking')
    events.emit('turn.started', { threadId: rt.threadId, turnId, kind: work.kind })
    try {
      for (const input of work.inputs) {
        // Persisted now, not on arrival, so a queued input sorts after the reply it waited for.
        await append({ ...input, createdAt: clock.now() })
      }
      const lane = work.kind === 'user' ? 'foreground' : 'delivery'
      const outcome = await deps.scheduler.run(
        lane,
        (signal) => execute(rt, work, running, signal),
        running.controller.signal,
      )
      events.emit('turn.completed', {
        threadId: rt.threadId,
        turnId,
        steps: outcome.steps,
        cancelled: outcome.outcome === 'cancelled',
      })
      if (outcome.outcome === 'failed' && outcome.error !== undefined) {
        events.emit('turn.failed', { threadId: rt.threadId, turnId, code: keithCode(outcome.error) })
      }
      return outcome.outcome
    } catch (error) {
      running.speech?.stop()
      if (running.controller.signal.aborted) {
        events.emit('turn.completed', { threadId: rt.threadId, turnId, steps: 0, cancelled: true })
        return 'cancelled'
      }
      log.error('turn failed', { threadId: rt.threadId, turnId, error: String(error) })
      sendError(rt, error)
      events.emit('turn.failed', { threadId: rt.threadId, turnId, code: keithCode(error) })
      return 'failed'
    } finally {
      rt.running = null
      clearBargeIn(rt)
      // After a barge-in the thread goes on listening to the speaker.
      setState(rt, rt.listening === null ? 'idle' : 'listening')
    }
  }

  async function execute(
    rt: Runtime,
    work: Work,
    running: Running,
    signal: AbortSignal,
  ): Promise<{ outcome: Outcome; steps: number; error?: unknown }> {
    const threadId = rt.threadId
    const focus = rt.focus ?? nodes.attachedTo(threadId)[0]
    const focusCapabilities = focus ? (capabilities.get(focus) ?? []) : []
    const built = await deps.context.build({
      threadId,
      viewer: { participants: rt.participants },
      kind: work.kind,
      focusCapabilities,
      deliveries: work.deliveries,
    })
    if (signal.aborted) return { outcome: 'cancelled', steps: 0 }

    const messageId = ids.next('msg')
    running.messageId = messageId
    const proactive = work.kind !== 'user'
    broadcast(rt, makeFrame('message.started', { threadId, messageId, proactive }, frameOpts()))
    // Phase 3: a spoken input gets a spoken reply on the focus node (voice.md), plus text everywhere.
    const spoken = work.inputs.at(-1)?.modality === 'audio'
    if (spoken && deps.voice && focus && capabilities.get(focus)?.includes(AUDIO_OUT_CAPABILITY)) {
      running.speech = deps.voice.begin({ threadId, nodeId: focus, messageId })
    }

    const ui: MessageUiEntry[] = []
    let result: RunLoopResult | null = null
    let failure: unknown
    const actor = work.inputs.at(-1)?.authorPersonId ?? rt.participants[0]
    try {
      if (!actor) throw new KeithError('INTERNAL', 'thread has no participants', { details: { threadId } })
      result = await deps.runLoop({
        system: built.system,
        messages: built.messages,
        tools: built.tools,
        modelRole: 'foreground',
        maxSteps: config.mind.turn.maxSteps,
        runCtx: { personId: actor, participants: rt.participants, threadId, taskId: null },
        persist: { threadId },
        signal,
        onEvent: (e) => onRunEvent(rt, running, messageId, ui, e),
      })
    } catch (error) {
      failure = error
    }
    let cancelled = result ? result.stoppedBy === 'cancelled' : signal.aborted
    const failed = failure !== undefined && !cancelled
    if (failed) {
      log.error('turn failed', { threadId, error: String(failure) })
      sendError(rt, failure)
    }
    let partial = result?.text ?? running.text
    let spokenChars: number | undefined
    const speech = running.speech
    if (speech) {
      if (!cancelled && !failed) {
        // The turn stays `speaking` until the audio is sent, so a barge-in can still cut it.
        speech.end()
        await untilDoneOrAborted(speech, running.controller.signal)
        if (running.controller.signal.aborted) cancelled = true
      }
      if (cancelled) {
        // Keep only what was actually spoken (meta.spokenChars).
        spokenChars = speech.stop()
        partial = partial.slice(0, spokenChars)
      } else if (failed) {
        speech.stop()
      }
    }
    const content = failed ? (partial === '' ? APOLOGY_TEXT : `${partial}\n\n${APOLOGY_TEXT}`) : partial
    const meta: MessageMeta = {}
    if (proactive) meta.proactive = true
    if (cancelled) meta.cancelled = true
    if (spokenChars !== undefined) meta.spokenChars = spokenChars
    const record: AssistantMessageRecord = {
      id: messageId,
      threadId,
      role: 'assistant',
      authorPersonId: null,
      nodeId: null,
      modality: speech ? 'audio' : 'text',
      content,
      meta: Object.keys(meta).length > 0 ? meta : null,
      createdAt: clock.now(),
      toolCalls: null,
      ui: ui.length > 0 ? ui : null,
    }
    const dto = await append(record)
    if (dto) broadcast(rt, makeFrame('message.completed', { message: dto }, frameOpts()))

    const steps = result?.steps ?? 0
    if (failed) return { outcome: 'failed', steps, error: failure }
    if (cancelled) return { outcome: 'cancelled', steps }
    if (work.deliveries.length > 0) {
      try {
        await deps.deliveries.markDelivered(
          work.deliveries.map((d) => d.id),
          messageId,
        )
      } catch (error) {
        log.error('mark delivered failed', { threadId, messageId, error: String(error) })
        return { outcome: 'failed', steps }
      }
    }
    return { outcome: 'ok', steps }
  }

  function onRunEvent(
    rt: Runtime,
    running: Running,
    messageId: MessageId,
    ui: MessageUiEntry[],
    e: RunLoopEvent,
  ): void {
    const threadId = rt.threadId
    switch (e.type) {
      case 'text.delta':
        if (rt.state === 'thinking') setState(rt, 'speaking')
        running.text += e.text
        running.speech?.push(e.text)
        broadcast(rt, makeFrame('message.delta', { threadId, messageId, text: e.text }, frameOpts()))
        return
      case 'tool.started':
        broadcast(
          rt,
          makeFrame(
            'tool.activity',
            { threadId, messageId, toolCallId: e.toolCallId, name: e.name, status: 'started' },
            frameOpts(),
          ),
        )
        return
      case 'tool.completed': {
        const status = e.ok ? 'completed' : 'failed'
        const data = { threadId, messageId, toolCallId: e.toolCallId, name: e.name, status } as const
        const withSummary = e.summary === undefined ? data : { ...data, summary: e.summary }
        broadcast(rt, makeFrame('tool.activity', withSummary, frameOpts()))
        return
      }
      case 'ui': {
        // Block ids are unique within a message (ui-blocks.md), so `ui.action` finds one block.
        if (!idsFreeIn(e.block, ui)) {
          log.warn('ui block reuses a block id of this message; dropped', {
            threadId,
            messageId,
            tool: e.toolName,
            blockId: e.block.id,
          })
          return
        }
        ui.push({ block: e.block, toolCallId: e.toolCallId, toolName: e.toolName })
        renderUi(rt, messageId, e.block, e.fallbackText)
        return
      }
      case 'step.completed':
        return
    }
  }

  /** Sends `ui.render` to the thread's nodes with `ui.render@1`. */
  function renderUi(rt: Runtime, messageId: MessageId, block: UiBlock, fallbackText: string): void {
    const frame = makeFrame(
      'ui.render',
      { threadId: rt.threadId, messageId, block, fallbackText },
      frameOpts(),
    )
    for (const n of nodes.attachedTo(rt.threadId)) {
      if (capabilities.get(n)?.includes(UI_CAPABILITY)) nodes.send(n, frame)
    }
  }

  /**
   * History is ordered by `(createdAt, id)`. A turn's assistant message gets its id when the turn
   * starts (for `message.started`), before the tool-step rows the run loop stores, and a queued
   * input gets its id when it arrives. Within one millisecond that id order is wrong, so a record
   * that would sort before the thread's latest row is stamped one millisecond after it.
   */
  async function inOrder<R extends MessageRecord>(record: R): Promise<R> {
    const { messages } = await repos.messages.page({ threadId: record.threadId, limit: 1 })
    const last = messages[0]
    if (!last) return record
    const sortsBefore =
      record.createdAt < last.createdAt || (record.createdAt === last.createdAt && record.id < last.id)
    return sortsBefore ? { ...record, createdAt: last.createdAt + 1 } : record
  }

  async function append(input: MessageRecord): Promise<MessageDto | null> {
    const record = await inOrder(input)
    await repos.messages.append(record)
    events.emit('thread.message_added', {
      threadId: record.threadId,
      messageId: record.id,
      role: record.role,
      authorPersonId: record.authorPersonId,
    })
    return toMessageDto(record)
  }

  function sendError(rt: Runtime, error: unknown): void {
    const code: ErrorCode = isKeithError(error, 'PROVIDER_ERROR') ? 'PROVIDER_ERROR' : 'INTERNAL'
    const message = code === 'PROVIDER_ERROR' ? 'the model provider failed' : 'internal error'
    broadcast(rt, makeFrame('error', { code, message }, frameOpts()))
  }

  // Input

  /**
   * Queues a user input for the next turn and echoes it as `message.user` to the thread's other
   * nodes, or to all of them with `echoToSender` (a click, which the sending node didn't type).
   * A spoken input (`modality: 'audio'`) is echoed to the sender too: its transcript comes from the
   * core's STT, so the speaking node has no other way to show it.
   */
  async function input(a: InputArgs, echoToSender = false): Promise<void> {
    const rt = await runtimeFor(a.threadId)
    if (!rt.participants.includes(a.personId)) {
      throw new KeithError('FORBIDDEN', 'not a participant of this thread', {
        details: { threadId: a.threadId, personId: a.personId },
      })
    }
    if (!capabilities.has(a.nodeId)) await rememberNode(a.nodeId)
    const record: UserMessageRecord = {
      id: ids.next('msg'),
      threadId: a.threadId,
      role: 'user',
      authorPersonId: a.personId,
      nodeId: a.nodeId,
      modality: a.modality,
      content: a.text,
      meta: null,
      createdAt: clock.now(),
    }
    const dto = toMessageDto(record)
    if (dto) {
      const frame = makeFrame('message.user', { message: dto }, frameOpts())
      broadcast(rt, frame, echoToSender || a.modality === 'audio' ? undefined : a.nodeId)
    }
    rt.focus = a.nodeId
    if (rt.listening === a.nodeId) rt.listening = null
    if (rt.hold) {
      // The first input after an arrival ends the hold (or the briefing grace) and carries the briefing.
      clearHold(rt)
      rt.arrivalDeliveries = true
    }
    rt.queue.push(record)
    kick(rt)
  }

  // ui.action (docs/architecture/ui.md#interactivity, docs/contracts/plugin-api.md onAction)

  async function action(a: ActionArgs): Promise<void> {
    const rt = await runtimeFor(a.threadId)
    if (!rt.participants.includes(a.personId)) {
      throw new KeithError('FORBIDDEN', 'not a participant of this thread', {
        details: { threadId: a.threadId, personId: a.personId },
      })
    }
    const message = await repos.messages.get(a.messageId)
    if (!message || message.threadId !== a.threadId || message.role !== 'assistant') {
      throw new KeithError('NOT_FOUND', 'message not found', { details: { messageId: a.messageId } })
    }
    const found = findUiAction(message.ui ?? [], a.blockId, a.actionId)
    if (!found) {
      throw new KeithError('NOT_FOUND', 'block or action not found', {
        details: { messageId: a.messageId, blockId: a.blockId, actionId: a.actionId },
      })
    }
    const tool = deps.tools?.get(found.entry.toolName)?.tool
    if (!tool?.onAction) {
      // No handler (or the tool is gone): the click becomes an input the Mind answers.
      await input(
        {
          threadId: a.threadId,
          personId: a.personId,
          nodeId: a.nodeId,
          modality: 'text',
          text: `(clicked: ${found.action.label})`,
        },
        true,
      )
      return
    }
    const [person] = await personDtos([a.personId])
    if (!person) throw new KeithError('NOT_FOUND', 'person not found', { details: { personId: a.personId } })
    const participants = await personDtos(rt.participants)
    // R-14: the clicking person, and everyone who will see the result, must reach the tool's tier.
    const lowest = lowestTier([person, ...participants].map((p) => p.tier))
    if (lowestTier([lowest, tool.minTier]) !== tool.minTier) {
      throw new KeithError('FORBIDDEN', `this action needs tier '${tool.minTier}'`, {
        details: { tool: tool.name, tier: lowest },
      })
    }
    const value = a.value !== undefined ? a.value : found.action.value
    const toolAction: ToolAction = { messageId: a.messageId, blockId: a.blockId, actionId: a.actionId }
    if (value !== undefined) toolAction.value = value
    const result = await runOnAction(tool, toolAction, { person, participants, threadId: a.threadId })
    if (result === undefined) return
    await inPump(rt, () => appendActionResult(rt, tool.name, result))
  }

  async function runOnAction(
    tool: Tool,
    toolAction: ToolAction,
    ctx: { person: PersonDto; participants: PersonDto[]; threadId: ThreadId },
  ): Promise<ToolResult | undefined> {
    const onAction = tool.onAction
    if (!onAction) return undefined
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new KeithError('TOOL_TIMEOUT', `onAction of '${tool.name}' timed out`)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
    })
    try {
      return await Promise.race([
        onAction.call(tool, toolAction, {
          person: ctx.person,
          participants: ctx.participants,
          threadId: ctx.threadId,
          taskId: null,
          signal: controller.signal,
          log: log.child({ tool: tool.name, messageId: toolAction.messageId }),
          services: deps.services ?? NO_SERVICES,
        }),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Runs `job` in the thread's pump, after any running turn, and waits for it. */
  function inPump(rt: Runtime, job: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      rt.jobs.push(() => job().then(resolve, reject))
      kick(rt)
    })
  }

  /** An `onAction` result becomes an assistant message, without a model call. */
  async function appendActionResult(rt: Runtime, toolName: string, result: ToolResult): Promise<void> {
    const threadId = rt.threadId
    const messageId = ids.next('msg')
    broadcast(rt, makeFrame('message.started', { threadId, messageId, proactive: false }, frameOpts()))
    const ui: MessageUiEntry[] = []
    const block = result.ui === undefined ? null : validUiBlock(result.ui, log, { tool: toolName, messageId })
    if (block) {
      ui.push({ block, toolCallId: `action:${messageId}`, toolName })
      renderUi(rt, messageId, block, result.fallbackText ?? uiBlockToText(block))
    }
    const record: AssistantMessageRecord = {
      id: messageId,
      threadId,
      role: 'assistant',
      authorPersonId: null,
      nodeId: null,
      modality: 'text',
      content: result.content,
      meta: null,
      createdAt: clock.now(),
      toolCalls: null,
      ui: ui.length > 0 ? ui : null,
    }
    const dto = await append(record)
    if (dto) broadcast(rt, makeFrame('message.completed', { message: dto }, frameOpts()))
  }

  // Voice activity (phase 3, docs/architecture/voice.md#turn-taking-with-voice)

  function clearBargeIn(rt: Runtime): void {
    if (rt.bargeIn) clearTimeout(rt.bargeIn.timer)
    rt.bargeIn = null
  }

  /** Stops the spoken reply right away and cancels the turn, as `input.cancel` does. */
  function bargeIn(rt: Runtime, nodeId: NodeId): void {
    clearBargeIn(rt)
    const running = rt.running
    if (!running || rt.focus !== nodeId) return
    log.debug('barge-in', { threadId: rt.threadId, nodeId })
    running.speech?.stop()
    running.controller.abort()
  }

  function voiceActivity(a: Parameters<ThreadManager['voiceActivity']>[0]): void {
    const rt = ready.get(a.threadId)
    if (!rt) return
    if (!a.speaking) {
      if (rt.bargeIn?.nodeId === a.nodeId) clearBargeIn(rt)
      if (rt.listening !== a.nodeId) return
      rt.listening = null
      if (rt.state === 'listening') setState(rt, 'idle')
      return
    }
    rt.listening = a.nodeId
    if (rt.state === 'idle') {
      setState(rt, 'listening')
      return
    }
    const turnActive = rt.state === 'thinking' || rt.state === 'speaking'
    const voice = config.voice
    if (!turnActive || rt.focus !== a.nodeId || voice?.bargeIn === false || rt.bargeIn) return
    const minMs = voice?.bargeInMinMs ?? 0
    if (minMs <= 0) {
      bargeIn(rt, a.nodeId)
      return
    }
    // Short noise must not cut the reply: speech has to last `bargeInMinMs`.
    rt.bargeIn = { nodeId: a.nodeId, timer: setTimeout(() => bargeIn(rt, a.nodeId), minMs) }
  }

  // The interface

  return {
    async open(a) {
      const person = await repos.persons.get(a.personId)
      if (!person)
        throw new KeithError('NOT_FOUND', 'person not found', { details: { personId: a.personId } })
      const record = a.threadId ? await repos.threads.get(a.threadId) : await mainThreadOf(a.personId)
      if (!record)
        throw new KeithError('NOT_FOUND', 'thread not found', { details: { threadId: a.threadId } })
      const rt = await runtimeFor(record.id)
      if (!rt.participants.includes(a.personId)) {
        throw new KeithError('FORBIDDEN', 'not a participant of this thread', {
          details: { threadId: record.id, personId: a.personId },
        })
      }
      await rememberNode(a.nodeId)
      if (rt.focus === null) rt.focus = a.nodeId
      const [participants, page] = await Promise.all([
        personDtos(rt.participants),
        // Placeholder (P3-K2): `a.historyLimit` is not honored yet; P3-H1 implements it (B5).
        repos.messages.page({ threadId: record.id, limit: MESSAGES_PAGE.defaultLimit }),
      ])
      const thread: ThreadDto = {
        id: record.id,
        kind: record.kind,
        title: record.title,
        participants,
        state: rt.state,
        updatedAt: record.updatedAt,
      }
      const messages = page.messages.map(toMessageDto).filter((m): m is MessageDto => m !== null)
      events.emit('thread.opened', { threadId: record.id, personId: a.personId, nodeId: a.nodeId })
      applyArrival(rt, a.arrival)
      return { thread, messages }
    },

    detach(a) {
      for (const rt of ready.values()) {
        if (a.threadId !== undefined && rt.threadId !== a.threadId) continue
        if (rt.focus === a.nodeId) rt.focus = null
        if (rt.bargeIn?.nodeId === a.nodeId) clearBargeIn(rt)
        if (rt.listening === a.nodeId) {
          rt.listening = null
          if (rt.state === 'listening') setState(rt, 'idle')
        }
      }
    },

    input: (a) => input(a),

    cancel(a) {
      ready.get(a.threadId)?.running?.controller.abort()
    },

    action,

    voiceActivity,

    state(threadId) {
      return ready.get(threadId)?.state ?? 'idle'
    },

    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight])
    },

    stop() {
      unsubscribe()
      for (const rt of ready.values()) {
        clearHold(rt)
        clearBargeIn(rt)
      }
    },
  }
}

/** Settles when the speech is done or the signal aborts, whichever comes first. */
function untilDoneOrAborted(speech: SpeechHandle, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    void speech.done.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

function keithCode(error: unknown): KeithErrorCode {
  return isKeithError(error) ? error.code : 'INTERNAL'
}
