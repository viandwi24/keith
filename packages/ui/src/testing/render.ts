import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import type { ReactElement } from 'react'

/**
 * `ink-testing-library`'s `render` with a terminal size you choose (the library fixes 100 columns
 * and gives no rows, which would break the full-screen layout at any other size).
 */
class Stdout extends EventEmitter {
  frames: string[] = []
  private last: string | undefined
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super()
  }
  write = (frame: string): void => {
    this.frames.push(frame)
    this.last = frame
  }
  lastFrame = (): string | undefined => this.last
}

class Stderr extends EventEmitter {
  write = (): void => {}
}

class Stdin extends EventEmitter {
  isTTY = true
  data: string | null = null
  write = (data: string): void => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
}

export interface Rendered {
  stdin: Stdin
  stdout: Stdout
  lastFrame(): string | undefined
  frames: string[]
  unmount(): void
  rerender(tree: ReactElement): void
}

const instances: Array<{ unmount(): void; cleanup(): void }> = []

export function render(
  tree: ReactElement,
  { columns = 100, rows = 30 }: { columns?: number; rows?: number } = {},
): Rendered {
  const stdout = new Stdout(columns, rows)
  const stdin = new Stdin()
  const instance = inkRender(tree, {
    stdout: stdout as never,
    stderr: new Stderr() as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.push(instance)
  return {
    stdin,
    stdout,
    lastFrame: stdout.lastFrame,
    frames: stdout.frames,
    unmount: instance.unmount,
    rerender: instance.rerender,
  }
}

/** Unmount every tree this helper rendered. */
export function cleanup(): void {
  for (const instance of instances.splice(0)) {
    instance.unmount()
    instance.cleanup()
  }
}
