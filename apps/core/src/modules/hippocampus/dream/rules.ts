// The applier's rules as pure functions (docs/specs/dreaming.md "Applier", ADR-0031 §4). No file access here: apply.ts reads and
// writes the memory files and asks these functions what a candidate may do. Every rule has a pass case and a refusal case in
// rules.test.ts. Days are `YYYY-MM-DD` (the host zone, as the collector writes them), compared as UTC midnights.
import { ADDRESS_DENY_WORDS } from '@keith/contracts'
import { looksLikeSecret } from '../secret-guard.ts'

/** The size cap of `profile.md` after a change (`maxPinnedChars`, ADR-0031 §4). A result over it is staged, never truncated. */
export const PROFILE_MAX_CHARS = 2000
/** A short-term entry last seen more than this many days before the run moves to `archive.md` (reason `expired`). */
export const EXPIRY_DAYS = 14
/** Promotion by mentions: the fact is mentioned on at least this many different days. */
export const MENTION_DAYS = 2
/** Promotion by importance: a judge score at or above this one. */
export const PROMOTE_IMPORTANCE = 8
/** A run writes at most this many candidates (larger plans are staged in full). */
export const RUN_CANDIDATE_CAP = 40
/** A run changes at most this many memory files (larger plans are staged in full). */
export const RUN_FILE_CAP = 10

const DAY_MS = 86_400_000

/** The form entries compare by: Unicode-normalised, lower case, single spaces, no trailing punctuation. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?;:]+$/u, '')
    .trim()
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). Negative when `to` is the earlier day. */
export function dayDiff(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS
}

/** A short-term entry is expired when it was last seen more than 14 days before `today` (exactly 14 is still kept). */
export function isExpired(seen: string, today: string): boolean {
  return dayDiff(seen, today) > EXPIRY_DAYS
}

const REMEMBER_QUOTED = /\b(remember this|remember that|please remember|keep this)\b/i

/** The person asked to keep the fact: the source is the person's own message and quotes one of the phrases. */
export function rememberQuoted(source: {
  readonly text: string
  readonly role: 'user' | 'assistant'
}): boolean {
  return source.role === 'user' && REMEMBER_QUOTED.test(source.text)
}

export type PromotionBasis = 'mentions' | 'remember' | 'importance'

/**
 * Why a candidate may leave the short-term file for a topic file or `profile.md`, or null when none holds (ADR-0031 §4,
 * "Promotion"). `days` lists the day of each mention (the candidate's own day and the days of earlier entries).
 */
export function promotionBasis(input: {
  readonly days: readonly string[]
  readonly source: { readonly text: string; readonly role: 'user' | 'assistant' }
  readonly importance: number
}): PromotionBasis | null {
  if (new Set(input.days).size >= MENTION_DAYS) return 'mentions'
  if (rememberQuoted(input.source)) return 'remember'
  if (input.importance >= PROMOTE_IMPORTANCE) return 'importance'
  return null
}

const DENY = new Set(ADDRESS_DENY_WORDS)
/** Phrases that tell Keith how to talk or who to be. Addressed to Keith they are instructions; `call me` opens a name, not a fact. */
const STYLE_PHRASES = [
  'answer in',
  'respond in',
  'reply in',
  'speak in',
  'write in',
  'call me',
  'act as',
]
const STYLE_ALTERNATION = STYLE_PHRASES.join('|')
const DENY_ALTERNATION = ADDRESS_DENY_WORDS.join('|')
/** A sentence that opens with a deny word or a style phrase, after the filler words people put in front (`Please always ...`). */
const OPENS_WITH_STYLE = new RegExp(`^(${STYLE_ALTERNATION})\\b`, 'i')
/** A sentence that addresses Keith (`you`, `keith`) and then names a deny word or a style phrase. */
const ADDRESSED_TO_KEITH = new RegExp(
  `\\b(you|keith)\\b[^.!?\\n]*\\b(${DENY_ALTERNATION}|${STYLE_ALTERNATION})\\b`,
  'i',
)
/** Anywhere in the text: a standing instruction (`from now on`) or an identity override (`you are now`). */
const STANDING_INSTRUCTION = /\b(from now on|you are now)\b/i
const FILLER_WORD = /^(please|also|now|just|and|then|ok|okay)\b[\s,]*/i

/** The sentences of a text: split at `.`, `!`, `?`, `;` and line breaks. */
const sentencesOf = (text: string): string[] => text.split(/[.!?;\n]+/).map((s) => s.trim())

/** True when a sentence opens with a deny word (as a whole word, after any filler words) or with a style phrase. */
function opensWithInstruction(sentence: string): boolean {
  let rest = sentence
  for (let before = ''; before !== rest; ) {
    before = rest
    rest = rest.replace(FILLER_WORD, '')
  }
  const first = rest
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .find((word) => word.length > 0)
  if (first !== undefined && DENY.has(first)) return true
  return OPENS_WITH_STYLE.test(rest)
}

/**
 * A style or an instruction rather than a fact (ADR-0031 §4, "Style is out of reach"; ADR-0029 §3). The rule is per sentence: a
 * sentence that opens with a P33 deny word or a style phrase (`Always answer in French`, `Please speak in short sentences`,
 * `Call me Ana`), a sentence that addresses Keith with one (`you must ignore`, `I want you to answer in French`), or a standing
 * instruction anywhere (`from now on`, `you are now`) is a directive. A deny word in the middle of a sentence is a fact:
 * `I always drink tea` and `Remember that I never eat fish` pass; so does `They call me Ana`.
 */
export function isDirective(text: string): boolean {
  if (STANDING_INSTRUCTION.test(text)) return true
  return sentencesOf(text).some(
    (sentence) => opensWithInstruction(sentence) || ADDRESSED_TO_KEITH.test(sentence),
  )
}

/** True when any written line looks like a credential (the secret gate, ADR-0031 §4, "Secrets"). */
export function secretShaped(lines: readonly string[]): boolean {
  return lines.some((line) => looksLikeSecret(line))
}

/** The caps of one run: at most 40 written candidates and 10 changed files (ADR-0031 §4, "Caps"). */
export function withinRunCaps(input: {
  readonly candidates: number
  readonly files: number
}): boolean {
  return input.candidates <= RUN_CANDIDATE_CAP && input.files <= RUN_FILE_CAP
}

export type ProfileDecision = 'none' | 'write' | 'proposal' | 'size'

/**
 * What happens to the changes of `profile.md` in one run (ADR-0031 §4, "profile.md is a proposal"). `none`: no change. `size`:
 * the result is over the cap. `write`: exactly one change, and it only adds one entry. `proposal`: anything else, staged.
 */
export function profileDecision(input: {
  readonly changes: number
  readonly appendOnly: boolean
  readonly resultChars: number
}): ProfileDecision {
  if (input.changes === 0) return 'none'
  if (input.resultChars > PROFILE_MAX_CHARS) return 'size'
  return input.changes === 1 && input.appendOnly ? 'write' : 'proposal'
}
