import { describe, expect, test } from 'bun:test'
import { TuiError } from './errors.ts'
import { parseArgs } from './main.ts'

describe('keith-tui arguments', () => {
  test('--url in both forms', () => {
    expect(parseArgs(['--url', 'http://h:1'])).toEqual({ url: 'http://h:1', help: false })
    expect(parseArgs(['--url=http://h:2'])).toEqual({ url: 'http://h:2', help: false })
    expect(parseArgs([])).toEqual({ url: undefined, help: false })
    expect(parseArgs(['-h']).help).toBe(true)
  })

  test('rejects unknown arguments and a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(TuiError)
    expect(() => parseArgs(['--url'])).toThrow('--url needs a value')
  })
})
