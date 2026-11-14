import { PassThrough } from 'node:stream'
import type { CliIo } from '../io.ts'

export interface FakeIo extends CliIo {
  stdin: PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
  /** Everything written to stdout so far. */
  out(): string
  err(): string
  /** setRawMode calls in order. */
  rawCalls: boolean[]
  send(text: string): void
  end(): void
}

/** In-memory io. `tty: true` makes it interactive with a raw-mode capable stdin. */
export function fakeIo(options: { tty?: boolean; env?: Record<string, string> } = {}): FakeIo {
  const stdin = new PassThrough() as FakeIo['stdin']
  const rawCalls: boolean[] = []
  let out = ''
  let err = ''
  if (options.tty === true) {
    stdin.isTTY = true
    stdin.setRawMode = (mode) => {
      rawCalls.push(mode)
    }
  }
  return {
    stdin,
    stdout: {
      isTTY: options.tty === true,
      write: (t) => {
        out += t
      },
    },
    stderr: {
      write: (t) => {
        err += t
      },
    },
    env: options.env ?? {},
    out: () => out,
    err: () => err,
    rawCalls,
    send: (text) => {
      stdin.write(text)
    },
    end: () => {
      stdin.end()
    },
  }
}
