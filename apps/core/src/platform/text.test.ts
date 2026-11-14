import { describe, expect, test } from 'bun:test'
import { capHeadTail, HeadTail } from './text.ts'

describe('capHeadTail', () => {
  test('short text is untouched', () => {
    expect(capHeadTail('abc', 10)).toBe('abc')
    expect(capHeadTail('x'.repeat(10), 10)).toBe('x'.repeat(10))
  })

  test('a long text keeps its start and end and says how much is missing', () => {
    const text = `START${'-'.repeat(1000)}END`
    const capped = capHeadTail(text, 100)
    expect(capped.startsWith('START')).toBe(true)
    expect(capped.endsWith('END')).toBe(true)
    expect(capped).toContain('[908 characters omitted]')
    expect(capped.length).toBeLessThan(160)
  })
})

describe('HeadTail', () => {
  test('under the limits it is the whole text', () => {
    const h = new HeadTail(10, 10)
    h.push('hello ')
    h.push('world')
    expect(h.text()).toBe('hello world')
  })

  test('beyond them: the first and the last characters, with the count in between', () => {
    const h = new HeadTail(5, 5)
    for (let i = 0; i < 100; i++) h.push('abcdefghij'.slice(i % 10, (i % 10) + 1))
    const text = h.text()
    expect(text.startsWith('abcde')).toBe(true)
    expect(text.endsWith('fghij')).toBe(true)
    expect(text).toContain('[90 characters omitted]')
  })

  test('a single huge chunk is split the same way', () => {
    const h = new HeadTail(3, 3)
    h.push('0123456789')
    expect(h.text()).toBe('012\n… [4 characters omitted] …\n789')
  })
})
