// Threads: turn state, queued input, cancellation, focus, streaming to attached nodes, delivery
// flushes and arrival holds. See docs/architecture/core.md#threads-and-turn-state.

import {
  type CoreFrame,
  type ErrorCode,
  MESSAGES_PAGE,
  type MessageDto,
  makeFrame,
  type ThreadDto,
} from '@keith/protocol'
import { type EventBus, isKeithError, KeithError, type KeithErrorCode } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
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
import { toMessageDto } from './messages.ts'
import type { Arrival, ContextBuilder, RunLoop, RunLoopEvent, RunLoopResult, ThreadManager } from './types.ts'

export type ThreadManagerDeps = {
  config: Pick<KeithConfig, 'mind'>
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
const MAIN_SLUG = 'main'

type Hold = { kind: 'greeting' | 'grace'; timer: ReturnType<typeof setTimeout> }

type Running = { controller: AbortController; messageId: MessageId | null; text: string }

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
}

type Work = { kind: TurnKind; inputs: UserMessageRecord[]; deliveries: Delivery[] }

type Outcome = 'ok' | 'cancelled' | 'failed'

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
    const running: Running = { controller: new AbortController(), messageId: null, text: '' }
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
      setState(rt, 'idle')
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
    const cancelled = result ? result.stoppedBy === 'cancelled' : signal.aborted
    const failed = failure !== undefined && !cancelled
    if (failed) {
      log.error('turn failed', { threadId, error: String(failure) })
      sendError(rt, failure)
    }
    const partial = result?.text ?? running.text
    const content = failed ? (partial === '' ? APOLOGY_TEXT : `${partial}\n\n${APOLOGY_TEXT}`) : partial
    const meta: MessageMeta = {}
    if (proactive) meta.proactive = true
    if (cancelled) meta.cancelled = true
    const record: AssistantMessageRecord = {
      id: messageId,
      threadId,
      role: 'assistant',
      authorPersonId: null,
      nodeId: null,
      modality: 'text',
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
        ui.push({ block: e.block, toolCallId: e.toolCallId, toolName: e.toolName })
        const frame = makeFrame(
          'ui.render',
          { threadId, messageId, block: e.block, fallbackText: e.fallbackText },
          frameOpts(),
        )
        for (const n of nodes.attachedTo(threadId)) {
          if (capabilities.get(n)?.includes(UI_CAPABILITY)) nodes.send(n, frame)
        }
        return
      }
      case 'step.completed':
        return
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
      }
    },

    async input(a) {
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
      if (dto) broadcast(rt, makeFrame('message.user', { message: dto }, frameOpts()), a.nodeId)
      rt.focus = a.nodeId
      if (rt.hold) {
        // The first input after an arrival ends the hold (or the briefing grace) and carries the briefing.
        clearHold(rt)
        rt.arrivalDeliveries = true
      }
      rt.queue.push(record)
      kick(rt)
    },

    cancel(a) {
      ready.get(a.threadId)?.running?.controller.abort()
    },

    async action() {
      // Placeholder until task P2-D1 implements ui.action routing (interface added by P2-K1).
      throw new KeithError('NOT_FOUND', 'ui actions are not supported yet')
    },

    state(threadId) {
      return ready.get(threadId)?.state ?? 'idle'
    },

    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight])
    },

    stop() {
      unsubscribe()
      for (const rt of ready.values()) clearHold(rt)
    },
  }
}

function keithCode(error: unknown): KeithErrorCode {
  return isKeithError(error) ? error.code : 'INTERNAL'
}
