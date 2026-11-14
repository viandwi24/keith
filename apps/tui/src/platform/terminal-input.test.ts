import { describe, expect, test } from 'bun:test'
import { mouseReply } from '../app-commands.ts'
import { createMouse, filterInput, MOUSE_OFF, MOUSE_ON, scanInput } from './terminal-input.ts'

const ESC = String.fromCharCode(27)
const wheelUp = `${ESC}[<64;10;5M`
const wheelDown = `${ESC}[<65;10;5M`

describe('scanInput', () => {
  test('wheel up and down become notches and leave nothing for Ink', () => {
    expect(scanInput(wheelUp)).toEqual({ text: '', wheel: [-1], kitty: false, pending: '' })
    expect(scanInput(`${wheelDown}${wheelDown}${wheelUp}`).wheel).toEqual([1, 1, -1])
  })

  test('typed text around a wheel report stays, in order', () => {
    const out = scanInput(`ab${wheelDown}cd`)
    expect(out.text).toBe('abcd')
    expect(out.wheel).toEqual([1])
  })

  test('wheel with modifiers still scrolls; sideways wheel, clicks, motion and releases do not', () => {
    expect(scanInput(`${ESC}[<68;1;1M`).wheel).toEqual([-1]) // shift + up
    expect(scanInput(`${ESC}[<81;1;1M`).wheel).toEqual([1]) // ctrl + down
    for (const code of [66, 67, 0, 1, 2, 32, 35]) {
      const out = scanInput(`${ESC}[<${code};3;4M`)
      expect(out.wheel).toEqual([])
      expect(out.text).toBe('') // dropped, never typed into the input
    }
    expect(scanInput(`${ESC}[<0;3;4m`).text).toBe('')
  })

  test('a report split across two reads is held and finished', () => {
    const first = scanInput(`x${ESC}[<64;1`)
    expect(first.text).toBe('x')
    expect(first.pending).toBe(`${ESC}[<64;1`)
    const second = scanInput('0;5M', first.pending)
    expect(second.wheel).toEqual([-1])
    expect(second.text).toBe('')
    expect(second.pending).toBe('')
  })

  test('a lone escape or an arrow key is never held back and passes through', () => {
    for (const key of [ESC, `${ESC}[A`, `${ESC}[5~`, `${ESC}[1;3A`, `${ESC}[13;2u`]) {
      const out = scanInput(key)
      expect(out.text).toBe(key)
      expect(out.pending).toBe('')
    }
  })

  test('garbage that only looks like a mouse report is left alone', () => {
    for (const junk of [`${ESC}[<abc`, `${ESC}[<64;M`, '[<64;1;1M', `${ESC}<64;1;1M`]) {
      const out = scanInput(junk)
      expect(out.wheel).toEqual([])
      expect(out.text.length).toBeGreaterThan(0)
    }
  })

  test('the Kitty query reply and a shift+enter sequence show the keyboard protocol, and pass on', () => {
    const reply = scanInput(`${ESC}[?0u`)
    expect(reply.kitty).toBe(true)
    expect(reply.text).toBe(`${ESC}[?0u`) // Ink consumes it as the answer to its query
    expect(scanInput(`${ESC}[13;2u`).kitty).toBe(true) // shift+enter
    expect(scanInput(`${ESC}[13;2:1u`).kitty).toBe(true)
    expect(scanInput(`${ESC}[13;3u`).kitty).toBe(false) // alt+enter alone proves nothing about shift
    expect(scanInput('\r').kitty).toBe(false)
  })
})

describe('filterInput', () => {
  const stream = (chunks: string[]) => {
    const queue = [...chunks]
    return { isTTY: true, read: () => queue.shift() ?? null }
  }

  test('Ink keeps reading with read(): mouse reports are taken out and reported', () => {
    const wheel: number[] = []
    let kitty = 0
    const s = stream([`a${wheelUp}`, `${ESC}[?1u`, wheelDown])
    filterInput(s, { onWheel: (n) => wheel.push(n), onKitty: () => kitty++ })
    expect(s.read()).toBe('a')
    expect(s.read()).toBe(`${ESC}[?1u`)
    expect(s.read()).toBe('') // empty, not null: Ink's loop goes on to the next chunk
    expect(s.read()).toBeNull()
    expect(wheel).toEqual([-3, 3])
    expect(kitty).toBe(1)
  })

  test('restore puts the original read back; a non-terminal stream is left alone', () => {
    const s = stream([wheelUp])
    const original = s.read
    const restore = filterInput(s, { onWheel: () => {}, onKitty: () => {} })
    expect(s.read).not.toBe(original)
    restore()
    expect(s.read).toBe(original)
    const pipe = { isTTY: false, read: () => null }
    const before = pipe.read
    filterInput(pipe, { onWheel: () => {}, onKitty: () => {} })
    expect(pipe.read).toBe(before)
  })
})

describe('createMouse', () => {
  test('on and off write the SGR reporting sequences once; dispose always cleans up', () => {
    const out: string[] = []
    const mouse = createMouse((t) => out.push(t))
    mouse.set(true)
    mouse.set(true)
    expect(out).toEqual([MOUSE_ON])
    expect(mouse.enabled()).toBe(true)
    mouse.set(false)
    expect(out).toEqual([MOUSE_ON, MOUSE_OFF])
    mouse.dispose() // the state says off, the terminal is still cleaned
    expect(out).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_OFF])
    expect(MOUSE_ON).toBe(`${ESC}[?1000h${ESC}[?1006h`)
    expect(MOUSE_OFF).toContain(`${ESC}[?1000l`)
    expect(MOUSE_OFF).toContain(`${ESC}[?1006l`)
  })
})

describe('/mouse', () => {
  const fake = (on: boolean) => {
    let state = on
    return { enabled: () => state, set: (v: boolean) => (state = v) }
  }
  test('off restores native selection, on brings the wheel back, no argument toggles', () => {
    const m = fake(true)
    expect(mouseReply('off', m)[0]).toContain('select and copy')
    expect(m.enabled()).toBe(false)
    expect(mouseReply('on', m)[0]).toContain('shift')
    expect(m.enabled()).toBe(true)
    mouseReply(undefined, m)
    expect(m.enabled()).toBe(false)
  })
  test('a wrong argument or no terminal says so and changes nothing', () => {
    const m = fake(true)
    expect(mouseReply('maybe', m)[0]).toContain('Usage')
    expect(m.enabled()).toBe(true)
    expect(mouseReply('on', undefined)[0]).toContain('needs a terminal')
  })
})
