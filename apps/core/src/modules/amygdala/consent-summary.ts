// The one-line summary of an approval, in words the person reads (and the consent classifier sees): the node, the capability and the
// command of a machine call (redacted and capped), the tool name for anything else. Pure over the call.
import { redactString } from '../../platform/logger.ts'
import { motorAskOf } from '../motor/index.ts'

/** Characters of the command in a summary. */
export const SUMMARY_COMMAND_MAX = 200

export function approvalSummary(toolName: string, input: unknown): string {
  const call = motorAskOf(toolName, input)
  if (call === undefined) return `the tool ${toolName}`
  const command =
    call.command === undefined
      ? ''
      : `: ${redactString(call.command).slice(0, SUMMARY_COMMAND_MAX)}`
  return `${call.capability} on ${call.node}${command}`
}
