// Word wrap and subtitle rows with an injected width function: the terminal passes Bun's `cells`, the browser a pure one.

export type WidthOf = (text: string) => number

/** Wrap text at spaces into rows of at most `width` cells; a word longer than a row is cut. */
export function wordWrapWith(text: string, width: number, cells: WidthOf): string[] {
  const max = Math.max(1, width)
  const out: string[] = []
  let line = ''
  let used = 0
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = [...word]
    while (rest.length > 0 && cells(rest.join('')) > max) {
      if (line) {
        out.push(line)
        line = ''
        used = 0
      }
      let take = ''
      let n = 0
      for (const ch of rest) {
        if (cells(take + ch) > max) break
        take += ch
        n++
      }
      if (n === 0) n = 1 // a glyph wider than the row still moves on
      out.push(rest.slice(0, n).join(''))
      rest = rest.slice(n)
    }
    const w = rest.join('')
    if (w === '') continue
    const wc = cells(w)
    if (line && used + 1 + wc > max) {
      out.push(line)
      line = w
      used = wc
    } else {
      line = line ? `${line} ${w}` : w
      used = line ? cells(line) : 0
    }
  }
  if (line) out.push(line)
  return out
}

/** The newest `maxRows` wrapped rows of a text: what the subtitle shows. */
export function subtitleRowsWith(
  text: string,
  width: number,
  cells: WidthOf,
  maxRows = 2,
): string[] {
  return wordWrapWith(text, width, cells).slice(-maxRows)
}
