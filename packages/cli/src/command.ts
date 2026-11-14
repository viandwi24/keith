import { parseArgs } from 'node:util'
import { CliError, PromptCancelled, UsageError } from './errors.ts'
import { renderCommandHelp, renderProgramHelp } from './help.ts'
import { type CliIo, errOut } from './io.ts'

export interface FlagDef {
  type: 'string' | 'boolean'
  short?: string
  multiple?: boolean
  default?: string | boolean | string[]
  /** One line shown in `--help`. */
  description: string
  /** Value name in help, e.g. `url` renders `--core <url>`. */
  placeholder?: string
}

export type FlagValue = string | boolean | (string | boolean)[] | undefined

export interface CommandContext {
  /** Parsed flags (defaults applied). */
  values: Record<string, FlagValue>
  positionals: string[]
  io: CliIo
  program: string
  /** Command path, e.g. `['provider', 'add']`. */
  path: string[]
  /** String flag or `undefined`. */
  string(name: string): string | undefined
  /** Boolean flag (false when absent). */
  bool(name: string): boolean
  /** String flag that must be present, else a `UsageError` naming it. */
  require(name: string): string
}

export interface Command {
  name: string
  summary: string
  /** Replaces the generated argument part of the usage line, e.g. `<code> [--label <text>]`. */
  usage?: string
  flags?: Record<string, FlagDef>
  /** Accept positional arguments (shown in usage via `usage`). */
  positionals?: boolean
  examples?: string[]
  /** Nested commands (one level, e.g. `provider add`). */
  subcommands?: Command[]
  /** Returns an exit code; `void` means 0. */
  run?: (ctx: CommandContext) => number | undefined | Promise<number | undefined>
}

export function defineCommand(command: Command): Command {
  return command
}

export interface CliOptions {
  program: string
  version: string
  summary?: string
  commands: Command[]
  /** Command name run when argv is empty or starts with a flag (e.g. the TUI's chat). */
  defaultCommand?: string
  argv: string[]
  io: CliIo
}

/** Edit distance between two short words. */
export function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    prev = row
  }
  return prev[b.length] ?? 0
}

function suggest(word: string, names: string[]): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const name of names) {
    const score = name.startsWith(word) ? 1 : distance(word, name)
    if (score < bestScore) {
      best = name
      bestScore = score
    }
  }
  return bestScore <= 2 ? best : undefined
}

function unknown(shown: string, word: string, names: string[], path: string[]): UsageError {
  const hint = suggest(word, names)
  return new UsageError(
    `unknown command ${shown}.${hint === undefined ? '' : ` Did you mean ${[...path, hint].join(' ')}?`}`,
    path,
  )
}

function parseFlags(
  command: Command,
  args: string[],
): { values: Record<string, FlagValue>; positionals: string[] } {
  const options: Record<
    string,
    {
      type: 'string' | 'boolean'
      short?: string
      multiple?: boolean
      default?: string | boolean | string[]
    }
  > = {
    help: { type: 'boolean', short: 'h' },
  }
  for (const [name, def] of Object.entries(command.flags ?? {})) {
    options[name] = {
      type: def.type,
      ...(def.short === undefined ? {} : { short: def.short }),
      ...(def.multiple === undefined ? {} : { multiple: def.multiple }),
      ...(def.default === undefined ? {} : { default: def.default }),
    }
  }
  try {
    const { values, positionals } = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: command.positionals === true,
    })
    return { values: values as Record<string, FlagValue>, positionals }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new UsageError(message.split('. To specify')[0] ?? message)
  }
}

function makeContext(
  values: Record<string, FlagValue>,
  positionals: string[],
  io: CliIo,
  program: string,
  path: string[],
): CommandContext {
  const string = (name: string): string | undefined => {
    const v = values[name]
    return typeof v === 'string' ? v : undefined
  }
  return {
    values,
    positionals,
    io,
    program,
    path,
    string,
    bool: (name) => values[name] === true,
    require: (name) => {
      const v = string(name)
      if (v === undefined || v === '') throw new UsageError(`missing --${name}`)
      return v
    },
  }
}

interface Resolved {
  command: Command
  path: string[]
  rest: string[]
}

function resolve(commands: Command[], argv: string[]): Resolved {
  const [head, ...afterHead] = argv
  const top = commands.find((c) => c.name === head)
  if (head === undefined || top === undefined) {
    throw unknown(
      head ?? '',
      head ?? '',
      commands.map((c) => c.name),
      [],
    )
  }
  const [sub, ...afterSub] = afterHead
  const nested = top.subcommands
  if (nested !== undefined && sub !== undefined && !sub.startsWith('-')) {
    const child = nested.find((c) => c.name === sub)
    if (child === undefined)
      throw unknown(
        `${top.name} ${sub}`,
        sub,
        nested.map((c) => c.name),
        [top.name],
      )
    return { command: child, path: [top.name, child.name], rest: afterSub }
  }
  return { command: top, path: [top.name], rest: afterHead }
}

/** Route, parse and run; returns the process exit code (0 ok, 1 runtime, 2 usage, 130 cancelled). */
export async function runCli(options: CliOptions): Promise<number> {
  const { program, version, commands, io } = options
  const err = errOut(io)
  let path: string[] = []
  let argv = options.argv
  try {
    const first = argv[0]
    if (first === '--version' || first === '-V') {
      io.stdout.write(`${program} ${version}\n`)
      return 0
    }
    if (first === 'help' || first === '--help' || first === '-h') {
      const target = argv.slice(1)
      if (target.length > 0 && first === 'help') argv = [...target, '--help']
      else {
        io.stdout.write(renderProgramHelp(io, options))
        return 0
      }
    }
    if (
      (argv[0] === undefined || argv[0].startsWith('-')) &&
      options.defaultCommand !== undefined &&
      argv[0] !== '--help' &&
      argv[0] !== '-h'
    ) {
      argv = [options.defaultCommand, ...argv]
    }
    if (argv.length === 0) {
      io.stdout.write(renderProgramHelp(io, options))
      return 0
    }
    const resolved = resolve(commands, argv)
    path = resolved.path
    const { command } = resolved
    if (resolved.rest.includes('--help') || resolved.rest.includes('-h')) {
      io.stdout.write(renderCommandHelp(io, program, path, command))
      return 0
    }
    if (command.run === undefined) {
      io.stdout.write(renderCommandHelp(io, program, path, command))
      return 0
    }
    const { values, positionals } = parseFlags(command, resolved.rest)
    const code = await command.run(makeContext(values, positionals, io, program, path))
    return code ?? 0
  } catch (error) {
    if (error instanceof PromptCancelled) {
      err.write('\n')
      return 130
    }
    if (error instanceof UsageError) {
      const where = [program, ...(error.path ?? path)].join(' ')
      err.write(`${program}: ${error.message}\nTry '${where} --help'.\n`)
      return 2
    }
    if (error instanceof CliError) {
      err.write(`${program}: ${error.message}\n`)
      return error.exitCode
    }
    const message = error instanceof Error ? error.message : String(error)
    err.write(`${program}: ${message.split('\n')[0]}\n`)
    return 1
  }
}
