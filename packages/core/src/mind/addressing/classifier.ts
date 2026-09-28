// The addressing classifier (phase 5): one `utility` step for inputs the rule pass is unsure
// about. See docs/architecture/core.md#group-threads (Addressing).

import { z } from 'zod'
import type { KeithConfig } from '../../config/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Logger, PersonId, ThreadId } from '../../shared/types.ts'
import type { MessageRecord } from '../../storage/types.ts'
import type { AddressingVerdict, RunLoop } from '../types.ts'
import { addressingSystemPrompt } from './prompts.ts'
import { visibleMessages } from './rules.ts'

/** The classifier gives up (unsure) after this long. */
export const CLASSIFIER_TIMEOUT_MS = 5_000
/** Addressed only when the model says so with at least this confidence. */
export const CLASSIFIER_MIN_CONFIDENCE = 0.7
/** At most this many recent messages go into the call. */
export const CLASSIFIER_RECENT_MESSAGES = 10
/** Each message is cut to this many characters, so the call stays short. */
export const CLASSIFIER_MESSAGE_MAX_CHARS = 500

export const ClassifierReplySchema = z.object({
  addressed: z.boolean(),
  confidence: z.number().min(0).max(1),
})

export type ClassifierDeps = {
  config: Pick<KeithConfig, 'mind'>
  runLoop: RunLoop
  scheduler: Pick<Scheduler, 'run'>
  log: Logger
}

export type ClassifierInput = {
  threadId: ThreadId
  input: { authorPersonId: PersonId; text: string }
  recent: MessageRecord[]
  participantNames: string[]
  signal: AbortSignal
}

type Failure = 'timeout' | 'aborted' | 'invalid_reply' | 'error'

class ClassifierFailure extends Error {
  constructor(readonly reason: Failure) {
    super(reason)
  }
}

const UNSURE: AddressingVerdict = { addressed: false, by: 'unsure' }

/**
 * One classifier call in the `foreground` lane. A confident answer is `by: 'classifier'`; a
 * confidence below 0.7, a timeout, an invalid reply, a provider error or an abort is `unsure`
 * (not addressed), logged at warn without any message text. Never throws.
 */
export async function classify(
  deps: ClassifierDeps,
  a: ClassifierInput,
  opts: { timeoutMs?: number | undefined } = {},
): Promise<AddressingVerdict> {
  const timeoutMs = opts.timeoutMs ?? CLASSIFIER_TIMEOUT_MS
  const timeout = new AbortController()
  const signal = AbortSignal.any([a.signal, timeout.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeout.abort()
      reject(new ClassifierFailure('timeout'))
    }, timeoutMs)
  })
  try {
    const reply = await Promise.race([
      deps.scheduler.run('foreground', (s) => ask(deps, a, s), signal),
      expired,
    ])
    if (reply.addressed && reply.confidence >= CLASSIFIER_MIN_CONFIDENCE)
      return { addressed: true, by: 'classifier' }
    if (!reply.addressed && reply.confidence >= CLASSIFIER_MIN_CONFIDENCE)
      return { addressed: false, by: 'classifier' }
    return UNSURE
  } catch (error) {
    const reason: Failure =
      error instanceof ClassifierFailure
        ? error.reason
        : timeout.signal.aborted
          ? 'timeout'
          : a.signal.aborted
            ? 'aborted'
            : 'error'
    deps.log.warn('addressing classifier gave no answer', {
      threadId: a.threadId,
      reason,
      ...(reason === 'error' ? { error: errorName(error) } : {}),
    })
    return UNSURE
  } finally {
    clearTimeout(timer)
  }
}

async function ask(deps: ClassifierDeps, a: ClassifierInput, signal: AbortSignal) {
  const result = await deps.runLoop({
    system: addressingSystemPrompt(deps.config.mind.name),
    messages: [{ role: 'user', content: classifierInput(deps.config.mind.name, a) }],
    tools: [],
    modelRole: 'utility',
    maxSteps: 1,
    runCtx: {
      personId: a.input.authorPersonId,
      participants: participantsOf(a),
      threadId: a.threadId,
      taskId: null,
    },
    persist: null,
    signal,
  })
  if (result.stoppedBy === 'cancelled' || signal.aborted) throw new ClassifierFailure('aborted')
  const parsed = ClassifierReplySchema.safeParse(parseJsonObject(result.text))
  if (!parsed.success) throw new ClassifierFailure('invalid_reply')
  return parsed.data
}

/**
 * The call's only input: the Mind's name, the participants' names, the last ten visible messages
 * and the input. Human authors are labelled "Person A", "Person B", … in order of appearance (the
 * detector knows ids, not which name belongs to which id). No memories, no cards.
 */
export function classifierInput(
  mindName: string,
  a: Pick<ClassifierInput, 'input' | 'recent' | 'participantNames'>,
): string {
  const labels = new Map<PersonId, string>()
  const label = (id: PersonId | null): string => {
    if (id === null) return mindName
    let l = labels.get(id)
    if (l === undefined) {
      l = `Person ${String.fromCharCode(65 + (labels.size % 26))}${labels.size >= 26 ? labels.size : ''}`
      labels.set(id, l)
    }
    return l
  }
  const recent = visibleMessages(a.recent).slice(-CLASSIFIER_RECENT_MESSAGES)
  const lines = recent.map((m) => `${label(m.authorPersonId)}: ${cut(m.content)}`)
  return [
    `Assistant: ${mindName}`,
    `Participants: ${a.participantNames.join(', ')}`,
    '',
    'Recent messages:',
    ...(lines.length > 0 ? lines : ['(none)']),
    '',
    `Latest message, from ${label(a.input.authorPersonId)}:`,
    cut(a.input.text),
  ].join('\n')
}

/** The input's author first, then the other humans who wrote the recent messages (I-3). */
function participantsOf(a: ClassifierInput): PersonId[] {
  const ids = new Set<PersonId>([a.input.authorPersonId])
  for (const m of a.recent) if (m.role === 'user' && m.authorPersonId !== null) ids.add(m.authorPersonId)
  return [...ids]
}

function cut(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length <= CLASSIFIER_MESSAGE_MAX_CHARS ? t : `${t.slice(0, CLASSIFIER_MESSAGE_MAX_CHARS)}…`
}

/** Pulls one JSON object out of a reply (tolerates a code fence or text around it). */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error) return (error as Error & { code?: string }).code ?? error.name
  return typeof error
}
