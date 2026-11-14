/**
 * The cap of a driver call's progress output (docs/specs/node-drivers.md, "Progress caps"). A driver calls `progress(chunk)` as
 * often as it likes; the node forwards what fits and never waits: the caps only decide what is sent, the call is never blocked.
 *
 * Three caps, per call:
 * - bytes: 64 KiB of UTF-8 in all;
 * - line: 4 KiB per line (a longer line keeps its first 4 KiB, the rest of that line is dropped);
 * - rate: 100 chunks in any one second.
 *
 * The first time a cap is hit, one marker line `[progress truncated]` is sent and the call's progress is closed: nothing more
 * is forwarded for it, whatever the caps say after. The final result of the call is not affected (it has its own cap, `OUTPUT_CAP`).
 */
export const PROGRESS_BYTES_CAP = 64 * 1024
export const PROGRESS_LINE_CAP = 4 * 1024
export const PROGRESS_CHUNKS_PER_SECOND = 100
export const PROGRESS_MARKER = '[progress truncated]'

export type ProgressStream = 'stdout' | 'stderr'

export interface ProgressCapOptions {
  /** Sends one progress chunk to the core (the node's `emit`). Called synchronously; it must not throw. */
  send(chunk: string, stream: ProgressStream): void
  /** The clock of the rate cap in milliseconds. Default `Date.now`. */
  now?: () => number
  bytesCap?: number
  lineCap?: number
  chunksPerSecond?: number
}

export interface ProgressCap {
  /** Forwards what the caps allow of one chunk; a closed call forwards nothing. */
  push(chunk: string, stream?: ProgressStream): void
  /** True once a cap was hit: the marker went out and nothing else will. */
  readonly closed: boolean
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

export function createProgressCap(options: ProgressCapOptions): ProgressCap {
  const now = options.now ?? Date.now
  const bytesCap = options.bytesCap ?? PROGRESS_BYTES_CAP
  const lineCap = options.lineCap ?? PROGRESS_LINE_CAP
  const perSecond = options.chunksPerSecond ?? PROGRESS_CHUNKS_PER_SECOND
  let sentBytes = 0
  // characters of the current line already sent (a line continues across chunks until its newline)
  let lineChars = 0
  let windowStart = -Infinity
  let windowChunks = 0
  let closed = false

  const close = (stream: ProgressStream): void => {
    closed = true
    options.send(`${PROGRESS_MARKER}\n`, stream)
  }

  return {
    get closed() {
      return closed
    },
    push(chunk, stream = 'stdout') {
      if (closed || chunk === '') return
      const at = now()
      if (at - windowStart >= 1000) {
        windowStart = at
        windowChunks = 0
      }
      windowChunks += 1
      if (windowChunks > perSecond) return close(stream)

      // the line cap: keep at most `lineCap` characters of each line, drop the rest of a long line
      let kept = ''
      for (const char of chunk) {
        if (char === '\n') {
          kept += char
          lineChars = 0
          continue
        }
        if (lineChars >= lineCap) continue
        kept += char
        lineChars += 1
      }
      if (kept === '') return

      const bytes = utf8Bytes(kept)
      if (sentBytes + bytes > bytesCap) {
        // send what still fits as whole characters, then close: the byte cap is exact
        let fitting = ''
        let used = sentBytes
        for (const char of kept) {
          const size = utf8Bytes(char)
          if (used + size > bytesCap) break
          fitting += char
          used += size
        }
        if (fitting !== '') {
          sentBytes = used
          options.send(fitting, stream)
        }
        return close(stream)
      }
      sentBytes += bytes
      options.send(kept, stream)
    },
  }
}
