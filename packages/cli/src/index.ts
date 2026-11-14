/** Shared CLI toolkit for `keith-core`, `keith-node` and `keith`: prompts, commands, output. */

export type {
  CliOptions,
  Command,
  CommandContext,
  FlagDef,
  FlagValue,
} from './command.ts'
export { defineCommand, runCli } from './command.ts'
export { CliError, PromptCancelled, UsageError } from './errors.ts'
export type { CliInput, CliIo, CliOutput } from './io.ts'
export { isInteractive, processIo } from './io.ts'
export type { StyleName } from './output.ts'
export { colorEnabled, printNextSteps, printTable, style } from './output.ts'
export type { AskOptions, Choice, SecretOptions, SelectOptions } from './prompts.ts'
export { ask, askHidden, confirm, select } from './prompts.ts'
export { stripControl } from './sanitize.ts'
