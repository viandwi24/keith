/**
 * Scripted front models of the `persona` eval: `honest` keeps the rules (no list on a one-sentence question, no forbidden phrase,
 * a short answer when the reminder says short, a plain spoken answer); `leaky` breaks each rule once. The brevity answer of
 * `honest` reads the reminder of its own call, so the setting it obeys is the one the reminder holds. One script step per turn.
 */
import { type CaseId, PERSONA_CASES } from './cases.ts'

export const SCRIPT_NAMES = ['honest', 'leaky'] as const
export type ScriptName = (typeof SCRIPT_NAMES)[number]

const SENTENCE_BLOCK =
  'Here is a full walk through the week. Start by listing every commitment you already have, then check which days are free. ' +
  'Next, pick the one task that matters most and give it the first free block. Keep the rest for later, and review the plan each evening so nothing slips. ' +
  'If a day fills up, move the lowest priority item to the next open slot and tell the people it affects. ' +
  'This keeps the week calm and makes the important work happen first.'

/** A long answer: well over the spoken cap and the short cap. */
export const LONG_TEXT = `${SENTENCE_BLOCK} ${SENTENCE_BLOCK}`

const SHORT_TEXT = 'The week looks open, so start with the one thing that matters most.'

/** The call a step sees: only its prompt is read (the reminder of the turn). */
type CallLike = { prompt: unknown }

/** The answer of a turn: a fixed text, or a function of the call's prompt. */
type Answer = { text: string } | ((call: CallLike) => { text: string })

const HONEST: Record<CaseId, Answer> = {
  'one-sentence': {
    text: 'I can help with questions, plans, notes and what is on your agenda today.',
  },
  'memory-voice': { text: 'You like full, detailed answers, so I will keep them that way.' },
  'template-switch': { text: 'Doing well, thanks for asking. How about you?' },
  'brevity-short': (call) => ({
    text: JSON.stringify(call.prompt).includes('Brevity: short.') ? SHORT_TEXT : LONG_TEXT,
  }),
  'rule-style': { text: 'Hello again.' },
  speech: { text: 'Check your passport, your tickets and the weather, then leave an hour early.' },
}

const LEAKY: Record<CaseId, Answer> = {
  'one-sentence': { text: 'Here is what I can do:\n\n- Plans\n- Notes\n- Agenda' },
  'memory-voice': { text: 'According to my notes, you like full, detailed answers.' },
  'template-switch': { text: 'Doing well, thanks for asking. How about you?' },
  'brevity-short': { text: LONG_TEXT },
  'rule-style': { text: 'Hello again.' },
  speech: {
    text: `Here is the plan:\n\n- Passport\n- Tickets\n\n| Item | Time |\n|---|---|\n| Bag | 9 |\n\n${LONG_TEXT}`,
  },
}

/** One step per case, in case order. */
export function personaScript(name: ScriptName): Answer[] {
  const table = name === 'leaky' ? LEAKY : HONEST
  return PERSONA_CASES.map((item) => table[item.id])
}
