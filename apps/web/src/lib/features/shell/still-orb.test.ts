import { describe, expect, test } from 'bun:test'
import { orbIsStill, readStillOrb, STILL_ORB_KEY, writeStillOrb } from './still-orb.ts'

const memory = () => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  }
}
const blocked = {
  getItem: (): string | null => {
    throw new Error('blocked')
  },
  setItem: (): void => {
    throw new Error('blocked')
  },
  removeItem: (): void => {
    throw new Error('blocked')
  },
}

describe('still orb setting', () => {
  test('off by default, remembered when on, removed when off', () => {
    const s = memory()
    expect(readStillOrb(s)).toBe(false)
    writeStillOrb(true, s)
    expect(s.map.get(STILL_ORB_KEY)).toBe('on')
    expect(readStillOrb(s)).toBe(true)
    writeStillOrb(false, s)
    expect(readStillOrb(s)).toBe(false)
    expect(s.map.size).toBe(0)
  })
  test('blocked storage never throws and reads as off', () => {
    expect(readStillOrb(blocked)).toBe(false)
    expect(() => writeStillOrb(true, blocked)).not.toThrow()
    expect(readStillOrb(undefined)).toBe(false)
  })
  test('the setting or reduced motion makes the orb still', () => {
    expect(orbIsStill(false, false)).toBe(false)
    expect(orbIsStill(true, false)).toBe(true)
    expect(orbIsStill(false, true)).toBe(true)
  })
})
