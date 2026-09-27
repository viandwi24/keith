// One reflection pass over a thread (ADR-0014): new messages → inferred memories and card notes.
// See docs/architecture/memory.md#reflection.

import type { LlmMessage } from '@keith/sdk'
import { z } from 'zod'
import type { Memory, MemoryId, PersonId, ThreadId, Viewer } from '../../shared/types.ts'
import type { MemoryFilter, MessageRecord, ThreadRecord } from '../../storage/types.ts'
import type { ReflectionResult, Reflector } from '../types.ts'
import { isVisible, loadVisibilityFacts, type VisibilityFacts } from '../visibility.ts'
import type { ReflectionDeps } from './index.ts'
import { EXTRACT_SYSTEM, MERGE_SYSTEM, RETRY_NOTE } from './prompts.ts'

/** Existing memories looked at per candidate fact. */
const MATCH_LIMIT = 5
/** Failed passes over the same range before the cursor moves past it anyway. */
export const MAX_FAILED_PASSES = 3
const FACT_MAX_CHARS = 500

const ExtractSchema = z.object({
  facts: z
    .array(
      z.object({
        content: z.string(),
        about: z.string().nullable().optional(),
      }),
    )
    .default([]),
  notes: z.array(z.object({ personId: z.string(), notes: z.string() })).default([]),
})
type Extracted = z.infer<typeof ExtractSchema>

const MergeSchema = z.object({
  decisions: z
    .array(
      z.object({
        candidate: z.number().int(),
        action: z.enum(['duplicate', 'update', 'new']),
        id: z.string().optional(),
        content: z.string().optional(),
      }),
    )
    .default([]),
})
type MergeDecisions = z.infer<typeof MergeSchema>

/** The scope a reflected fact is written in. Never wider than the conversation (ADR-0014). */
type Scope = { visibility: 'subject' | 'thread'; subjectPersonId: PersonId | null; threadId: ThreadId }

type Candidate = { content: string; scope: Scope; matches: Memory[] }

type Plan = {
  creates: Candidate[]
  updates: Map<MemoryId, string>
}

/** Thrown inside a pass when its signal fires: nothing is written. */
class Aborted extends Error {}

/** Thrown inside a pass when a reply stays invalid after its retry. */
class InvalidOutput extends Error {}

type RunCtx = { personId: PersonId; participants: PersonId[]; threadId: ThreadId; taskId: null }

type Participant = { id: PersonId; name: string }

export function createReflector(deps: ReflectionDeps): Reflector {
  /** Failed passes per thread, keyed by the range they tried (kept in memory only). */
  const failures = new Map<ThreadId, { range: string; count: number }>()

  return {
    async reflect({ threadId, signal }) {
      if (signal.aborted) return null
      const thread = await deps.repos.threads.get(threadId)
      if (!thread) return null
      const afterSeq = thread.reflectedThroughSeq ?? 0
      const rows = await deps.repos.messages.range({
        threadId,
        afterSeq,
        limit: deps.config.memory.reflect.maxMessages,
        roles: ['user', 'assistant'],
      })
      const throughSeq = rows.reduce((max, r) => Math.max(max, r.seq ?? 0), afterSeq)
      if (rows.length === 0 || throughSeq <= afterSeq) return null
      const range = `${afterSeq}-${throughSeq}`

      try {
        const result = await pass(deps, thread, rows, throughSeq, signal)
        failures.delete(threadId)
        return await finish(deps, result)
      } catch (error) {
        if (error instanceof Aborted || signal.aborted) {
          deps.log.info('reflection aborted', { threadId })
          return null
        }
        if (error instanceof InvalidOutput) {
          const prev = failures.get(threadId)
          const count = prev?.range === range ? prev.count + 1 : 1
          if (count < MAX_FAILED_PASSES) {
            failures.set(threadId, { range, count })
            deps.log.warn('reflection output invalid, will retry on a later tick', { threadId, range, count })
            return null
          }
          failures.delete(threadId)
          deps.log.error('reflection failed repeatedly, skipping these messages', { threadId, range, count })
          return finish(deps, { threadId, throughSeq, written: [], merged: [], cardsUpdated: [] })
        }
        deps.log.warn('reflection failed, cursor kept', { threadId, error: String(error) })
        return null
      }
    },
  }
}

async function finish(deps: ReflectionDeps, result: ReflectionResult): Promise<ReflectionResult> {
  await deps.repos.threads.setReflectedThrough(result.threadId, result.throughSeq)
  deps.events.emit('memory.reflected', {
    threadId: result.threadId,
    throughSeq: result.throughSeq,
    written: result.written.length,
    merged: result.merged.length,
    cardsUpdated: result.cardsUpdated.length,
  })
  deps.log.info('thread reflected', {
    threadId: result.threadId,
    throughSeq: result.throughSeq,
    written: result.written.length,
    merged: result.merged.length,
    cardsUpdated: result.cardsUpdated.length,
  })
  return result
}

async function pass(
  deps: ReflectionDeps,
  thread: ThreadRecord,
  rows: MessageRecord[],
  throughSeq: number,
  signal: AbortSignal,
): Promise<ReflectionResult> {
  const threadId = thread.id
  const empty: ReflectionResult = { threadId, throughSeq, written: [], merged: [], cardsUpdated: [] }
  // Tool steps are not conversation; a cancelled reply counts up to its stored content.
  const said = rows.filter(
    (r) => (r.role === 'user' || (r.role === 'assistant' && r.toolCalls === null)) && r.content.trim() !== '',
  )
  const participantIds = [
    ...new Set((await deps.repos.threads.participants(threadId)).map((p) => p.personId)),
  ]
  const first = participantIds[0]
  if (said.length === 0 || first === undefined) return empty

  const participants = await loadParticipants(deps, participantIds)
  const viewer: Viewer = { participants: participantIds }
  const facts = await loadVisibilityFacts(viewer, deps.repos)
  const direct = thread.kind === 'direct' && participantIds.length === 1
  const cardPerson = direct ? participants[0] : undefined
  const card = cardPerson ? await deps.repos.relationships.get(cardPerson.id) : null
  const runCtx: RunCtx = {
    personId: thread.ownerPersonId ?? first,
    participants: participantIds,
    threadId,
    taskId: null,
  }

  // Call 1: extract.
  const extractInput = await describeMessages(deps, said, participants, cardPerson, card?.notes ?? '')
  const extracted: Extracted = await askJson(
    deps,
    EXTRACT_SYSTEM,
    extractInput,
    ExtractSchema,
    runCtx,
    signal,
  )

  const candidates: Candidate[] = []
  const seen = new Set<string>()
  for (const f of extracted.facts) {
    const content = f.content.trim().slice(0, FACT_MAX_CHARS)
    const key = content.toLowerCase()
    if (content === '' || seen.has(key)) continue
    seen.add(key)
    const about = resolvePerson(f.about ?? null, participants)
    const scope: Scope =
      direct && about !== null && about === cardPerson?.id
        ? { visibility: 'subject', subjectPersonId: about, threadId }
        : { visibility: 'thread', subjectPersonId: direct ? null : about, threadId }
    const matches = await sameScopeMatches(deps, content, scope, viewer, facts)
    candidates.push({ content, scope, matches })
  }

  // Call 2 (only with matches): merge.
  const plan: Plan = { creates: [], updates: new Map() }
  const matched = candidates.filter((c) => c.matches.length > 0)
  let decisions: MergeDecisions = { decisions: [] }
  if (matched.length > 0) {
    decisions = await askJson(deps, MERGE_SYSTEM, describeMatches(matched), MergeSchema, runCtx, signal)
  }
  const authors = new Set(said.map((r) => r.authorPersonId).filter((a): a is PersonId => a !== null))
  for (const c of candidates) {
    const index = matched.indexOf(c)
    const d = index < 0 ? undefined : decisions.decisions.find((x) => x.candidate === index + 1)
    if (d?.action === 'duplicate') continue
    if (d?.action === 'update') {
      const target = c.matches.find((m) => m.id === d.id)
      if (target && mayRewrite(target, authors)) {
        const content = (d.content ?? c.content).trim().slice(0, FACT_MAX_CHARS)
        if (content !== '') plan.updates.set(target.id, content)
        continue
      }
      if (target) deps.log.debug('reflection update not allowed, writing new', { memoryId: target.id })
    }
    plan.creates.push(c)
  }

  // Card notes: direct threads only, notes only (tone and blockedRelayFrom are kept).
  let notes: string | null = null
  if (cardPerson) {
    const proposed = extracted.notes.find((n) => resolvePerson(n.personId, participants) === cardPerson.id)
    const capped = proposed ? capNotes(proposed.notes, deps.config.memory.reflect.cardMaxChars) : ''
    if (capped !== '' && capped !== (card?.notes ?? '').trim()) notes = capped
  }

  // Nothing is written before both calls succeeded, and nothing after an abort.
  if (signal.aborted) throw new Aborted()
  const written: MemoryId[] = []
  for (const c of plan.creates) {
    const m = await deps.memory.write({
      content: c.content,
      subjectPersonId: c.scope.subjectPersonId,
      visibility: c.scope.visibility,
      threadId: c.scope.threadId,
      source: 'inferred',
      authorPersonId: null,
      pinned: false,
    })
    written.push(m.id)
  }
  const now = deps.clock.now()
  for (const [id, content] of plan.updates) {
    await deps.repos.memories.update(id, { content, updatedAt: now })
  }
  const cardsUpdated: PersonId[] = []
  if (cardPerson && notes !== null) {
    await deps.repos.relationships.upsert({
      personId: cardPerson.id,
      tone: card?.tone ?? '',
      notes,
      blockedRelayFrom: card?.blockedRelayFrom ?? [],
    })
    cardsUpdated.push(cardPerson.id)
  }
  return { threadId, throughSeq, written, merged: [...plan.updates.keys()], cardsUpdated }
}

/**
 * ADR-0014: `inferred` may always be rewritten; `stated` only when its author spoke in this pass
 * (a self-correction); `relayed` and `plugin` never.
 */
export function mayRewrite(m: Memory, authorsInPass: ReadonlySet<PersonId>): boolean {
  switch (m.source) {
    case 'inferred':
      return true
    case 'stated':
      return m.authorPersonId !== null && authorsInPass.has(m.authorPersonId)
    case 'relayed':
    case 'plugin':
      return false
  }
}

/** The storage filter that admits exactly one scope. */
export function scopeFilter(scope: Scope): MemoryFilter {
  return scope.visibility === 'subject'
    ? { allowHousehold: false, allowOwner: false, subjectPersonId: scope.subjectPersonId, threadIds: [] }
    : { allowHousehold: false, allowOwner: false, subjectPersonId: null, threadIds: [scope.threadId] }
}

/**
 * Same scope: same visibility and subject, and for `thread` memories the same thread. A `subject`
 * memory's thread doesn't change who sees it, so it isn't compared.
 */
export function inScope(m: Memory, scope: Scope): boolean {
  if (m.visibility !== scope.visibility || m.subjectPersonId !== scope.subjectPersonId) return false
  return scope.visibility !== 'thread' || m.threadId === scope.threadId
}

async function sameScopeMatches(
  deps: ReflectionDeps,
  content: string,
  scope: Scope,
  viewer: Viewer,
  facts: VisibilityFacts,
): Promise<Memory[]> {
  const found = await deps.repos.memories.search(content, scopeFilter(scope), { limit: MATCH_LIMIT })
  // Defense in depth, like every read path: exact scope, and visible to every participant (I-3).
  const kept = found.filter((m) => inScope(m, scope) && isVisible(m, viewer, facts))
  if (kept.length !== found.length) {
    deps.log.warn('storage returned memories outside the scope', { dropped: found.length - kept.length })
  }
  return kept
}

async function loadParticipants(deps: ReflectionDeps, ids: PersonId[]): Promise<Participant[]> {
  const out: Participant[] = []
  for (const id of ids) {
    const p = await deps.repos.persons.get(id)
    out.push({ id, name: p?.name ?? 'Unknown' })
  }
  return out
}

/** A participant id, or a participant's name (models sometimes answer with the name). */
function resolvePerson(value: string | null, participants: Participant[]): PersonId | null {
  if (value === null) return null
  const v = value.trim().toLowerCase()
  return participants.find((p) => p.id === value.trim() || p.name.toLowerCase() === v)?.id ?? null
}

async function describeMessages(
  deps: ReflectionDeps,
  said: MessageRecord[],
  participants: Participant[],
  cardPerson: Participant | undefined,
  notes: string,
): Promise<string> {
  const names = new Map(participants.map((p) => [p.id, p.name]))
  for (const r of said) {
    if (r.authorPersonId !== null && !names.has(r.authorPersonId)) {
      names.set(r.authorPersonId, (await deps.repos.persons.get(r.authorPersonId))?.name ?? 'Unknown')
    }
  }
  const lines = [
    'Participants:',
    ...participants.map((p) => `- ${p.id}: ${p.name}`),
    '',
    `The assistant is ${deps.config.mind.name}.`,
  ]
  if (cardPerson) {
    lines.push('', `Card: ${cardPerson.id} (${cardPerson.name}). Current notes:`, notes.trim() || '(none)')
  } else {
    lines.push('', 'Card: none (group thread, give no notes).')
  }
  lines.push('', 'Messages:')
  for (const r of said) {
    const who =
      r.role === 'assistant'
        ? `${deps.config.mind.name} (assistant)`
        : (names.get(r.authorPersonId as PersonId) ?? 'Unknown')
    const cut = r.meta?.cancelled ? ' [reply cut off]' : ''
    lines.push(`[${who}]: ${r.content.trim()}${cut}`)
  }
  return lines.join('\n')
}

function describeMatches(matched: Candidate[]): string {
  const lines: string[] = []
  matched.forEach((c, i) => {
    lines.push(`Candidate ${i + 1}: ${c.content}`, 'Stored:')
    for (const m of c.matches) lines.push(`- ${m.id}: ${m.content}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}

/** Caps notes at `max` characters, cutting at a word boundary when one is near. */
export function capNotes(notes: string, max: number): string {
  const t = notes.trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.8 ? cut.slice(0, space) : cut).trim()
}

/** Pulls a JSON object out of a model reply (tolerates a code fence or text around it). */
export function parseJsonReply(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** One utility call, retried once in the same pass when the reply isn't valid JSON of the schema. */
async function askJson<T>(
  deps: ReflectionDeps,
  system: string,
  input: string,
  schema: z.ZodType<T>,
  runCtx: RunCtx,
  signal: AbortSignal,
): Promise<T> {
  const messages: LlmMessage[] = [{ role: 'user', content: input }]
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new Aborted()
    const result = await deps.runLoop({
      system,
      messages: [...messages],
      tools: [],
      modelRole: 'utility',
      maxSteps: 1,
      runCtx,
      persist: null,
      signal,
    })
    if (result.stoppedBy === 'cancelled' || signal.aborted) throw new Aborted()
    const parsed = schema.safeParse(parseJsonReply(result.text))
    if (parsed.success) return parsed.data
    deps.log.debug('reflection reply invalid', { attempt: attempt + 1, error: parsed.error.message })
    messages.push({ role: 'assistant', content: result.text }, { role: 'user', content: RETRY_NOTE })
  }
  throw new InvalidOutput('reflection reply is not valid JSON')
}
