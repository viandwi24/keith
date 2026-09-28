// The addressing rule pass (phase 5): cheap, pure and synchronous, because the thread manager asks
// on every group input. See docs/architecture/core.md#group-threads (Addressing).

import type { PersonId } from '../../shared/types.ts'
import type { MessageRecord } from '../../storage/types.ts'
import type { AddressingVerdict } from '../types.ts'

export type RuleInput = {
  /** `mind.name`. */
  mindName: string
  input: { authorPersonId: PersonId; text: string }
  /** Messages before the input, oldest first. Tool messages and empty steps are skipped. */
  recent: MessageRecord[]
  /** Current human participants' names. */
  participantNames: string[]
}

/** How many of the latest visible messages rule 4 looks back for the Mind's. */
export const QUESTION_LOOKBACK = 3

const UNSURE: AddressingVerdict = { addressed: false, by: 'unsure' }

/**
 * Decides an input by rule, in this order:
 * 1. fewer than two human participants: `single_human`, addressed;
 * 2. the Mind named as a word: `name`, addressed; else another participant named first: `other_human`;
 * 3. the latest visible message is the Mind's and ended with a question: `reply`, addressed;
 * 4. a question naming no participant while one of the last three visible messages is the Mind's:
 *    `question`, addressed;
 * 5. anything else: `unsure` (not addressed; the classifier may look at it).
 */
export function decideByRules(a: RuleInput): AddressingVerdict {
  if (new Set(a.participantNames.map(fold)).size < 2) return { addressed: true, by: 'single_human' }

  const text = a.input.text
  if (mentions(text, a.mindName)) return { addressed: true, by: 'name' }
  const humans = a.participantNames.filter((n) => fold(n) !== fold(a.mindName))
  if (humans.some((n) => opensWith(text, n))) return { addressed: false, by: 'other_human' }

  const visible = visibleMessages(a.recent)
  const latest = visible.at(-1)
  // The thread manager decides only for current participants, so the author is one now. Join
  // times aren't in the detector's input: a person who joined after the question counts too.
  if (latest?.role === 'assistant' && endsWithQuestion(latest.content))
    return { addressed: true, by: 'reply' }

  const mindSpokeLately = visible.slice(-QUESTION_LOOKBACK).some((m) => m.role === 'assistant')
  if (mindSpokeLately && isQuestion(text) && !humans.some((n) => mentions(text, n))) {
    return { addressed: true, by: 'question' }
  }
  return UNSURE
}

/** User and assistant messages with text, the ones people see. */
export function visibleMessages(recent: MessageRecord[]): MessageRecord[] {
  return recent.filter((m) => m.role !== 'tool' && m.content.trim() !== '')
}

// Names

const WORD = '[\\p{L}\\p{N}_]'

function fold(s: string): string {
  return s.trim().toLocaleLowerCase()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The full name, and its first word for a multi-word name ("Pepper" for "Pepper Potts"). */
function nameForms(name: string): string[] {
  const full = name.trim().replace(/\s+/g, ' ')
  if (full === '') return []
  const first = full.split(' ')[0] ?? full
  return first === full ? [full] : [full, first]
}

function namePattern(name: string): string | null {
  const forms = nameForms(name)
  if (forms.length === 0) return null
  return `(?:${forms.map((f) => escapeRegExp(f).replace(/ /g, '\\s+')).join('|')})`
}

/** The name as a whole word, in any letter case ("@keith" and "Keith's" count, "Keithley" doesn't). */
export function mentions(text: string, name: string): boolean {
  const p = namePattern(name)
  if (p === null) return false
  return new RegExp(`(?<!${WORD})${p}(?!${WORD})`, 'iu').test(text)
}

const GREETING = '(?:hey|hi|hello|yo|ok|okay)'

/**
 * The text opens by naming this person: "@pepper …", "hey Pepper …", or the bare name followed
 * by punctuation or the end ("Pepper, …", "Rhodey: …", "Rhodey?"). "Pepper is late" doesn't.
 */
export function opensWith(text: string, name: string): boolean {
  const p = namePattern(name)
  if (p === null) return false
  const end = `(?!${WORD})`
  return (
    new RegExp(`^\\s*@${p}${end}`, 'iu').test(text) ||
    new RegExp(`^\\s*${GREETING}[\\s,]+@?${p}${end}`, 'iu').test(text) ||
    new RegExp(`^\\s*${p}\\s*(?:[,:;!?.\\-–—]|$)`, 'iu').test(text)
  )
}

// Questions

const WH_WORDS = [
  'what',
  "what's",
  'whats',
  'when',
  'where',
  'who',
  "who's",
  'whom',
  'whose',
  'why',
  'how',
  "how's",
  'which',
]
const AUXILIARIES = [
  'is',
  'are',
  'am',
  'was',
  'were',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'have',
  'has',
  'had',
]
/** An auxiliary opens a question only when a subject follows ("can you", "is it"). */
const SUBJECTS = [
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'this',
  'that',
  'there',
  'the',
  'a',
  'an',
  'anyone',
  'anybody',
  'someone',
  'somebody',
  'everyone',
  'our',
  'my',
  'your',
  'their',
]

const WH_OPENING = new RegExp(`^\\s*(?:${WH_WORDS.map(escapeRegExp).join('|')})(?!${WORD})`, 'iu')
const AUX_OPENING = new RegExp(
  `^\\s*(?:${AUXILIARIES.join('|')})(?:n't)?\\s+(?:${SUBJECTS.join('|')})(?!${WORD})`,
  'iu',
)
/** "do" also opens commands ("do it now"), so only a person may follow it ("do you", "do we"). */
const DO_SUBJECTS = ['i', 'you', 'we', 'they', 'anyone', 'anybody', 'someone', 'somebody', 'everyone']
const DO_OPENING = new RegExp(`^\\s*do(?:n't)?\\s+(?:${DO_SUBJECTS.join('|')})(?!${WORD})`, 'iu')

function endsWithQuestion(text: string): boolean {
  return /\?[\s"')\]”]*$/u.test(text.trim())
}

/** A "?" anywhere, or an interrogative opening ("what …", "can you …"). */
export function isQuestion(text: string): boolean {
  return text.includes('?') || WH_OPENING.test(text) || AUX_OPENING.test(text) || DO_OPENING.test(text)
}
