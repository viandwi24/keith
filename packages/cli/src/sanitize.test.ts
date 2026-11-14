import { describe, expect, test } from 'bun:test'
import { stripControl } from './sanitize.ts'

const ESC = '\u001b'
/** The same table is in `packages/ui/src/safe-text.test.ts` and `packages/cli/src/sanitize.test.ts`. */
const CASES: { name: string; input: string; plain: string; kept?: string }[] = [
  { name: 'CSI clear screen', input: `a${ESC}[2Jb`, plain: 'ab' },
  { name: 'CSI colour', input: `${ESC}[31mred${ESC}[0m`, plain: 'red' },
  { name: 'OSC 52 clipboard write (BEL)', input: `x${ESC}]52;c;aGk=\u0007y`, plain: 'xy' },
  { name: 'OSC title (ST)', input: `x${ESC}]0;title${ESC}\\y`, plain: 'xy' },
  { name: 'DCS', input: `x${ESC}Pq data${ESC}\\y`, plain: 'xy' },
  { name: 'C1 0x9b', input: 'a\u009b2Jb', plain: 'ab' },
  { name: 'C1 CSI colour', input: '\u009b31mred\u009b0m', plain: 'red' },
  {
    name: 'C1 CSI clear and cursor move forge a line',
    input: 'x\u009b2J\u009b1;1Hfake',
    plain: 'xfake',
  },
  { name: 'bare CR', input: 'real\rfake', plain: 'real fake', kept: 'real\nfake' },
  { name: 'U+202E', input: 'a‮b⁦c', plain: 'abc' },
  { name: 'DEL and NUL', input: 'a\u007fb\u0000c', plain: 'abc' },
  {
    name: 'newline forges a table row',
    input: 'ok\nroot  owner',
    plain: 'ok root  owner',
    kept: 'ok\nroot  owner',
  },
  { name: 'plain text and emoji', input: 'Zoë 🙂 日本', plain: 'Zoë 🙂 日本' },
]

describe('stripControl', () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(stripControl(c.input)).toBe(c.plain)
      expect(stripControl(c.input, { newlines: true })).toBe(c.kept ?? c.plain)
    })
  }
})
