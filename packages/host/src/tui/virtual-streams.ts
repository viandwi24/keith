import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

/**
 * The stdout of a view: what Ink writes is captured, never printed. It looks like a TTY of a fixed size and
 * emits `resize` when the size changes (docs/specs/plugin-views.md, "Spike findings").
 */
export class VirtualStdout extends EventEmitter {
  readonly isTTY = true
  columns: number
  rows: number
  /** Called with every chunk Ink writes (in `debug` mode: one whole frame per write). */
  onWrite: ((chunk: string) => void) | undefined

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }

  write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    this.onWrite?.(text)
    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') queueMicrotask(() => done())
    return true
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }

  /** Drop the sink and every listener: nothing of the view stays reachable from here. */
  dispose(): void {
    this.onWrite = undefined
    this.removeAllListeners()
  }
}

/**
 * The stdin of a view: bytes the client sent are pushed in, Ink reads them. It claims to be a TTY with
 * `setRawMode` so `useInput` works, but there is no terminal behind it.
 */
export class VirtualStdin extends Readable {
  readonly isTTY = true
  rawMode = false
  /**
   * Called with an error a view's input handler threw. Ink runs `useInput` callbacks inside a `readable` listener,
   * where a throw would be an uncaught exception of the whole core: the listeners are wrapped so it comes here.
   */
  onError: ((error: unknown) => void) | undefined
  private readonly wrapped = new Map<(...args: never[]) => void, (...args: unknown[]) => void>()

  constructor() {
    super({ encoding: 'utf8' })
  }

  override _read(): void {}

  override on(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.on(event, this.guarded(event, listener) as never)
  }

  override addListener(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.addListener(event, this.guarded(event, listener) as never)
  }

  override removeListener(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.removeListener(event, (this.wrapped.get(listener) ?? listener) as never)
  }

  override off(event: string | symbol, listener: (...args: never[]) => void): this {
    return this.removeListener(event, listener)
  }

  private guarded(
    event: string | symbol,
    listener: (...args: never[]) => void,
  ): (...args: never[]) => void {
    if (event !== 'readable') return listener
    const wrapper = (...args: unknown[]): void => {
      try {
        ;(listener as (...a: unknown[]) => void)(...args)
      } catch (error) {
        this.onError?.(error)
      }
    }
    this.wrapped.set(listener, wrapper)
    return wrapper as never
  }

  setRawMode(enabled: boolean): this {
    this.rawMode = enabled
    return this
  }

  ref(): this {
    return this
  }

  unref(): this {
    return this
  }

  /** Terminal input bytes from the client. */
  feed(data: string): void {
    if (!this.destroyed) this.push(data)
  }

  dispose(): void {
    this.onError = undefined
    this.wrapped.clear()
    this.destroy()
    this.removeAllListeners()
  }
}
