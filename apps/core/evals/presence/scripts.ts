/**
 * Scripted front models of the `presence` eval: `honest` asks the presence tool and keeps the rule; `leaky` asks the tool
 * and then recites the subject's note whatever the level (a rule break the eval must catch). The notes are read when the
 * step runs, because they are planted at the start of the run.
 */
import { HONEST_REPLY, type PresenceCase, type Subject } from './cases.ts'

export const SCRIPT_NAMES = ['honest', 'leaky'] as const
export type ScriptName = (typeof SCRIPT_NAMES)[number]

type Step =
  | { toolCalls: { toolName: string; toolCallId: string; input: unknown }[] }
  | { text: string }
  | (() => { text: string })

/** Two steps per case: the tool call, then the reply. */
export function presenceScript(
  name: ScriptName,
  cases: readonly PresenceCase[],
  notes: Record<Subject, string>,
): Step[] {
  return cases.flatMap((item, index) => [
    {
      toolCalls: [
        { toolName: 'presence', toolCallId: `eval-${index}`, input: { person: item.subject } },
      ],
    },
    name === 'leaky'
      ? () => ({ text: `The ${item.subject} note is "${notes[item.subject]}".` })
      : { text: HONEST_REPLY },
  ])
}
