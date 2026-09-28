// Fakes for the addressing tests, built from the interfaces the detector consumes (RunLoop,
// Scheduler). Test-only.

import { isProviderError, KeithError, type LlmEvent, type LlmProvider, type LlmRequest } from '@keith/sdk'
import {
  createFakeLlm,
  createMemoryLogger,
  type FakeLlm,
  type FakeLlmTurn,
  type MemoryLogger,
} from '@keith/sdk/testing'
import type { KeithConfig } from '../../config/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Lane, MessageId, PersonId, ThreadId } from '../../shared/types.ts'
import type { MessageRecord } from '../../storage/types.ts'
import type { RunLoop, RunLoopArgs } from '../types.ts'
import { type AddressingDeps, createAddressing } from './index.ts'

const fixedId = <P extends string>(prefix: P, tail: string) => `${prefix}_${tail.padStart(26, '0')}` as const

export const TONY: PersonId = fixedId('per', 'T0NY')
export const PEPPER: PersonId = fixedId('per', 'PEPPER')
export const RHODEY: PersonId = fixedId('per', 'RH0DEY')
export const MISSION: ThreadId = fixedId('thr', 'M1SS10N')
export const CAST = ['Tony', 'Pepper', 'Rhodey']

export type Speaker = 'tony' | 'pepper' | 'rhodey' | 'keith'
export const SPEAKERS: Record<Speaker, PersonId | null> = {
  tony: TONY,
  pepper: PEPPER,
  rhodey: RHODEY,
  keith: null,
}

/** Visible messages from `[speaker, text]` pairs, oldest first, in the mission thread. */
export function transcript(lines: [Speaker, string][]): MessageRecord[] {
  return lines.map(([who, content], i) => message(i + 1, SPEAKERS[who], content))
}

export function message(
  n: number,
  author: PersonId | null,
  content: string,
  role?: MessageRecord['role'],
): MessageRecord {
  const base = {
    id: fixedId('msg', String(n)) as MessageId,
    threadId: MISSION,
    authorPersonId: author,
    nodeId: null,
    modality: 'text' as const,
    content,
    meta: null,
    createdAt: 1_790_000_000_000 + n * 1_000,
    seq: n,
  }
  const r = role ?? (author === null ? 'assistant' : 'user')
  if (r === 'assistant') return { ...base, role: 'assistant', toolCalls: null, ui: null }
  if (r === 'tool')
    return { ...base, role: 'tool', toolCallId: `call_${n}`, toolName: 'memory.search', isError: false }
  return { ...base, role: 'user' }
}

export type FakeUtilityRunLoop = RunLoop & { calls: RunLoopArgs[] }

/** A one-step `utility` RunLoop over the scripted fake LLM (R-13). */
export function createUtilityRunLoop(llm: LlmProvider): FakeUtilityRunLoop {
  const calls: RunLoopArgs[] = []
  const run = async (a: RunLoopArgs) => {
    calls.push(a)
    let text = ''
    const req: LlmRequest = { model: 'fake-utility', system: a.system, messages: a.messages }
    try {
      for await (const ev of llm.stream(req, a.signal)) {
        if (ev.type === 'text.delta') text += ev.text
      }
    } catch (error) {
      if (a.signal.aborted) return { text, steps: 1, stoppedBy: 'cancelled' as const }
      if (isProviderError(error)) throw new KeithError('PROVIDER_ERROR', error.message, { cause: error })
      throw error
    }
    return { text, steps: 1, stoppedBy: 'stop' as const }
  }
  return Object.assign(run, { calls })
}

export type FakeLaneScheduler = Pick<Scheduler, 'run'> & { lanes: Lane[] }

export function createLaneScheduler(): FakeLaneScheduler {
  const lanes: Lane[] = []
  return {
    lanes,
    async run(lane, job, signal) {
      lanes.push(lane)
      if (signal?.aborted) throw new KeithError('INTERNAL', 'job aborted before start')
      return job(signal ?? new AbortController().signal)
    },
  }
}

/** A classifier reply as the utility model would send it. */
export function replyTurn(value: unknown): LlmEvent[] {
  return [{ type: 'text.delta', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

export function mindConfig(
  addressing: KeithConfig['mind']['group']['addressing'] = 'rules+utility',
): Pick<KeithConfig, 'mind'> {
  return {
    mind: {
      name: 'Keith',
      timezone: 'UTC',
      turn: { maxSteps: 8, stallMs: 120_000 },
      task: { maxSteps: 20, maxPerPerson: 3, timeoutMs: 1_800_000 },
      commitment: { ttlMs: 604_800_000 },
      arrival: { awayAfterMinutes: 30, briefing: 'on-greeting', holdMs: 120_000, graceMs: 1_500 },
      context: { recentMessages: 40 },
      reminder: { maxPerPerson: 50 },
      group: { maxParticipants: 8, autoJoin: false, addressing },
    },
  }
}

export type AddressingHarness = {
  llm: FakeLlm
  runLoop: FakeUtilityRunLoop
  scheduler: FakeLaneScheduler
  log: MemoryLogger
  deps: AddressingDeps
  detector: ReturnType<typeof createAddressing>
}

export function createAddressingHarness(
  opts: { script?: FakeLlmTurn[]; addressing?: KeithConfig['mind']['group']['addressing'] } = {},
): AddressingHarness {
  const llm = createFakeLlm(opts.script ?? [])
  const runLoop = createUtilityRunLoop(llm)
  const scheduler = createLaneScheduler()
  const log = createMemoryLogger()
  const deps: AddressingDeps = { config: mindConfig(opts.addressing), runLoop, scheduler, log }
  return { llm, runLoop, scheduler, log, deps, detector: createAddressing(deps) }
}
