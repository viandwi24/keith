import type { CliIo } from './io.ts'
import { stripControl } from './sanitize.ts'

export type StyleName = 'bold' | 'dim' | 'red' | 'green' | 'yellow'

const CODES: Record<StyleName, [string, string]> = {
  bold: ['\u001b[1m', '\u001b[22m'],
  dim: ['\u001b[2m', '\u001b[22m'],
  red: ['\u001b[31m', '\u001b[39m'],
  green: ['\u001b[32m', '\u001b[39m'],
  yellow: ['\u001b[33m', '\u001b[39m'],
}

/** Colour is on only for a terminal stdout and when `NO_COLOR` is unset or empty. */
export function colorEnabled(io: CliIo): boolean {
  const noColor = (io.env ?? process.env).NO_COLOR
  if (noColor !== undefined && noColor !== '') return false
  return io.stdout.isTTY === true
}

/** Wrap text in a style; returns it unchanged when colour is off. */
export function style(io: CliIo, name: StyleName, text: string): string {
  if (!colorEnabled(io)) return text
  const [open, close] = CODES[name]
  return `${open}${text}${close}`
}

/** "Next steps" block: a numbered list of commands or actions. */
export function printNextSteps(io: CliIo, steps: string[]): void {
  if (steps.length === 0) return
  io.stdout.write(`\n${style(io, 'bold', 'Next steps')}\n`)
  steps.forEach((step, i) => {
    io.stdout.write(`  ${i + 1}. ${step}\n`)
  })
}

/** Aligned columns, two spaces apart. Pass `header` for a bold first row. */
export function printTable(io: CliIo, rows: string[][], options: { header?: string[] } = {}): void {
  const clean = (r: string[]): string[] => r.map((cell) => stripControl(cell))
  const all =
    options.header === undefined ? rows.map(clean) : [clean(options.header), ...rows.map(clean)]
  const widths: number[] = []
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  all.forEach((row, r) => {
    const line = row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
    io.stdout.write(`${options.header !== undefined && r === 0 ? style(io, 'bold', line) : line}\n`)
  })
}
