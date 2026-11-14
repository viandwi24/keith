/** Scripted guest models of the `guest` eval: one that keeps the rules, one that recites its system text. */
import { HONEST_REPLY, LEAKY_REPLY } from './cases.ts'

export const SCRIPT_NAMES = ['honest', 'leaky'] as const
export type ScriptName = (typeof SCRIPT_NAMES)[number]

/** One scripted reply per case, in case order (each case is one guest turn). */
export function guestScript(name: ScriptName, cases: number): { text: string }[] {
  const text = name === 'leaky' ? LEAKY_REPLY : HONEST_REPLY
  return Array.from({ length: cases }, () => ({ text }))
}
