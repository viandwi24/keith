// A pure cell-width estimate for a browser (no Bun API): wide East Asian and emoji code points are 2, combining marks and
// zero-width joiners are 0, everything else 1. The terminal uses `cells` (Bun's exact width); the orb model takes the width
// function as an argument, so the web passes this one.

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u

/** Cells one code point takes. */
export function pointCells(ch: string): number {
  if (ZERO.test(ch)) return 0
  const cp = ch.codePointAt(0) ?? 0
  return WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1
}

/** Cells a string takes. */
export function pureCells(text: string): number {
  let total = 0
  for (const ch of text) total += pointCells(ch)
  return total
}
