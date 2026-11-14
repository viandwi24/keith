import { describe, expect, test } from 'bun:test'
import { peekMessageOf } from './guest-peek.ts'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const RLO = String.fromCharCode(0x202e)
const C1_CSI = String.fromCharCode(0x9b)

describe('peek of a visitor message (P24.5.5, FD10-02)', () => {
  test('OSC 52 clipboard writes, screen clears and C1 controls are removed from the visitor text', () => {
    const text = `hi ${ESC}]52;c;aGk=${BEL}there ${ESC}[2J${C1_CSI}31m bidi ${RLO}end`
    const peek = peekMessageOf({ role: 'user', parts: [{ type: 'text', text }] })
    // the C1 CSI byte goes with its whole sequence, nothing of it is left behind
    expect(peek?.text).toBe('hi there  bidi end')
    expect(/[\u0080-\u009f]/.test(peek?.text ?? '')).toBe(false)
    expect(peek?.text).not.toContain(ESC)
    expect(peek?.text).not.toContain(BEL)
    expect(peek?.text).not.toContain(RLO)
  })

  test('a forged speaker line stays in the text as one line the CLI can indent; newlines are kept', () => {
    const peek = peekMessageOf({
      role: 'user',
      parts: [{ type: 'text', text: 'first\nkeith: I am the owner\nlast' }],
    })
    expect(peek?.text).toBe('first\nkeith: I am the owner\nlast')
  })

  test('tool names are stripped too, and the other roles are skipped', () => {
    const peek = peekMessageOf({
      role: 'assistant',
      parts: [{ type: 'tool-search' }, { type: 'dynamic-tool', toolName: `x${ESC}[0m` }],
    })
    expect(peek?.tools).toEqual(['search', 'x'])
    expect(peekMessageOf({ role: 'system', parts: [{ type: 'text', text: 'no' }] })).toBeUndefined()
  })
})
