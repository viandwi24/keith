const ESC = '\u001b'

/**
 * A tiny terminal screen for PTY tests. Ink's incremental rendering rewrites only what changed
 * (`ESC [ 18 G ESC [ K text`: move to a column, erase to the end of the line, write), so the raw
 * byte stream never holds a whole line. This applies the same sequences to a grid and reads back
 * what a person would see: cursor moves (A B C D E F G H), erase (J K), and plain text with wide
 * glyphs. Colours (`m`), modes (`h` `l`) and everything else are ignored, and entering or leaving
 * the alternate screen clears the grid.
 */
export class VtScreen {
  private grid: string[][] = []
  private row = 0
  private col = 0
  private pending = ''
  private readonly decoder = new TextDecoder()

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.clear()
  }

  private clear(): void {
    this.grid = Array.from({ length: this.rows }, () => [])
    this.row = 0
    this.col = 0
  }

  private put(ch: string): void {
    const width = Math.max(1, Bun.stringWidth(ch))
    if (this.col + width > this.columns) {
      this.col = 0
      this.lineFeed()
    }
    const line = this.grid[this.row] ?? []
    while (line.length < this.col) line.push(' ')
    line[this.col] = ch
    for (let i = 1; i < width; i++) line[this.col + i] = ''
    this.grid[this.row] = line
    this.col += width
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) this.row++
    else {
      this.grid.shift()
      this.grid.push([])
    }
  }

  private csi(params: string, final: string): void {
    const nums = params
      .replace(/^[?>]/, '')
      .split(';')
      .map((p) => (p === '' ? undefined : Number(p)))
    const n = nums[0] ?? 1
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - n)
        break
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + n)
        break
      case 'C':
        this.col = Math.min(this.columns - 1, this.col + n)
        break
      case 'D':
        this.col = Math.max(0, this.col - n)
        break
      case 'E':
        this.row = Math.min(this.rows - 1, this.row + n)
        this.col = 0
        break
      case 'F':
        this.row = Math.max(0, this.row - n)
        this.col = 0
        break
      case 'G':
        this.col = Math.max(0, Math.min(this.columns - 1, n - 1))
        break
      case 'H':
      case 'f':
        this.row = Math.max(0, Math.min(this.rows - 1, (nums[0] ?? 1) - 1))
        this.col = Math.max(0, Math.min(this.columns - 1, (nums[1] ?? 1) - 1))
        break
      case 'J': {
        const mode = nums[0] ?? 0
        if (mode === 2 || mode === 3) this.clear()
        else if (mode === 0) {
          this.grid[this.row] = (this.grid[this.row] ?? []).slice(0, this.col)
          for (let r = this.row + 1; r < this.rows; r++) this.grid[r] = []
        }
        break
      }
      case 'K': {
        const mode = nums[0] ?? 0
        const line = this.grid[this.row] ?? []
        if (mode === 0) this.grid[this.row] = line.slice(0, this.col)
        else if (mode === 2) this.grid[this.row] = []
        else for (let i = 0; i <= this.col && i < line.length; i++) line[i] = ' '
        break
      }
      case 'h':
      case 'l':
        // the alternate screen: a fresh grid on the way in and out
        if (params === '?1049' || params === '?47' || params === '?1047') this.clear()
        break
      default:
        break
    }
  }

  /** Feed bytes as the terminal receives them (a multibyte glyph may be split between chunks). */
  feed(data: Uint8Array | string): void {
    const text =
      this.pending + (typeof data === 'string' ? data : this.decoder.decode(data, { stream: true }))
    this.pending = ''
    let i = 0
    while (i < text.length) {
      const ch = text[i] as string
      if (ch === ESC) {
        const next = text[i + 1]
        if (next === undefined) {
          this.pending = text.slice(i)
          return
        }
        if (next === '[') {
          let j = i + 2
          while (j < text.length && /[0-9;?>]/.test(text[j] as string)) j++
          if (j >= text.length) {
            this.pending = text.slice(i)
            return
          }
          this.csi(text.slice(i + 2, j), text[j] as string)
          i = j + 1
          continue
        }
        // other escapes (`ESC 7`, `ESC =`): two characters, ignored
        i += 2
        continue
      }
      const cp = text.codePointAt(i) ?? 0
      const glyph = String.fromCodePoint(cp)
      i += glyph.length
      if (glyph === '\n') {
        this.col = 0
        this.lineFeed()
      } else if (glyph === '\r') this.col = 0
      else if (glyph >= ' ') this.put(glyph)
    }
  }

  /** The screen as text, one string per row without trailing blanks. */
  lines(): string[] {
    return this.grid.map((line) => line.join('').trimEnd())
  }

  text(): string {
    return this.lines().join('\n')
  }
}
