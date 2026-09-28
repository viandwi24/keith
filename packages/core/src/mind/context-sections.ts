// The system-prompt sections, in core.md order (nine, plus the thread summary between 7 and 8). Each returns its text, or null when it has
// nothing to say (the builder leaves it out). See docs/architecture/core.md#context-builder.

import type { Skill } from '@keith/sdk'
import type { Commitment, Delivery, Memory, PersonDto, PersonId, TurnKind } from '../shared/types.ts'
import type { RelationshipRecord } from '../storage/types.ts'
import { authorName } from './messages.ts'

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

/** What section 3 says about a group thread (phase 5). */
export type GroupContext = {
  title: string
  /** Null when the group has none. */
  purpose: string | null
  /** The name of the author of the input this turn answers; null when the turn answers no input. */
  answering: string | null
}

/** S-6 step 3: the tone rule for a group thread. */
export const GROUP_TONE_RULE =
  'Several people read this thread. Use the most formal tone among the participants unless you are answering one person directly.'

/** A group thread is also a place where people talk to each other. */
export const GROUP_ADDRESS_RULE =
  'People talk to each other here too. Answer only what is addressed to you, and keep it short.'

/**
 * 3. Participants: one relationship card per participant. In a group thread (`group` given): every
 * current participant's card, the thread's title and purpose, whose message the turn answers, and
 * the group rules.
 */
export function participantsSection(cards: ParticipantCard[], group?: GroupContext | null): string | null {
  if (!group) {
    if (cards.length === 0) return null
    return [cards.length === 1 ? '# Who you are talking to' : '# Participants', ...cardLines(cards)].join(
      '\n',
    )
  }
  const lines = ['# Participants', `This is the group thread "${group.title}".`]
  const purpose = group.purpose?.trim() ?? ''
  if (purpose !== '') lines.push(`Its purpose: ${purpose}`)
  lines.push(...cardLines(cards))
  if (group.answering !== null) lines.push(`You are answering ${group.answering}'s message.`)
  lines.push(GROUP_TONE_RULE, GROUP_ADDRESS_RULE)
  return lines.join('\n')
}

function cardLines(cards: ParticipantCard[]): string[] {
  const lines: string[] = []
  for (const { person, relationship } of cards) {
    lines.push(`- ${person.name} (tier: ${person.tier})`)
    if (relationship?.tone) lines.push(`  Tone: ${relationship.tone}`)
    if (relationship?.notes) lines.push(`  Notes: ${relationship.notes}`)
  }
  return lines
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

/**
 * 7b. Thread summary (phase 4): what the thread said before the messages window. Null when the
 * thread has no summary.
 */
export function summarySection(summary: string | null | undefined): string | null {
  const text = summary?.trim() ?? ''
  if (text === '') return null
  return ['# Earlier in this thread', text].join('\n')
}

/** The default skill that briefing and arrival turns load first when it is registered (P4-D1). */
export const BRIEFING_SKILL = 'morning_briefing'

/** Section 8's instruction when the items include a relay (I-13). */
export const RELAY_INSTRUCTION =
  'A relay is a message another person asked you to pass on. Pass it on here, and say who it is from.'

/** Section 8's instruction when the items include a group invitation (phase 5). */
export const INVITATION_INSTRUCTION =
  'An invitation asks them to join a group thread. Ask whether they want to join. When they agree, call thread.join with the thread id from the invitation; when they decline, call thread.leave with it.'

/**
 * 8. Pending deliveries, with instructions that depend on the turn kind. `skillNames` are the
 * registered skills: briefing and arrival instructions point at `BRIEFING_SKILL` only when it is
 * one of them. `names` resolves the authors of `relay` and `invitation` items (an unknown author
 * reads as `Someone`).
 */
export function deliveriesSection(
  deliveries: Delivery[],
  kind: TurnKind,
  skillNames: readonly string[] = [],
  names: ReadonlyMap<PersonId, string> = new Map(),
): string | null {
  if (deliveries.length === 0 && kind !== 'briefing') return null
  const lines = ['# Things to tell them']
  if (kind === 'briefing') {
    lines.push(
      'They just arrived after being away. Greet them, then summarize the items below naturally, most urgent first.',
    )
    if (skillNames.includes(BRIEFING_SKILL)) lines.push(briefingHint())
  } else if (kind === 'delivery') {
    lines.push('Nobody asked yet: bring these up on your own. Phrase them naturally, most urgent first.')
  } else {
    lines.push(
      'They just arrived. If their message is a greeting or asks what they missed, lead with these items. Otherwise answer first, then mention them briefly.',
    )
    if (skillNames.includes(BRIEFING_SKILL)) lines.push(briefingHint())
  }
  if (deliveries.some((d) => d.kind === 'relay')) lines.push(RELAY_INSTRUCTION)
  if (deliveries.some((d) => d.kind === 'invitation')) lines.push(INVITATION_INSTRUCTION)
  for (const d of deliveries) lines.push(`- [${d.urgency}] (${deliveryLabel(d, names)}) ${d.content}`)
  return lines.join('\n')
}

function deliveryLabel(d: Delivery, names: ReadonlyMap<PersonId, string>): string {
  if (d.kind === 'relay' || d.kind === 'invitation')
    return `${d.kind} from ${authorName(d.authorPersonId, names)}`
  return d.source === 'core' ? d.kind : `${d.kind} from ${d.source}`
}

function briefingHint(): string {
  return `If the skills index lists \`${BRIEFING_SKILL}\`, load it first.`
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
