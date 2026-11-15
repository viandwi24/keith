import { describe, expect, test } from 'bun:test'
import { inputOffText, placeholderOf, sendsRoomMessage } from './room-keys.ts'

describe('composer keys', () => {
  test('Enter sends; Shift+Enter, modifiers and IME composition do not', () => {
    expect(sendsRoomMessage({ key: 'Enter' })).toBe(true)
    expect(sendsRoomMessage({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(sendsRoomMessage({ key: 'Enter', metaKey: true })).toBe(false)
    expect(sendsRoomMessage({ key: 'Enter', isComposing: true })).toBe(false)
    expect(sendsRoomMessage({ key: 'a' })).toBe(false)
  })
  test('placeholders and the reasons the field is off', () => {
    expect(placeholderOf(true)).toBe('Reply to Keith')
    expect(placeholderOf(false)).toBe('Message the room')
    expect(inputOffText({ ended: true, left: false, canSpeak: false })).toContain('ended')
    expect(inputOffText({ ended: false, left: true, canSpeak: false })).toBe(
      'You are no longer in this room.',
    )
    expect(inputOffText({ ended: false, left: false, canSpeak: false })).toBe('Sending is off.')
    expect(inputOffText({ ended: false, left: false, canSpeak: true })).toBeUndefined()
  })
})
