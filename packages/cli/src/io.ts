import type { EventEmitter } from 'node:events'

/** The slice of a readable stream the CLI needs; `process.stdin` and a test double both fit. */
export interface CliInput extends Pick<EventEmitter, 'on' | 'off'> {
  isTTY?: boolean | undefined
  setRawMode?: ((mode: boolean) => unknown) | undefined
  setEncoding?: ((encoding: BufferEncoding) => unknown) | undefined
  resume(): unknown
  pause(): unknown
}

/** The slice of a writable stream the CLI needs. */
export interface CliOutput {
  isTTY?: boolean | undefined
  write(text: string): unknown
}

export interface CliIo {
  stdin: CliInput
  stdout: CliOutput
  /** Errors and usage messages; falls back to `stdout`. */
  stderr?: CliOutput
  /** Forces the interactive decision; default: stdin and stdout are both TTYs. */
  isTTY?: boolean
  /** Environment for `NO_COLOR`; default `process.env`. */
  env?: Record<string, string | undefined>
}

/** The real process streams. */
export function processIo(): CliIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }
}

/** True when a person can answer prompts: stdin and stdout are terminals. */
export function isInteractive(io: CliIo): boolean {
  return io.isTTY ?? (io.stdin.isTTY === true && io.stdout.isTTY === true)
}

export function errOut(io: CliIo): CliOutput {
  return io.stderr ?? io.stdout
}
