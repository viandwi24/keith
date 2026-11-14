import { describe, expect, test } from 'bun:test'
import { type Check, exitCodeOf, type Level } from './types.ts'

const line = (level: Level): Check => ({ level, name: 'x', hint: 'y' })

describe('doctor exit code', () => {
  const cases: [string, Level[], 0 | 1][] = [
    ['no checks', [], 0],
    ['all ok', ['ok', 'ok'], 0],
    ['warnings and notes never fail', ['ok', 'warn', 'warn'], 0],
    ['one failure', ['ok', 'fail'], 1],
    ['a failure among warnings', ['warn', 'fail', 'warn'], 1],
  ]
  for (const [name, levels, code] of cases) {
    test(name, () => expect(exitCodeOf(levels.map(line))).toBe(code))
  }
})
