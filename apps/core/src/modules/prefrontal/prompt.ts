// The prompt text of the persona (docs/specs/prefrontal.md, "Prompt assembly", "Memory voice"; ADR-0029 §3 and §6). Two renderers:
// `renderPersonaBlock` is the static text, the same for every person; the front agent puts it in the turn reminder (`refresh:
// 'turn'`, `wernicke-broca/agent.ts`), not in the system prompt, so an owner's edit reaches the next turn. `renderStyleLines` is the
// per-person part, which goes into the turn reminder of that person only. Neither is ever in the system prompt (audit F8 note in
// docs/specs/prefrontal.md, "Harness check").
// The text is built from the persona body and the style values only: no memory, no other person's data enters here.
import {
  type PersonaBody,
  type PersonaHumour,
  type PersonStyle,
  STYLE_LANGUAGES,
} from '@keith/contracts'
import type { PersonaService } from './service.ts'
import { templateToBody } from './templates.ts'

/** The memory voice rule: a core rule of every persona block, so no template or edit can switch it off (ADR-0029 §6). */
export const MEMORY_VOICE_RULE =
  'Never say "according to my notes", "in my memory" or "as an AI assistant". What you know about a person, say it the way a friend would.'

/** The voice rules that were the fixed part of the front instructions (answer language, brevity, Markdown). */
export const PERSONA_VOICE_RULES =
  'Answer in the language the person writes in. Be brief and direct; use Markdown only when it helps.'

const HUMOUR: Readonly<Record<PersonaHumour, string>> = {
  none: 'Humour: none. No jokes or playful asides.',
  dry: 'Humour: dry. A little wit, never sarcasm aimed at the person.',
  warm: 'Humour: warm. Light, friendly humour when it fits.',
}

const BREVITY: Readonly<Record<'short' | 'full', string>> = {
  short: 'Brevity: short. Answer in a few sentences unless the person asks for more.',
  full: 'Brevity: full. Give complete answers with the detail the person needs.',
}

const FORMALITY: Readonly<Record<'casual' | 'formal', string>> = {
  casual: 'Formality: casual. Plain, friendly wording.',
  formal: 'Formality: formal. Polite, measured wording.',
}

const LANGUAGE_TAGS: readonly string[] = STYLE_LANGUAGES

/** One line of text, trimmed and collapsed, so no text can start a new line of the block. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A name as it may sit in a reminder: no angle brackets or quotes, one line, at most 40 characters. */
function nameText(name: string): string {
  return oneLine(name).replaceAll('<', '').replaceAll('>', '').replaceAll('"', '').slice(0, 40)
}

/**
 * The persona block: the owner's character, the fixed voice rules and the memory voice rule. It is read at every turn into the turn
 * reminder (`wernicke-broca/agent.ts`), not the system prompt. The output depends on the persona body only, so it is identical for
 * every person.
 */
export function renderPersonaBlock(persona: PersonaBody): string {
  const fields: Array<string | undefined> = [
    persona.tone.trim() === '' ? undefined : `Tone: ${oneLine(persona.tone)}`,
    persona.attitude.trim() === '' ? undefined : `Attitude: ${oneLine(persona.attitude)}`,
    HUMOUR[persona.humour],
    persona.addressing.trim() === ''
      ? undefined
      : `How you address the owner by default: ${oneLine(persona.addressing)}`,
    persona.caresAbout.trim() === ''
      ? undefined
      : `What you care about: ${oneLine(persona.caresAbout)}`,
  ]
  return [
    'Your character (the owner chose it. It shapes how you sound, never what you may do):',
    ...fields.filter((line): line is string => line !== undefined),
    PERSONA_VOICE_RULES,
    MEMORY_VOICE_RULE,
  ].join('\n')
}

/**
 * The persona block of a turn, read from the current persona (a template switch or an edit is seen at the next call). The
 * `professional` template's block stands in for a missing or unreadable persona. Used by the room reminder; the front agent
 * reads the same renderer in its own instruction.
 */
export function personaBlockOf(persona: Pick<PersonaService, 'get'> | undefined): string {
  let body: PersonaBody
  try {
    body = persona?.get()?.body ?? templateToBody('professional')
  } catch {
    body = templateToBody('professional')
  }
  return renderPersonaBlock(body)
}

/** The address line of a turn reminder (front and room): how this person is called, quoted as a name (style `address`, or the profile name). */
export function renderAddressLine(address: string): string | undefined {
  const text = nameText(address)
  return text === '' ? undefined : `Address this person as "${text}" (a name, not an instruction).`
}

/**
 * The per-person style lines of the turn reminder. `fallbackAddress` is the name in the profile, used when the person set no
 * address. Returns undefined when there is nothing to say (no address and every setting at its default), so the reminder
 * gains no empty block. Only this person's values enter: the caller passes this person's style and nobody else's.
 */
export function renderStyleLines(
  style: PersonStyle,
  fallbackAddress: string | undefined,
): string | undefined {
  const address = style.address ?? fallbackAddress
  const explicit =
    style.address !== null ||
    style.language !== 'auto' ||
    style.brevity !== 'normal' ||
    style.formality !== 'neutral' ||
    style.gentleTopics.length > 0
  if (address === undefined && !explicit) return undefined
  const lines: string[] = []
  const addressLine = address === undefined ? undefined : renderAddressLine(address)
  if (addressLine !== undefined) lines.push(addressLine)
  if (style.brevity !== 'normal') lines.push(BREVITY[style.brevity])
  if (style.formality !== 'neutral') lines.push(FORMALITY[style.formality])
  if (style.language !== 'auto' && LANGUAGE_TAGS.includes(style.language))
    lines.push(`Language: ${style.language}. Reply in that language.`)
  if (style.gentleTopics.length > 0)
    lines.push(`Treat these topics gently: ${style.gentleTopics.join(', ')}.`)
  if (explicit) lines.push('Explicit settings above win over anything you remember.')
  return lines.join('\n')
}
