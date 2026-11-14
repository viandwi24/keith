import { type CliIo, isInteractive, processIo } from './io.ts'
import { canRaw, rawSession, readRawLine, requireLine } from './keys.ts'
import { style } from './output.ts'

export interface AskOptions {
  /** Terminal streams; default the real process. */
  io?: CliIo
  default?: string
  /** Return an error message to ask again, or `undefined` when the value is fine. */
  validate?: (value: string) => string | undefined
}

export interface SecretOptions {
  io?: CliIo
  validate?: (value: string) => string | undefined
}

export interface Choice<T extends string = string> {
  value: T
  label: string
  hint?: string
}

export interface SelectOptions<T extends string = string> {
  io?: CliIo
  default?: T
}

/** Visible input. Enter accepts the default shown in brackets; `validate` re-asks. */
export async function ask(question: string, options: AskOptions = {}): Promise<string> {
  const io = options.io ?? processIo()
  const suffix = options.default === undefined ? '' : ` ${style(io, 'dim', `[${options.default}]`)}`
  for (;;) {
    io.stdout.write(`${question}${suffix}: `)
    const typed = canRaw(io) ? await readRawLine(io, true) : await requireLine(io, question)
    const value =
      typed.trim() === '' && options.default !== undefined ? options.default : typed.trim()
    const problem = options.validate?.(value)
    if (problem === undefined) return value
    io.stdout.write(`${style(io, 'red', problem)}\n`)
  }
}

/**
 * Hidden input: nothing is echoed in a terminal. With piped stdin it reads one line, for
 * `--api-key-stdin` style use.
 */
export async function askHidden(question: string, options: SecretOptions = {}): Promise<string> {
  const io = options.io ?? processIo()
  for (;;) {
    if (isInteractive(io)) io.stdout.write(`${question} ${style(io, 'dim', '(hidden)')}: `)
    const typed = canRaw(io) ? await readRawLine(io, false) : await requireLine(io, question)
    // a secret is never trimmed; only the line ending of piped input goes
    const value = typed.replace(/\r?\n$/, '')
    const problem = options.validate?.(value)
    if (problem === undefined) return value
    io.stdout.write(`${style(io, 'red', problem)}\n`)
  }
}

/** Pick one value: arrow keys and Enter in a terminal, a numbered list otherwise. */
export async function select<T extends string>(
  question: string,
  choices: Choice<T>[],
  options: SelectOptions<T> = {},
): Promise<T> {
  const io = options.io ?? processIo()
  if (choices.length === 0) throw new Error('select needs at least one choice')
  const start = Math.max(
    0,
    choices.findIndex((c) => c.value === options.default),
  )
  return canRaw(io)
    ? selectRaw(question, choices, start, io)
    : selectNumbered(question, choices, start, io)
}

const line = (io: CliIo, c: Choice, active: boolean): string => {
  const hint = c.hint === undefined ? '' : ` ${style(io, 'dim', c.hint)}`
  return active ? `${style(io, 'bold', `> ${c.label}`)}${hint}` : `  ${c.label}${hint}`
}

async function selectRaw<T extends string>(
  question: string,
  choices: Choice<T>[],
  start: number,
  io: CliIo,
): Promise<T> {
  let index = start
  const n = choices.length
  const draw = (): void => {
    io.stdout.write(choices.map((c, i) => `${line(io, c, i === index)}\n`).join(''))
  }
  const erase = (): void => {
    io.stdout.write(`\u001b[${n}A\r\u001b[J`)
  }
  io.stdout.write(`${question}\n\u001b[?25l`)
  draw()
  const picked = await rawSession<number>(io, (key) => {
    if (key.name === 'up') index = (index - 1 + n) % n
    else if (key.name === 'down') index = (index + 1) % n
    else if (key.name === 'enter') return index
    else return undefined
    erase()
    draw()
    return undefined
  })
  erase()
  const chosen = choices[picked] as Choice<T>
  io.stdout.write(`  ${chosen.label}\n`)
  return chosen.value
}

async function selectNumbered<T extends string>(
  question: string,
  choices: Choice<T>[],
  start: number,
  io: CliIo,
): Promise<T> {
  io.stdout.write(`${question}\n`)
  choices.forEach((c, i) => {
    const hint = c.hint === undefined ? '' : ` (${c.hint})`
    io.stdout.write(`  ${i + 1}. ${c.label}${hint}\n`)
  })
  for (;;) {
    io.stdout.write(`Type 1-${choices.length} [${start + 1}]: `)
    const typed = (await requireLine(io, question)).trim()
    if (typed === '') return (choices[start] as Choice<T>).value
    const byNumber = /^\d+$/.test(typed) ? choices[Number(typed) - 1] : undefined
    const picked = byNumber ?? choices.find((c) => c.value === typed)
    if (picked !== undefined) return picked.value
    io.stdout.write(`${style(io, 'red', `Enter a number from 1 to ${choices.length}.`)}\n`)
  }
}

/** Yes or no. Enter takes the default. */
export async function confirm(
  question: string,
  options: { default: boolean; io?: CliIo },
): Promise<boolean> {
  const io = options.io ?? processIo()
  const hint = options.default ? 'Y/n' : 'y/N'
  const text = `${question} ${style(io, 'dim', `[${hint}]`)} `
  if (canRaw(io)) {
    io.stdout.write(text)
    const answer = await rawSession<boolean>(io, (key) => {
      if (key.name === 'enter') return options.default
      if (key.name !== 'char') return undefined
      const c = key.ch.toLowerCase()
      return c === 'y' ? true : c === 'n' ? false : undefined
    })
    io.stdout.write(`${answer ? 'yes' : 'no'}\n`)
    return answer
  }
  for (;;) {
    io.stdout.write(text)
    const typed = (await requireLine(io, question)).trim().toLowerCase()
    if (typed === '') return options.default
    if (typed === 'y' || typed === 'yes') return true
    if (typed === 'n' || typed === 'no') return false
    io.stdout.write(`${style(io, 'red', 'Answer y or n.')}\n`)
  }
}
