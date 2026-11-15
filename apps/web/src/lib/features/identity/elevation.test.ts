import { describe, expect, test } from 'bun:test'
import { elevatedLeft, elevatedPillText, initialsOf, remaining } from './elevation.ts'

describe('remaining', () => {
  test('formats m:ss and rounds up', () => {
    expect(remaining(598_000)).toBe('9:58')
    expect(remaining(4_100)).toBe('0:05')
    expect(remaining(0)).toBe('0:00')
    expect(remaining(-5)).toBe('0:00')
    expect(remaining(600_000)).toBe('10:00')
  })
})

describe('elevated pill', () => {
  test('counts down to elevatedUntil and disappears at the end', () => {
    expect(elevatedPillText(1_000_000 + 598_000, 1_000_000)).toBe('elevated 9:58')
    expect(elevatedPillText(1_000_000, 1_000_000)).toBeUndefined()
    expect(elevatedPillText(null, 5)).toBeUndefined()
    expect(elevatedPillText(undefined, 5)).toBeUndefined()
    expect(elevatedLeft(10, 25)).toBe(0)
  })
})

describe('initialsOf', () => {
  test('takes up to two initials', () => {
    expect(initialsOf('Ana Maria Lopez')).toBe('AM')
    expect(initialsOf('duta')).toBe('D')
    expect(initialsOf('  ')).toBe('?')
  })
})
