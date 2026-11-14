// The shape of one terminal cell, so the orb is round on every font. Terminals that implement the
// xterm window ops answer `ESC[16t` with the cell size and `ESC[14t` with the window size, in pixels.

/** A typical macOS font (Menlo, SF Mono at 13 to 14 pt): cells about 0.46 as wide as tall. */
export const DEFAULT_CELL_ASPECT = 0.46
/** What a detected value may be (a wrong answer must not squash the orb). */
export const DETECT_MIN = 0.3
export const DETECT_MAX = 0.8
/** What the manual `[` `]` keys may reach. */
export const MANUAL_MIN = 0.25
export const MANUAL_MAX = 0.8
export const MANUAL_STEP = 0.02
export const DETECT_TIMEOUT_MS = 150

export interface SizeReply {
  /** `cell`: one cell (`ESC[6;h;wt`); `window`: the whole window (`ESC[4;h;wt`). Pixels. */
  kind: 'cell' | 'window'
  height: number
  width: number
}

const ESC = String.fromCharCode(27)
const REPLY = new RegExp(`${ESC}\\[([46]);(\\d+);(\\d+)t`, 'g')

/** Every complete size reply in `data` (other bytes, garbage and half replies are skipped). */
export function parseReplies(data: string): SizeReply[] {
  const out: SizeReply[] = []
  for (const m of data.matchAll(REPLY)) {
    const height = Number(m[2])
    const width = Number(m[3])
    if (height > 0 && width > 0) out.push({ kind: m[1] === '6' ? 'cell' : 'window', height, width })
  }
  return out
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const round2 = (v: number): number => Math.round(v * 100) / 100

/** Cell width over cell height from the replies: the cell size first, else the window over rows and columns. */
export function aspectOfReplies(
  replies: readonly SizeReply[],
  rows: number,
  columns: number,
): number | undefined {
  const cell = replies.find((r) => r.kind === 'cell')
  if (cell !== undefined) return round2(clamp(cell.width / cell.height, DETECT_MIN, DETECT_MAX))
  const win = replies.find((r) => r.kind === 'window')
  if (win !== undefined && rows > 0 && columns > 0) {
    return round2(clamp(win.width / columns / (win.height / rows), DETECT_MIN, DETECT_MAX))
  }
  return undefined
}

/** One manual step (`[` is -1, `]` is +1) inside the manual range. */
export function stepAspect(aspect: number, direction: -1 | 1): number {
  return round2(clamp(aspect + direction * MANUAL_STEP, MANUAL_MIN, MANUAL_MAX))
}

export interface CellStreams {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
}

/**
 * Ask the terminal once, before Ink reads stdin. Both queries go out together and the first cell
 * reply wins; after `timeoutMs` the window reply is used, else `undefined`. Skipped (no bytes
 * written) unless both streams are TTYs. The raw-mode state is put back exactly; every byte that
 * arrives meanwhile is consumed here, so none reaches Ink as a key.
 */
export async function detectCellAspect(
  { stdin, stdout }: CellStreams = process,
  timeoutMs = DETECT_TIMEOUT_MS,
): Promise<number | undefined> {
  if (!stdin.isTTY || !stdout.isTTY) return undefined
  const wasRaw = stdin.isRaw
  const wasPaused = stdin.isPaused()
  if (!wasRaw) stdin.setRawMode(true)
  stdin.resume()
  let seen = ''
  const settled = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      stdin.off('data', onData)
      resolve()
    }
    const onData = (chunk: Buffer | string) => {
      seen += chunk.toString('latin1')
      if (parseReplies(seen).some((r) => r.kind === 'cell')) finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    stdin.on('data', onData)
  })
  stdout.write(`${ESC}[16t${ESC}[14t`)
  await settled
  if (!wasRaw) stdin.setRawMode(false)
  if (wasPaused) stdin.pause()
  return aspectOfReplies(parseReplies(seen), stdout.rows ?? 0, stdout.columns ?? 0)
}
