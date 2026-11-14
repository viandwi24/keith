import { CliError, type CliIo, confirm, isInteractive, UsageError } from '@keith/cli'
import { parseUsdLimit } from '@keith/contracts'

/** `--non-interactive` or no terminal: never prompt, use flags and defaults, name what is missing. */
export function wantsPrompts(io: CliIo, nonInteractive: boolean): boolean {
  return isInteractive(io) && !nonInteractive
}

/** The `--yes` flag of a command that asks first (FD13-04, FD13-09; the same wording as `people remove`). */
export const yesFlag = {
  yes: { type: 'boolean', description: 'Do not ask first (for scripts)' },
} as const

/**
 * A destructive command asks first: on a terminal it prints `question [y/N]` and a no changes nothing (exit 1);
 * `--yes` skips the question; with no terminal and no `--yes` it refuses (exit 2) and never acts silently.
 */
export async function askFirst(
  io: CliIo,
  command: string,
  question: string,
  yes: boolean,
): Promise<void> {
  if (yes) return
  if (!isInteractive(io))
    throw new UsageError(`${command} asks first: run it in a terminal or pass --yes`)
  if (!(await confirm(question, { default: false, io }))) throw new CliError('nothing was changed')
}

export function budgetFlag(text: string): number | null {
  const parsed = parseUsdLimit(text)
  if (typeof parsed === 'string') throw new UsageError(`--budget must be ${parsed}`)
  return parsed
}

export const money = (n: number): string => String(Number(n.toFixed(4)))
