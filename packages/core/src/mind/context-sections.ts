// The nine system-prompt sections, in core.md order. Each returns its text, or null when it has
// nothing to say (the builder leaves it out). See docs/architecture/core.md#context-builder.

import type { Skill } from '@keith/sdk'
import type { Commitment, Delivery, Memory, PersonDto, TurnKind } from '../shared/types.ts'
import type { RelationshipRecord } from '../storage/types.ts'

/** 1. Persona: the text of `persona.md`, or a one-line default. */
export function personaSection(persona: string, mindName: string): string {
  const text = persona.trim()
  return text !== '' ? text : `You are ${mindName}, a personal AI.`
}

/** 2. Now: date, time and zone, plus what the focus node can do. */
export function nowSection(a: { now: number; timezone: string; capabilities: string[] }): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: a.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(a.now))
  const caps = a.capabilities.length > 0 ? a.capabilities.join(', ') : 'none declared'
  const lines = [`# Now`, `It is ${when} (${a.timezone}).`, `The person's current device supports: ${caps}.`]
  if (!a.capabilities.includes('ui.render@1')) lines.push('It cannot show visual UI; answer in plain text.')
  if (a.capabilities.includes('audio.out@1')) lines.push('Your reply may be spoken aloud; keep it speakable.')
  return lines.join('\n')
}

export type ParticipantCard = { person: PersonDto; relationship: RelationshipRecord | null }

/** 3. Participants: one relationship card per participant. */
export function participantsSection(cards: ParticipantCard[]): string | null {
  if (cards.length === 0) return null
  const lines = [cards.length === 1 ? '# Who you are talking to' : '# Participants']
  for (const { person, relationship } of cards) {
    lines.push(`- ${person.name} (tier: ${person.tier})`)
    if (relationship?.tone) lines.push(`  Tone: ${relationship.tone}`)
    if (relationship?.notes) lines.push(`  Notes: ${relationship.notes}`)
  }
  return lines.join('\n')
}

/** 4. Core memories: pinned facts visible to every participant. */
export function coreMemoriesSection(memories: Memory[]): string | null {
  if (memories.length === 0) return null
  return ['# What you know', ...memories.map((m) => `- ${m.content}`)].join('\n')
}

/** 5. Memory index: subjects and topics recall can find. */
export function memoryIndexSection(entries: string[]): string | null {
  if (entries.length === 0) return null
  return [
    '# Memory index',
    'You also have memories about these subjects. Use memory.recall when one is relevant:',
    entries.join(', '),
  ].join('\n')
}

/** 6. Awareness digest: what else the Mind is busy with (at most 5 lines). */
export function digestSection(digest: string): string | null {
  const lines = digest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 5)
  if (lines.length === 0) return null
  return ['# Meanwhile', ...lines].join('\n')
}

/** 7. Open commitments in this thread. */
export function commitmentsSection(commitments: Commitment[]): string | null {
  if (commitments.length === 0) return null
  return [
    '# Open promises in this conversation',
    ...commitments.map((c) => `- ${c.promise} (task ${c.taskId})`),
  ].join('\n')
}

/** 8. Pending deliveries, with instructions that depend on the turn kind. */
export function deliveriesSection(deliveries: Delivery[], kind: TurnKind): string | null {
  if (deliveries.length === 0 && kind !== 'briefing') return null
  const lines = ['# Things to tell them']
  if (kind === 'briefing') {
    lines.push(
      'They just arrived after being away. Greet them, then summarize the items below naturally, most urgent first.',
    )
  } else if (kind === 'delivery') {
    lines.push('Nobody asked yet: bring these up on your own. Phrase them naturally, most urgent first.')
  } else {
    lines.push(
      'They just arrived. If their message is a greeting or asks what they missed, lead with these items. Otherwise answer first, then mention them briefly.',
    )
  }
  for (const d of deliveries) {
    const from = d.source === 'core' ? d.kind : `${d.kind} from ${d.source}`
    lines.push(`- [${d.urgency}] (${from}) ${d.content}`)
  }
  return lines.join('\n')
}

/** 9. Skills index: name and one-line description; the full text loads through `skill.load`. */
export function skillsSection(skills: Pick<Skill, 'name' | 'description'>[]): string | null {
  if (skills.length === 0) return null
  return [
    '# Skills',
    'Call skill.load with a name to read its full instructions before using it:',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n')
}
