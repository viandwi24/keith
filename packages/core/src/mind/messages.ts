// Conversions between stored messages, LLM messages and wire DTOs.

import type { MessageDto } from '@keith/protocol'
import type { LlmMessage } from '@keith/sdk'
import type { Tier } from '../shared/types.ts'
import type { AssistantMessageRecord, MessageRecord } from '../storage/types.ts'

/**
 * Replays stored messages as `LlmMessage[]`. A window cut can leave tool rows without their
 * assistant call, or an assistant call without all of its results (a crash mid-step). Providers
 * reject both, so orphan tool rows are dropped and incomplete calls lose their `toolCalls`.
 */
export function toLlmMessages(records: MessageRecord[]): LlmMessage[] {
  const out: LlmMessage[] = []
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    // Tool rows of complete call groups are emitted with their assistant row below.
    if (r === undefined || r.role === 'tool') continue
    if (r.role === 'user') {
      out.push({ role: 'user', content: r.content })
    } else if (r.toolCalls && r.toolCalls.length > 0) {
      const results = collectResults(records, i + 1, r)
      if (results) {
        out.push({ role: 'assistant', content: r.content, toolCalls: r.toolCalls })
        for (const t of results) out.push({ role: 'tool', toolCallId: t.toolCallId, content: t.content })
      } else if (r.content !== '') {
        out.push({ role: 'assistant', content: r.content })
      }
    } else {
      out.push({ role: 'assistant', content: r.content })
    }
  }
  return out
}

function collectResults(
  records: MessageRecord[],
  from: number,
  call: AssistantMessageRecord,
): { toolCallId: string; content: string }[] | null {
  const byId = new Map<string, string>()
  for (let j = from; j < records.length; j++) {
    const t = records[j]
    if (t === undefined || t.role !== 'tool') break
    byId.set(t.toolCallId, t.content)
  }
  const results: { toolCallId: string; content: string }[] = []
  for (const c of call.toolCalls ?? []) {
    const content = byId.get(c.id)
    if (content === undefined) return null
    results.push({ toolCallId: c.id, content })
  }
  return results
}

/**
 * The wire view of a stored message, or null for rows nodes never see: tool rows, and the
 * intermediate assistant rows of a tool loop (the turn's visible text is on its final message).
 */
export function toMessageDto(r: MessageRecord): MessageDto | null {
  if (r.role === 'tool') return null
  if (r.role === 'assistant' && r.toolCalls && r.toolCalls.length > 0) return null
  const dto: MessageDto = {
    id: r.id,
    threadId: r.threadId,
    role: r.role,
    authorPersonId: r.authorPersonId,
    modality: r.modality,
    content: r.content,
    createdAt: r.createdAt,
  }
  if (r.role === 'assistant' && r.ui && r.ui.length > 0) dto.ui = r.ui.map((e) => e.block)
  if (r.meta) dto.meta = stripUndefined(r.meta)
  return dto
}

function stripUndefined(meta: NonNullable<MessageRecord['meta']>): NonNullable<MessageDto['meta']> {
  const out: NonNullable<MessageDto['meta']> = {}
  if (meta.cancelled !== undefined) out.cancelled = meta.cancelled
  if (meta.proactive !== undefined) out.proactive = meta.proactive
  if (meta.spokenChars !== undefined) out.spokenChars = meta.spokenChars
  return out
}

const TIER_RANK: Record<Tier, number> = { guest: 0, member: 1, owner: 2 }

/** The lowest tier among `tiers` (owner > member > guest). Guest when empty. */
export function lowestTier(tiers: Tier[]): Tier {
  let lowest: Tier | null = null
  for (const t of tiers) if (lowest === null || TIER_RANK[t] < TIER_RANK[lowest]) lowest = t
  return lowest ?? 'guest'
}
