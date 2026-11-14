import { describe, expect, test } from 'bun:test'
import { actionCount, parseInputActions, parseScreenshotInput } from './actions.ts'

describe('parseInputActions', () => {
  test('accepts every action type with its fields', () => {
    const parsed = parseInputActions({
      actions: [
        { type: 'move', x: 1, y: 2 },
        { type: 'click', x: 1, y: 2 },
        { type: 'double_click', x: 1, y: 2 },
        { type: 'right_click', x: 1, y: 2 },
        { type: 'drag', x: 1, y: 2, to: { x: 3, y: 4 } },
        { type: 'scroll', x: 1, y: 2, keys: ['up'] },
        { type: 'type', text: 'hello' },
        { type: 'key', keys: ['cmd', 'shift', 'a'] },
        { type: 'key', keys: ['return'] },
      ],
    })
    expect(parsed.ok).toBe(true)
  })

  test('refuses a drag without its end point', () => {
    const parsed = parseInputActions({ actions: [{ type: 'drag', x: 1, y: 2 }] })
    expect(parsed).toEqual({ ok: false, message: 'action 0: drag needs x, y and to' })
  })

  test('refuses an empty type text', () => {
    const parsed = parseInputActions({ actions: [{ type: 'type', text: '' }] })
    expect(parsed).toEqual({ ok: false, message: 'action 0: type needs text' })
  })

  test('refuses a key that is not a key name, and a non-modifier before it', () => {
    expect(parseInputActions({ actions: [{ type: 'key', keys: ['f13'] }] })).toEqual({
      ok: false,
      message: 'action 0: f13 is not a key',
    })
    expect(parseInputActions({ actions: [{ type: 'key', keys: ['a', 'b'] }] })).toEqual({
      ok: false,
      message: 'action 0: a is not a modifier (cmd, shift, alt, ctrl)',
    })
  })

  test('refuses a scroll direction that is not a direction', () => {
    const parsed = parseInputActions({
      actions: [{ type: 'scroll', x: 1, y: 1, keys: ['diagonal'] }],
    })
    expect(parsed).toEqual({
      ok: false,
      message: 'action 0: scroll direction diagonal is not up, down, left or right',
    })
  })

  test('refuses an empty batch', () => {
    expect(parseInputActions({ actions: [] }).ok).toBe(false)
  })
})

describe('actionCount', () => {
  test('counts the actions of a batch and is zero for anything else', () => {
    expect(actionCount({ actions: [{}, {}] })).toBe(2)
    expect(actionCount({ actions: 'x' })).toBe(0)
    expect(actionCount(undefined)).toBe(0)
  })
})

describe('parseScreenshotInput', () => {
  test('defaults maxWidth to 1280 and accepts no input', () => {
    expect(parseScreenshotInput(undefined)).toEqual({ ok: true, value: { maxWidth: 1280 } })
    expect(parseScreenshotInput({ display: 1, maxWidth: 800 })).toEqual({
      ok: true,
      value: { display: 1, maxWidth: 800 },
    })
  })
})
