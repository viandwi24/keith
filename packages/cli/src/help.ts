import type { CliOptions, Command, FlagDef } from './command.ts'
import type { CliIo } from './io.ts'
import { style } from './output.ts'

function section(io: CliIo, title: string, rows: [string, string][]): string {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map(([left]) => left.length))
  const body = rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd()).join('\n')
  return `${style(io, 'bold', `${title}:`)}\n${body}\n\n`
}

function flagLeft(name: string, def: FlagDef): string {
  const short = def.short === undefined ? '    ' : `-${def.short}, `
  const value = def.type === 'string' ? ` <${def.placeholder ?? 'value'}>` : ''
  return `${short}--${name}${value}`
}

function flagRight(def: FlagDef): string {
  const shown = Array.isArray(def.default) ? def.default.join(',') : def.default
  const fallback =
    shown === undefined || shown === false || shown === '' ? '' : ` (default: ${shown})`
  return `${def.description}${fallback}`
}

/** `keith-core --help`: usage, commands with aligned summaries, global flags. */
export function renderProgramHelp(io: CliIo, options: CliOptions): string {
  const { program, version, summary, commands } = options
  const head =
    summary === undefined ? `${program} ${version}` : `${program} ${version} - ${summary}`
  return (
    `${style(io, 'bold', head)}\n\n` +
    section(io, 'Usage', [[`${program} <command> [flags]`, '']]) +
    section(
      io,
      'Commands',
      commands.map((c) => [c.name, c.summary]),
    ) +
    section(io, 'Flags', [
      ['-h, --help', 'Show help'],
      ['-V, --version', 'Show the version'],
    ]) +
    `Run '${program} <command> --help' for details.\n`
  )
}

/** `keith-core provider add --help`: usage, subcommands, flags with defaults, examples. */
export function renderCommandHelp(io: CliIo, program: string, path: string[], c: Command): string {
  const full = [program, ...path].join(' ')
  const hasFlags = Object.keys(c.flags ?? {}).length > 0
  const tail =
    c.usage ??
    [c.subcommands === undefined ? '' : '<command>', hasFlags ? '[flags]' : '']
      .filter((x) => x !== '')
      .join(' ')
  const flags: [string, string][] = Object.entries(c.flags ?? {}).map(([name, def]) => [
    flagLeft(name, def),
    flagRight(def),
  ])
  flags.push(['-h, --help', 'Show help'])
  return (
    `${c.summary}\n\n` +
    section(io, 'Usage', [[`${full}${tail === '' ? '' : ` ${tail}`}`, '']]) +
    section(
      io,
      'Commands',
      (c.subcommands ?? []).map((s) => [s.name, s.summary]),
    ) +
    section(io, 'Flags', flags) +
    (c.examples === undefined || c.examples.length === 0
      ? ''
      : `${style(io, 'bold', 'Examples:')}\n${c.examples.map((e) => `  ${e}`).join('\n')}\n`)
  )
}
