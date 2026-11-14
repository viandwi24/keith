import { PassThrough } from 'node:stream'
import type { CliIo } from '@keith/cli'

export interface TestIo extends CliIo {
  out(): string
  err(): string
  /** Pipe lines to stdin (answers, `--api-key-stdin`). */
  send(text: string): void
  end(): void
}

/** In-memory io without a terminal (headless), for the `keith-core` command tests. */
export function testIo(): TestIo {
  const stdin = new PassThrough()
  let out = ''
  let err = ''
  return {
    stdin,
    stdout: {
      write: (t) => {
        out += t
      },
    },
    stderr: {
      write: (t) => {
        err += t
      },
    },
    env: {},
    isTTY: false,
    out: () => out,
    err: () => err,
    send: (text) => void stdin.write(text),
    end: () => void stdin.end(),
  }
}
