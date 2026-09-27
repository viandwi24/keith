// Folds the rows that left the recent-messages window into `threads.summary` (ADR-0014).
// See docs/architecture/memory.md#thread-summary.

import type { KeithConfig } from '../../config/types.ts'
import type { CoreEventBus } from '../../events/types.ts'
import type { RunLoop } from '../../mind/types.ts'
import type { Logger, PersonId, ThreadId } from '../../shared/types.ts'
import type { MessageRecord, Repositories } from '../../storage/types.ts'
import type { ThreadSummarizer } from '../types.ts'
import { cutAtSentence, type SummaryLine, summarySystemPrompt, summaryUserPrompt } from './prompts.ts'

/**
 * Rows read by one update. A thread far behind (a long thread from before phase 4) catches up
 * over several turns instead of sending thousands of rows in one call.
 */
export const SUMMARY_MAX_ROWS = 400

export type SummarizerDeps = {
  config: Pick<KeithConfig, 'memory' | 'mind'>
  repos: Pick<Repositories, 'threads' | 'messages' | 'persons'>
  runLoop: RunLoop
  events: Pick<CoreEventBus, 'emit'>
  log: Logger
}

export function createSummarizer(deps: SummarizerDeps): ThreadSummarizer {
  const { config, repos, log } = deps
  return {
    async update({ threadId, signal }) {
      const thread = await repos.threads.get(threadId)
      if (!thread || signal.aborted) return false
      const from = thread.summaryThroughSeq ?? 0
      const upTo = (await repos.messages.lastSeq(threadId)) - config.mind.context.recentMessages
      if (upTo - from < config.memory.summary.minMessages) return false
      const rows = (await repos.messages.range({ threadId, afterSeq: from, limit: SUMMARY_MAX_ROWS })).filter(
        (r) => (r.seq ?? 0) <= upTo,
      )
      // `seq` may skip numbers, so the row count decides, not the seq distance.
      if (rows.length < config.memory.summary.minMessages) return false
      const throughSeq = rows.reduce((max, r) => Math.max(max, r.seq ?? 0), from)

      const lines = await transcript(deps, rows)
      let summary = thread.summary ?? ''
      if (lines.length > 0) {
        const participants = (await repos.threads.participants(threadId)).map((p) => p.personId)
        const personId = thread.ownerPersonId ?? participants[0]
        if (personId === undefined) {
          log.warn('thread summary skipped: thread has no participants', { threadId })
          return false
        }
        const text = await ask(deps, {
          threadId,
          personId,
          participants,
          previous: thread.summary,
          lines,
          signal,
        })
        if (text === null) return false
        summary = cutAtSentence(text, config.memory.summary.maxChars)
      }
      await repos.threads.setSummary(threadId, { summary, throughSeq })
      deps.events.emit('thread.summarized', { threadId, throughSeq })
      return true
    },
  }
}

/** User and final assistant rows only: tool rows and tool-step assistant rows are skipped. */
async function transcript(deps: SummarizerDeps, rows: MessageRecord[]): Promise<SummaryLine[]> {
  const names = new Map<PersonId, string>()
  const lines: SummaryLine[] = []
  for (const r of rows) {
    if (r.role === 'tool') continue
    if (r.role === 'assistant' && r.toolCalls && r.toolCalls.length > 0) continue
    const text = r.content.trim()
    if (text === '') continue
    if (r.role === 'assistant') {
      lines.push({ speaker: `${deps.config.mind.name} (you)`, text })
      continue
    }
    const id = r.authorPersonId
    let speaker = 'Someone'
    if (id !== null) {
      const cached = names.get(id)
      if (cached !== undefined) speaker = cached
      else {
        speaker = (await deps.repos.persons.get(id))?.name ?? 'Someone'
        names.set(id, speaker)
      }
    }
    lines.push({ speaker, text })
  }
  return lines
}

/** One utility-model step. Null (logged) on an empty, cancelled or failed reply. */
async function ask(
  deps: SummarizerDeps,
  a: {
    threadId: ThreadId
    personId: PersonId
    participants: PersonId[]
    previous: string | null
    lines: SummaryLine[]
    signal: AbortSignal
  },
): Promise<string | null> {
  try {
    const result = await deps.runLoop({
      system: summarySystemPrompt(deps.config.memory.summary.maxChars),
      messages: [{ role: 'user', content: summaryUserPrompt({ previous: a.previous, lines: a.lines }) }],
      tools: [],
      modelRole: 'utility',
      maxSteps: 1,
      runCtx: { personId: a.personId, participants: a.participants, threadId: a.threadId, taskId: null },
      persist: null,
      signal: a.signal,
    })
    if (result.stoppedBy === 'cancelled') return null
    const text = result.text.trim()
    if (text === '') {
      deps.log.warn('thread summary: empty model reply, summary unchanged', { threadId: a.threadId })
      return null
    }
    return text
  } catch (error) {
    deps.log.warn('thread summary: model call failed, summary unchanged', {
      threadId: a.threadId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
