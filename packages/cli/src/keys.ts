import { PromptCancelled, UsageError } from './errors.ts'
import { type CliInput, type CliIo, isInteractive } from './io.ts'

export type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'backspace'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-u'
  | 'escape'
  | 'char'

export interface Key {
  name: KeyName
  ch: string
}

const ARROWS: Record<string, KeyName> = { A: 'up', B: 'down', C: 'right', D: 'left' }

/** Split a raw-mode chunk into keys (CSI sequences, Enter, control keys, text). */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk.charAt(i)
    if (c === '\u001b') {
      const next = chunk.charAt(i + 1)
      if (next === '[' || next === 'O') {
        let j = i + 2
        while (j < chunk.length && chunk.charCodeAt(j) < 0x40) j++
        const name = ARROWS[chunk.charAt(j)]
        if (name !== undefined) keys.push({ name, ch: '' })
        i = j
      } else keys.push({ name: 'escape', ch: '' })
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && chunk.charAt(i + 1) === '\n') i++
      keys.push({ name: 'enter', ch: '' })
    } else if (c === '\u007f' || c === '\b') keys.push({ name: 'backspace', ch: '' })
    else if (c === '\u0003') keys.push({ name: 'ctrl-c', ch: '' })
    else if (c === '\u0004') keys.push({ name: 'ctrl-d', ch: '' })
    else if (c === '\u0015') keys.push({ name: 'ctrl-u', ch: '' })
    else if (c >= ' ') keys.push({ name: 'char', ch: c })
  }
  return keys
}

const decode = (chunk: string | Uint8Array): string =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')

/** Raw mode needs an interactive terminal whose stream can switch modes. */
export function canRaw(io: CliIo): boolean {
  return isInteractive(io) && typeof io.stdin.setRawMode === 'function'
}

/**
 * Raw-mode session: `onKey` returns a value to finish, `undefined` to keep reading. Ctrl+C always
 * restores the terminal (raw mode off, cursor shown) and rejects with `PromptCancelled`.
 */
export function rawSession<T>(io: CliIo, onKey: (key: Key) => T | undefined): Promise<T> {
  const { stdin, stdout } = io
  return new Promise<T>((resolve, reject) => {
    const restore = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
      stdout.write('\u001b[?25h')
    }
    const onData = (chunk: string | Uint8Array): void => {
      for (const key of parseKeys(decode(chunk))) {
        if (key.name === 'ctrl-c') {
          restore()
          stdout.write('\n')
          reject(new PromptCancelled())
          return
        }
        const done = onKey(key)
        if (done !== undefined) {
          restore()
          resolve(done)
          return
        }
      }
    }
    stdin.setRawMode?.(true)
    stdin.setEncoding?.('utf8')
    stdin.on('data', onData)
    stdin.resume()
  })
}

/** One line typed in raw mode; characters are echoed unless `echo` is false. */
export function readRawLine(io: CliIo, echo: boolean): Promise<string> {
  let value = ''
  return rawSession(io, (key) => {
    if (key.name === 'enter' || key.name === 'ctrl-d') {
      io.stdout.write('\n')
      return value
    }
    if (key.name === 'backspace') {
      if (value !== '') {
        value = value.slice(0, -1)
        if (echo) io.stdout.write('\b \b')
      }
    } else if (key.name === 'ctrl-u') {
      if (echo && value !== '') io.stdout.write(`\u001b[${value.length}D\u001b[K`)
      value = ''
    } else if (key.name === 'char') {
      value += key.ch
      if (echo) io.stdout.write(key.ch)
    }
    return undefined
  })
}

interface LineState {
  buf: string
  ended: boolean
}
const lineStates = new WeakMap<object, LineState>()

/**
 * Next line from a piped stdin, or null at end of input. Input read past the line stays buffered,
 * so several prompts can share one pipe.
 */
export function readLine(stdin: CliInput): Promise<string | null> {
  let st = lineStates.get(stdin)
  if (st === undefined) {
    st = { buf: '', ended: false }
    lineStates.set(stdin, st)
  }
  const state = st
  if ((stdin as { readableEnded?: boolean }).readableEnded === true) state.ended = true
  const take = (): string | null | undefined => {
    const i = state.buf.indexOf('\n')
    if (i !== -1) {
      const line = state.buf.slice(0, i).replace(/\r$/, '')
      state.buf = state.buf.slice(i + 1)
      return line
    }
    if (!state.ended) return undefined
    const rest = state.buf
    state.buf = ''
    return rest === '' ? null : rest
  }
  const ready = take()
  if (ready !== undefined) return Promise.resolve(ready)
  return new Promise((resolve) => {
    const cleanup = (): void => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('close', onEnd)
      stdin.pause()
    }
    const onData = (chunk: string | Uint8Array): void => {
      state.buf += decode(chunk)
      const line = take()
      if (line !== undefined) {
        cleanup()
        resolve(line)
      }
    }
    const onEnd = (): void => {
      state.ended = true
      const line = take()
      cleanup()
      resolve(line ?? null)
    }
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.on('close', onEnd)
    stdin.resume()
  })
}

/** A line from piped input; end of input is a usage error naming the question. */
export async function requireLine(io: CliIo, question: string): Promise<string> {
  const line = await readLine(io.stdin)
  if (line === null) throw new UsageError(`no input available for "${question}"`)
  return line
}
