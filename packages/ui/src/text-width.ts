/** Terminal cells a string takes (Bun's own width: wide glyphs are 2, combining marks 0). */
export const cells = (text: string): number => Bun.stringWidth(text)

/** Cut a string to at most `width` cells, ending with `…` when something was dropped. */
export function clip(text: string, width: number): string {
  if (cells(text) <= width) return text
  if (width <= 0) return ''
  let out = ''
  for (const ch of text) {
    if (cells(`${out}${ch}`) > width - 1) break
    out += ch
  }
  return `${out}…`
}

/** Hard-wrap one logical line into rows of at most `width` cells (an empty line is one empty row). */
export function wrapRows(line: string, width: number): string[] {
  const max = Math.max(1, width)
  const rows: string[] = []
  let row = ''
  let used = 0
  for (const ch of line) {
    const w = cells(ch)
    if (used + w > max) {
      rows.push(row)
      row = ''
      used = 0
    }
    row += ch
    used += w
  }
  rows.push(row)
  return rows
}
