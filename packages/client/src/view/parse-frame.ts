import { VIEW_LIMITS } from '@keith/contracts'

/**
 * The sanitiser of plugin view frames (docs/specs/plugin-views.md, "Sanitiser rules"). A frame is untrusted terminal
 * output: this turns it into styled text runs with a strict allow-list (printable text, newline, tab, SGR) and drops
 * everything else. Its output is never written to a terminal as bytes: a UI draws the runs with its own `Text`, so an
 * escape cannot reach the user's terminal by construction. Pure, no I/O, no Bun or Node API (it also runs in a browser).
 */

/** One stretch of text in one style. Flags are present only when set. */
export interface ViewRun {
  text: string
  /** A colour a UI passes to `Text`: `#rrggbb`, `ansi256(n)` or a named colour (`red`, `redBright`, ...). */
  fg?: string
  bg?: string
  bold?: true
  dim?: true
  italic?: true
  underline?: true
  inverse?: true
  strike?: true
}

export type ViewLine = ViewRun[]

export interface ParsedFrame {
  lines: ViewLine[]
  /** Lines beyond `rows`, a line beyond `cols` or input beyond the size cap were cut. */
  truncated: boolean
}

export interface ParseOptions {
  /** Cut each line at this many cells (default and ceiling: the 400 of the protocol). */
  cols?: number
  /** Keep this many lines (default and ceiling: the 200 of the protocol). */
  rows?: number
  /** Quantize colours to the client's depth: 24 keeps truecolor, 8 uses ansi256, 4 the 16 named colours, 1 none (default 24). */
  colorDepth?: 1 | 4 | 8 | 24
}

/** Input beyond this many characters is ignored (the protocol caps a frame at 256 KiB of bytes). */
export const PARSE_INPUT_MAX = VIEW_LIMITS.frameMaxBytes
/** A control sequence longer than this is dropped up to its terminator or the end of the line. */
export const SEQUENCE_MAX = 256
/** Combining marks and joiners kept after one base character. */
export const MARK_CHAIN_MAX = 4
const TAB_STOP = 8

const NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const

// the xterm default palette of the 16 named colours, to quantize a truecolor or 256-colour value to one of them
const PALETTE16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

const CUBE = [0, 95, 135, 175, 215, 255]

type Rgb = readonly [number, number, number]

const rgbOf256 = (n: number): Rgb => {
  if (n < 16) return PALETTE16[n] as Rgb
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return [v, v, v]
  }
  const i = n - 16
  return [
    CUBE[Math.floor(i / 36)] as number,
    CUBE[Math.floor(i / 6) % 6] as number,
    CUBE[i % 6] as number,
  ]
}

const dist = (a: Rgb, b: Rgb): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

const nearest16 = (rgb: Rgb): string => {
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  PALETTE16.forEach((p, i) => {
    const d = dist(rgb, p)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  return NAMES[best] as string
}

const nearest256 = (rgb: Rgb): number => {
  const level = (v: number): number => {
    let best = 0
    for (let i = 1; i < CUBE.length; i++)
      if (Math.abs((CUBE[i] as number) - v) < Math.abs((CUBE[best] as number) - v)) best = i
    return best
  }
  const [r, g, b] = [level(rgb[0]), level(rgb[1]), level(rgb[2])]
  const cube = 16 + 36 * r + 6 * g + b
  const gray = Math.max(0, Math.min(23, Math.round(((rgb[0] + rgb[1] + rgb[2]) / 3 - 8) / 10)))
  const grayIndex = 232 + gray
  return dist(rgb, rgbOf256(grayIndex)) < dist(rgb, rgbOf256(cube)) ? grayIndex : cube
}

const hex = (n: number): string => n.toString(16).padStart(2, '0')

/** A colour as the SGR set it, quantized to a depth. `undefined` means no colour. */
type Raw = { kind: 'named'; index: number } | { kind: '256'; n: number } | { kind: 'rgb'; rgb: Rgb }
const colorOf = (raw: Raw, depth: 1 | 4 | 8 | 24): string | undefined => {
  if (depth === 1) return undefined
  if (raw.kind === 'named') return NAMES[raw.index]
  if (raw.kind === '256') {
    if (raw.n < 16) return NAMES[raw.n]
    if (depth === 4) return nearest16(rgbOf256(raw.n))
    return `ansi256(${raw.n})`
  }
  if (depth === 24) return `#${hex(raw.rgb[0])}${hex(raw.rgb[1])}${hex(raw.rgb[2])}`
  if (depth === 8) return `ansi256(${nearest256(raw.rgb)})`
  return nearest16(raw.rgb)
}

interface Style {
  fg: Raw | undefined
  bg: Raw | undefined
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  strike: boolean
}

const blank = (): Style => ({
  fg: undefined,
  bg: undefined,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

const byte = (n: number | undefined): n is number =>
  n !== undefined && Number.isInteger(n) && n >= 0 && n <= 255

/** Apply the parameters of one SGR sequence; an unknown or malformed parameter is ignored. */
function applySgr(style: Style, params: Array<number | undefined>): void {
  if (params.length === 0) params = [0]
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0
    if (p === 0) Object.assign(style, blank())
    else if (p === 1) style.bold = true
    else if (p === 2) style.dim = true
    else if (p === 3) style.italic = true
    else if (p === 4) style.underline = true
    else if (p === 7) style.inverse = true
    else if (p === 9) style.strike = true
    else if (p === 22) style.bold = style.dim = false
    else if (p === 23) style.italic = false
    else if (p === 24) style.underline = false
    else if (p === 27) style.inverse = false
    else if (p === 29) style.strike = false
    else if (p >= 30 && p <= 37) style.fg = { kind: 'named', index: p - 30 }
    else if (p >= 90 && p <= 97) style.fg = { kind: 'named', index: p - 90 + 8 }
    else if (p >= 40 && p <= 47) style.bg = { kind: 'named', index: p - 40 }
    else if (p >= 100 && p <= 107) style.bg = { kind: 'named', index: p - 100 + 8 }
    else if (p === 39) style.fg = undefined
    else if (p === 49) style.bg = undefined
    else if (p === 38 || p === 48) {
      const mode = params[i + 1]
      let raw: Raw | undefined
      if (mode === 5 && byte(params[i + 2])) {
        raw = { kind: '256', n: params[i + 2] as number }
        i += 2
      } else if (mode === 2 && byte(params[i + 2]) && byte(params[i + 3]) && byte(params[i + 4])) {
        raw = {
          kind: 'rgb',
          rgb: [params[i + 2] as number, params[i + 3] as number, params[i + 4] as number],
        }
        i += 4
      } else {
        return // malformed extended colour: ignore the rest of this sequence
      }
      if (p === 38) style.fg = raw
      else style.bg = raw
    }
  }
}

// text that is never shown: Unicode noncharacters and tag characters (invisible, used to smuggle text)
const isNonCharacter = (cp: number): boolean =>
  cp === 0xfffe || cp === 0xffff || (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe
const isTag = (cp: number): boolean => cp >= 0xe0000 && cp <= 0xe007f
const MARK = /^\p{M}$/u
const FORMAT = /^\p{Cf}$/u

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0x303e) ||
  (cp >= 0x3041 && cp <= 0x33ff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xa000 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1f64f) ||
  (cp >= 0x1f680 && cp <= 0x1f6ff) ||
  (cp >= 0x1f900 && cp <= 0x1f9ff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

/** What one code point becomes: dropped, a zero-width mark, or a visible character with a width. */
type Class = { kind: 'drop' } | { kind: 'mark' } | { kind: 'char'; width: number }
const DROP: Class = { kind: 'drop' }
const MARKED: Class = { kind: 'mark' }

function classify(cp: number): Class {
  if (cp >= 0x20 && cp < 0x7f) return { kind: 'char', width: 1 }
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return DROP // C0, DEL and C1 (the introducers are handled before)
  if (cp >= 0xd800 && cp <= 0xdfff) return { kind: 'char', width: 1 } // a lone surrogate: the caller shows U+FFFD
  if (isNonCharacter(cp) || isTag(cp)) return DROP
  const ch = String.fromCodePoint(cp)
  if (FORMAT.test(ch)) return cp === 0x200c || cp === 0x200d ? MARKED : DROP // bidi controls and all other format characters go
  if (MARK.test(ch)) return MARKED
  return { kind: 'char', width: isWide(cp) ? 2 : 1 }
}

/** The index after a control string (OSC, DCS, SOS, PM, APC) that starts at `from`: BEL, ST, a newline or an ESC ends it. */
function skipString(input: string, from: number): number {
  for (let j = from; j < input.length; j++) {
    const c = input.charCodeAt(j)
    if (c === 0x07 || c === 0x9c) return j + 1
    if (c === 0x0a) return j // a newline ends it and is kept
    if (c === 0x1b) return input.charCodeAt(j + 1) === 0x5c ? j + 2 : j // ST, or a new escape begins
  }
  return input.length
}

interface Csi {
  /** The index after the sequence. */
  end: number
  params: string
  final: number | undefined
  /** Intermediate bytes or a private marker were present, or it ran past `SEQUENCE_MAX`. */
  plain: boolean
}

/** Scan a CSI body from `from` (after `ESC [`). A byte that cannot belong to it ends it there, unconsumed. */
function scanCsi(input: string, from: number): Csi {
  let j = from
  let plain = true
  while (j < input.length) {
    const c = input.charCodeAt(j)
    if (c >= 0x40 && c <= 0x7e) {
      const params = input.slice(from, j)
      return { end: j + 1, params, final: c, plain: plain && j - from <= SEQUENCE_MAX }
    }
    if (c >= 0x30 && c <= 0x3f) {
      if (c > 0x3b) plain = false // `<`, `=`, `>`, `?` are private markers
    } else if (c >= 0x20 && c <= 0x2f)
      plain = false // an intermediate byte
    else return { end: j, params: '', final: undefined, plain: false } // anything else aborts it
    j++
  }
  return { end: input.length, params: '', final: undefined, plain: false }
}

/**
 * Parse one frame. Never throws; the result holds only text drawn from allowed characters, so no string in it contains `ESC`,
 * a C1 control, a bidi override or a tag character.
 */
export function parseFrame(text: string, options: ParseOptions = {}): ParsedFrame {
  const maxCols = Math.min(options.cols ?? VIEW_LIMITS.cols.max, VIEW_LIMITS.cols.max)
  const maxRows = Math.min(options.rows ?? VIEW_LIMITS.rows.max, VIEW_LIMITS.rows.max)
  const depth = options.colorDepth ?? 24
  let truncated = text.length > PARSE_INPUT_MAX
  const input = truncated ? text.slice(0, PARSE_INPUT_MAX) : text

  const lines: ViewLine[] = []
  let runs: ViewRun[] = []
  let cells = 0
  let chain = 0
  let skipLine = false // the line is full: drop the rest of it
  const style = blank()

  const push = (chars: string): void => {
    const fg = style.fg === undefined ? undefined : colorOf(style.fg, depth)
    const bg = style.bg === undefined ? undefined : colorOf(style.bg, depth)
    const last = runs.at(-1)
    if (
      last !== undefined &&
      last.fg === fg &&
      last.bg === bg &&
      (last.bold === true) === style.bold &&
      (last.dim === true) === style.dim &&
      (last.italic === true) === style.italic &&
      (last.underline === true) === style.underline &&
      (last.inverse === true) === style.inverse &&
      (last.strike === true) === style.strike
    ) {
      last.text += chars
      return
    }
    const run: ViewRun = { text: chars }
    if (fg !== undefined) run.fg = fg
    if (bg !== undefined) run.bg = bg
    if (style.bold) run.bold = true
    if (style.dim) run.dim = true
    if (style.italic) run.italic = true
    if (style.underline) run.underline = true
    if (style.inverse) run.inverse = true
    if (style.strike) run.strike = true
    runs.push(run)
  }

  const put = (chars: string, width: number): void => {
    if (skipLine) return
    if (cells + width > maxCols) {
      skipLine = true
      truncated = true
      return
    }
    push(chars)
    cells += width
  }

  const endLine = (): boolean => {
    lines.push(runs)
    runs = []
    cells = 0
    chain = 0
    skipLine = false
    if (lines.length >= maxRows) {
      truncated = true
      return false
    }
    return true
  }

  let i = 0
  let more = true
  while (i < input.length && more) {
    const cp = input.codePointAt(i) as number
    const width = cp > 0xffff ? 2 : 1
    if (cp === 0x1b) {
      const next = input.charCodeAt(i + 1)
      if (Number.isNaN(next)) break // a truncated escape at the end
      if (next === 0x5b) {
        const csi = scanCsi(input, i + 2)
        if (csi.final === 0x6d && csi.plain && /^[0-9;:]*$/.test(csi.params)) {
          const parts = csi.params.split(/[;:]/)
          if (parts.length <= 32)
            applySgr(
              style,
              parts.map((p) => (p === '' ? 0 : Number(p))),
            )
        }
        i = csi.end
      } else if (
        next === 0x5d ||
        next === 0x50 ||
        next === 0x58 ||
        next === 0x5e ||
        next === 0x5f
      ) {
        i = skipString(input, i + 2) // OSC, DCS, SOS, PM, APC
      } else {
        // a two-character escape, with intermediates: `ESC c`, `ESC ( B`
        let j = i + 1
        while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++
        const final = input.charCodeAt(j)
        i = final >= 0x30 && final <= 0x7e ? j + 1 : j
      }
      continue
    }
    if (cp >= 0x80 && cp <= 0x9f) {
      // C1: the introducers start a sequence whose body is dropped; the rest are dropped alone
      if (cp === 0x9b) i = scanCsi(input, i + 1).end
      else if (cp === 0x90 || cp === 0x98 || cp === 0x9d || cp === 0x9e || cp === 0x9f)
        i = skipString(input, i + 1)
      else i += 1
      continue
    }
    i += width
    if (cp === 0x0a || cp === 0x2028 || cp === 0x2029) {
      more = endLine()
      continue
    }
    if (cp === 0x0d) continue // a carriage return is dropped; `\r\n` is a newline
    if (cp === 0x09) {
      const spaces = TAB_STOP - (cells % TAB_STOP)
      put(' '.repeat(spaces), spaces)
      continue
    }
    const kind = classify(cp)
    if (kind.kind === 'drop') continue
    if (kind.kind === 'mark') {
      if (chain < MARK_CHAIN_MAX && cells > 0 && !skipLine) {
        push(String.fromCodePoint(cp))
        chain++
      }
      continue
    }
    chain = 0
    put(cp >= 0xd800 && cp <= 0xdfff ? '�' : String.fromCodePoint(cp), kind.width)
  }
  if (more) lines.push(runs)
  return { lines, truncated }
}
