import { describe, expect, test } from 'bun:test'
import { OutputCollector } from './output.ts'

describe('OutputCollector', () => {
  test('text under the cap is returned whole and not truncated', () => {
    const out = new OutputCollector()
    out.push('hello ')
    out.push('world')
    expect(out.truncated).toBe(false)
    expect(out.text()).toBe('hello world')
  })

  test('text over the cap keeps the head and the tail and says how much went', () => {
    const out = new OutputCollector(10)
    out.push('0123456789abcdefghij')
    expect(out.truncated).toBe(true)
    expect(out.text()).toBe('01234\n[... 10 characters truncated ...]\nfghij')
  })
})
