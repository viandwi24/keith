// Interactive questions for `keith setup`. Commands take a `Prompter` so tests can drive them
// with scripted answers (`scriptedPrompter`). The terminal implementation reads `process.stdin`
// itself: Bun's `prompt()` and `for await (const line of console)` can't hide a password, so one
// small raw-mode reader handles both plain and secret answers.

import { KeithError } from '@keith/sdk'

export interface Prompter {
  /** Asks for a line of text. An empty answer returns `fallback` when one is given. */
  ask(question: string, fallback?: string): Promise<string>
  /** Asks for a secret. Typed characters are not echoed. */
  secret(question: string): Promise<string>
  /** Releases stdin. */
  close(): void
}

/** A prompter that answers from a list, in order. Throws when the script runs out. */
export function scriptedPrompter(answers: string[], asked: string[] = []): Prompter {
  const queue = [...answers]
  const next = (question: string, fallback?: string): Promise<string> => {
    asked.push(question)
    const answer = queue.shift()
    if (answer === undefined) {
      return Promise.reject(new KeithError('INTERNAL', `no scripted answer for: ${question}`))
    }
    return Promise.resolve(answer === '' && fallback !== undefined ? fallback : answer)
  }
  return { ask: next, secret: (q) => next(q), close: () => {} }
}

type Stdin = typeof process.stdin
type Stdout = { write(text: string): unknown }

const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const BACKSPACE = ['\u007f', '\b']

/**
 * Reads answers from a terminal (raw mode, own echo) or from piped input (one line per answer).
 * Ctrl+C or end of input rejects with `KeithError('INTERNAL', 'setup cancelled')`.
 */
export function terminalPrompter(stdin: Stdin = process.stdin, stdout: Stdout = process.stdout): Prompter {
  const tty = stdin.isTTY === true
  let buffer = ''
  let ended = false
  let pending: { resolve: (line: string) => void; reject: (e: Error) => void; echo: boolean } | null = null

  const cancelled = () => new KeithError('INTERNAL', 'setup cancelled')

  const finishLine = () => {
    const newline = buffer.search(/\r\n|\r|\n/)
    if (newline < 0 || !pending) return
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1))
    const p = pending
    pending = null
    if (tty) stdout.write('\n')
    p.resolve(line)
  }

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (!tty) {
      buffer += text
      finishLine()
      return
    }
    for (const ch of text) {
      if (ch === CTRL_C || (ch === CTRL_D && buffer === '')) {
        const p = pending
        pending = null
        stdout.write('\n')
        p?.reject(cancelled())
        continue
      }
      if (BACKSPACE.includes(ch)) {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1)
          if (pending?.echo) stdout.write('\b \b')
        }
        continue
      }
      buffer += ch
      if (ch === '\r' || ch === '\n') finishLine()
      else if (pending?.echo) stdout.write(ch)
    }
  }

  const onEnd = () => {
    ended = true
    if (buffer !== '' && pending) {
      buffer += '\n'
      finishLine()
      return
    }
    const p = pending
    pending = null
    p?.reject(cancelled())
  }

  let listening = false
  const listen = () => {
    if (listening) return
    listening = true
    if (tty) stdin.setRawMode(true)
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.resume()
  }

  const read = (question: string, echo: boolean): Promise<string> => {
    listen()
    stdout.write(question)
    return new Promise<string>((resolve, reject) => {
      pending = { resolve, reject, echo }
      finishLine()
      if (pending && ended) onEnd()
    })
  }

  return {
    async ask(question, fallback) {
      const label = fallback === undefined || fallback === '' ? question : `${question} [${fallback}]`
      const answer = (await read(`${label}: `, true)).trim()
      return answer === '' && fallback !== undefined ? fallback : answer
    },
    secret(question) {
      return read(`${question}: `, !tty)
    },
    close() {
      if (!listening) return
      listening = false
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      if (tty) stdin.setRawMode(false)
      stdin.pause()
    },
  }
}
