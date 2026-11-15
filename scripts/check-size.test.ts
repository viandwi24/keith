import { describe, expect, test } from 'bun:test'
import { checkSizes, isChecked, MAX_LINES, WARN_LINES } from './check-size.ts'

const lines = (n: number) => `${'x\n'.repeat(n)}`

describe('checkSizes', () => {
  test('passes small files, warns over the soft limit, fails over the hard limit', () => {
    const report = checkSizes([
      ['a.ts', lines(10)],
      ['b.ts', lines(WARN_LINES + 1)],
      ['c.tsx', lines(MAX_LINES + 1)],
    ])
    expect(report.warnings).toEqual([`b.ts: ${WARN_LINES + 1} lines (aim for ${WARN_LINES})`])
    expect(report.errors).toEqual([`c.tsx: ${MAX_LINES + 1} lines (max ${MAX_LINES})`])
  })

  test('skips generated files', () => {
    const big = lines(MAX_LINES + 1)
    const report = checkSizes([
      ['packages/db/drizzle/0001.ts', big],
      ['x.ts', `// @generated\n${big}`],
    ])
    expect(report.errors).toEqual([])
  })

  test('checks source extensions only', () => {
    expect(isChecked('a.ts')).toBe(true)
    expect(isChecked('apps/web/src/a.svelte')).toBe(true)
    expect(isChecked('a.md')).toBe(false)
    expect(isChecked('scripts/exports.snapshot.json')).toBe(false)
  })
})
