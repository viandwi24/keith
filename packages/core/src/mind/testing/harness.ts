// Wires the real mind (run loop, context builder, thread manager) to the in-memory fakes.

import { jest } from 'bun:test'
import { ProviderError, type Skill, type Tool } from '@keith/sdk'
import {
  createFakeClock,
  createFakeLlm,
  createMemoryLogger,
  type FakeClock,
  type FakeLlm,
  type FakeLlmTurn,
} from '@keith/sdk/testing'
import type { KeithConfig } from '../../config/types.ts'
import type { NodeId, PersonId, ThreadId, Tier } from '../../shared/types.ts'
import type { VoiceOutput } from '../../voice/types.ts'
import { createContextBuilder } from '../context-builder.ts'
import { createRunLoop } from '../run-loop.ts'
import { createThreadManager, type MindThreadManager } from '../thread-manager.ts'
import type { AddressingDetector, RunLoopArgs } from '../types.ts'
import {
  createFakeBus,
  createFakeCommitments,
  createFakeDeliveryQueue,
  createFakeIds,
  createFakeMemory,
  createFakePresence,
  createFakeProviders,
  createFakeRepos,
  createFakeScheduler,
  createFakeSkills,
  createFakeToolRegistry,
  createRecordingSink,
  testConfig,
} from './fakes.ts'

const fixedId = <P extends string>(prefix: P, tail: string) => `${prefix}_${tail.padStart(26, '0')}` as const

export const TONY: PersonId = fixedId('per', 'T0NY')
export const PEPPER: PersonId = fixedId('per', 'PEPPER')
export const LAPTOP: NodeId = fixedId('nod', 'A1')
export const PHONE: NodeId = fixedId('nod', 'B2')
export const PEPPER_PHONE: NodeId = fixedId('nod', 'C3')
/** Phase 5: not created by default (`addPerson` in group tests). */
export const RHODEY: PersonId = fixedId('per', 'RHODEY')
export const RHODEY_PHONE: NodeId = fixedId('nod', 'D4')

export type HarnessOptions = {
  script?: FakeLlmTurn[]
  fallback?: FakeLlmTurn
  mind?: Partial<KeithConfig['mind']>
  tools?: Tool[]
  skills?: Skill[]
  llmSleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Phase 3: the Mind's VoiceOutput. */
  voice?: VoiceOutput
  /** Phase 3: the `[voice]` config section (barge-in knobs). */
  voiceConfig?: KeithConfig['voice']
  /** Overrides the capabilities of the test nodes. */
  capabilities?: Partial<Record<NodeId, string[]>>
  /** Phase 5: the Mind's AddressingDetector for group inputs. */
  addressing?: AddressingDetector
}

export async function createHarness(opts: HarnessOptions = {}) {
  const clock: FakeClock = createFakeClock(1_790_000_000_000)
  const ids = createFakeIds()
  const log = createMemoryLogger()
  const config = { ...testConfig(opts.mind), voice: opts.voiceConfig }
  const repos = createFakeRepos()
  const bus = createFakeBus(clock)
  const sink = createRecordingSink()
  const presence = createFakePresence()
  const scheduler = createFakeScheduler()
  const memory = createFakeMemory()
  const tools = createFakeToolRegistry(opts.tools, bus)
  const llmOptions = {
    ...(opts.fallback ? { fallback: opts.fallback } : {}),
    ...(opts.llmSleep ? { sleep: opts.llmSleep } : {}),
  }
  const llm: FakeLlm = createFakeLlm(opts.script ?? [], llmOptions)
  const mainThreads = new Map<PersonId, ThreadId>()
  const deliveries = createFakeDeliveryQueue({
    ids,
    clock,
    bus,
    mainThreadOf: (personId) => {
      const t = mainThreads.get(personId)
      if (!t) throw new Error('open the thread before enqueueing')
      return t
    },
  })

  const addPerson = async (id: PersonId, name: string, tier: Tier, tone = '') => {
    await repos.persons.create({
      id,
      name,
      username: name.toLowerCase(),
      passwordHash: null,
      tier,
      lastSeenAt: null,
      createdAt: clock.now(),
    })
    await repos.relationships.upsert({ personId: id, tone, notes: '', blockedRelayFrom: [] })
  }
  await addPerson(TONY, 'Tony', 'owner', 'dry wit, calls him sir')
  await addPerson(PEPPER, 'Pepper', 'member', 'warm and brief')
  const caps: [NodeId, string[]][] = [
    [LAPTOP, ['chat.text@1']],
    [PHONE, ['chat.text@1', 'ui.render@1']],
    [PEPPER_PHONE, ['chat.text@1']],
  ]
  for (const [id, capabilities] of caps) {
    await repos.nodes.upsert({
      id,
      name: 'test',
      kind: 'attended',
      capabilities: opts.capabilities?.[id] ?? capabilities,
      lastSeenAt: null,
    })
  }

  const runLoop = createRunLoop({
    providers: createFakeProviders(llm),
    tools,
    repos,
    events: bus,
    ids,
    clock,
    log,
    stallMs: config.mind.turn.stallMs,
  })
  const context = createContextBuilder({
    config,
    persona: async () => 'You are Keith.',
    clock,
    repos,
    memory,
    commitments: createFakeCommitments(),
    skills: createFakeSkills(opts.skills),
    tools,
  })
  /** The `runCtx` of every turn the thread manager ran, in order. */
  const runCtxs: RunLoopArgs['runCtx'][] = []
  const tm: MindThreadManager = createThreadManager({
    config,
    repos,
    nodes: sink,
    presence,
    scheduler,
    deliveries,
    context,
    runLoop: (a) => {
      runCtxs.push({ ...a.runCtx, participants: [...a.runCtx.participants] })
      return runLoop(a)
    },
    events: bus,
    ids,
    clock,
    log,
    tools,
    voice: opts.voice,
    addressing: opts.addressing,
  })

  /** Attaches the node, marks the person present, and opens their main thread (like the server). */
  const open = async (
    personId: PersonId,
    nodeId: NodeId,
    arrival: { awayMs: number | null } | null = null,
  ) => {
    presence.set(personId, true)
    const personMain = await repos.threads.getBySlug(personId, 'main')
    if (personMain) sink.attach(nodeId, personMain.id)
    const opened = await tm.open({ personId, nodeId, arrival })
    sink.attach(nodeId, opened.thread.id)
    mainThreads.set(personId, opened.thread.id)
    return opened
  }

  /** Waits until the bus and every thread are quiet (real timers). */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await bus.idle()
      await tm.idle()
    }
  }

  /**
   * Phase 5: creates a group thread (stored, like `GroupThreads.start` would) with these current
   * participants and attaches each `[person, node]` pair (marking the person present).
   */
  const openGroup = async (
    members: [PersonId, NodeId][],
    opts: { title?: string; purpose?: string | null; owner?: PersonId } = {},
  ) => {
    const now = clock.now()
    const first = members[0]
    if (!first) throw new Error('a group needs a member')
    const threadId = ids.next('thr')
    await repos.threads.create(
      {
        id: threadId,
        kind: 'group',
        slug: null,
        title: opts.title ?? 'Mission',
        ownerPersonId: opts.owner ?? first[0],
        summary: null,
        purpose: opts.purpose ?? null,
        createdAt: now,
        updatedAt: now,
      },
      [...new Set(members.map(([p]) => p))],
    )
    let opened: Awaited<ReturnType<MindThreadManager['open']>> | null = null
    for (const [personId, nodeId] of members) {
      presence.set(personId, true)
      opened = await tm.open({ personId, nodeId, threadId, arrival: null })
      sink.attach(nodeId, threadId)
    }
    return { threadId, opened: opened as Awaited<ReturnType<MindThreadManager['open']>> }
  }

  return {
    addPerson,
    openGroup,
    runCtxs,
    clock,
    ids,
    log,
    config,
    repos,
    bus,
    sink,
    presence,
    scheduler,
    memory,
    tools,
    llm,
    deliveries,
    tm,
    open,
    settle,
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>

/** Flushes pending microtasks (for fake-timer tests). */
export async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** Advances fake timers and the fake clock together, in steps, flushing microtasks between them. */
export async function advance(
  clock: FakeClock,
  ms: number,
  step = Math.max(1, Math.ceil(ms / 20)),
): Promise<void> {
  let left = ms
  await flushMicrotasks()
  while (left > 0) {
    const d = Math.min(step, left)
    clock.advance(d)
    jest.advanceTimersByTime(d)
    left -= d
    await flushMicrotasks()
  }
}

/** An LLM `sleep` that waits until `release()` (or rejects on abort), for holding a turn mid-stream. */
export function createGate() {
  let waiting: (() => void)[] = []
  return {
    sleep(_ms: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new ProviderError('aborted', 'request aborted'))
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        waiting.push(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    },
    get waiting() {
      return waiting.length
    },
    release() {
      const w = waiting
      waiting = []
      for (const r of w) r()
    },
  }
}
