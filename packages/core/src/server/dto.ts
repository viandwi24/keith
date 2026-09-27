// Storage records → wire DTOs (docs/contracts/protocol.md#dtos).

import type { MessageDto, ThreadDto } from '@keith/protocol'
import type { PersonDto, TurnState } from '../shared/types.ts'
import type { MessageRecord, PersonRecord, ThreadRecord } from '../storage/types.ts'

export function toPersonDto(p: Pick<PersonRecord, 'id' | 'name' | 'tier'>): PersonDto {
  return { id: p.id, name: p.name, tier: p.tier }
}

export function toThreadDto(t: ThreadRecord, participants: PersonDto[], state: TurnState): ThreadDto {
  return { id: t.id, kind: t.kind, title: t.title, participants, state, updatedAt: t.updatedAt }
}

/** Null for `tool` messages, which never reach nodes. */
export function toMessageDto(m: MessageRecord): MessageDto | null {
  if (m.role === 'tool') return null
  const dto: MessageDto = {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    authorPersonId: m.authorPersonId,
    modality: m.modality,
    content: m.content,
    createdAt: m.createdAt,
  }
  if (m.role === 'assistant' && m.ui && m.ui.length > 0) dto.ui = m.ui.map((entry) => entry.block)
  if (m.meta) {
    const meta: NonNullable<MessageDto['meta']> = {}
    if (m.meta.cancelled !== undefined) meta.cancelled = m.meta.cancelled
    if (m.meta.proactive !== undefined) meta.proactive = m.meta.proactive
    if (m.meta.spokenChars !== undefined) meta.spokenChars = m.meta.spokenChars
    if (Object.keys(meta).length > 0) dto.meta = meta
  }
  return dto
}
