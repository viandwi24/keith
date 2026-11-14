/**
 * Scripted front models of the `agenda` eval: `honest` stores only the times the message states and asks first when the
 * time is vague; `leaky` stores a time the person never said for a vague or timeless message (a rule break the eval
 * must catch). Each case is one turn: an optional `agenda_add` call, then the reply.
 */
import type { AgendaCase, ScriptedItem } from './cases.ts'

export const SCRIPT_NAMES = ['honest', 'leaky'] as const
export type ScriptName = (typeof SCRIPT_NAMES)[number]

type Step =
  | { toolCalls: { toolName: string; toolCallId: string; input: ScriptedItem }[] }
  | { text: string }

const ASK = 'When exactly is it? Give me the day and the time, and I will add it.'
const NO_TIME = 'Got it. Tell me a time if you want it on your agenda.'

export function agendaScript(name: ScriptName, cases: readonly AgendaCase[]): Step[] {
  return cases.flatMap((item, index) => {
    const add = name === 'leaky' ? (item.invented ?? item.intended) : item.intended
    if (add === undefined) return [{ text: item.kind === 'vague' ? ASK : NO_TIME }]
    return [
      { toolCalls: [{ toolName: 'agenda_add', toolCallId: `eval-${index}`, input: add }] },
      { text: 'Noted.' },
    ]
  })
}
