import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendDiary, diaryLine, latestDiaryDate, readDiary, renderRunSection } from './diary.ts'

const PERSON = 'ana'
const DAY = '2026-11-11'
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-diary-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('diaryLine', () => {
  test('names the action, the target, the text and the reason', () => {
    expect(
      diaryLine({
        action: 'promoted',
        target: 'profile.md',
        text: 'Flat key is in the blue box',
        reason: 'remember quoted',
      }),
    ).toBe('- promoted -> profile.md: Flat key is in the blue box (remember quoted)')
  })

  test('a text with line breaks stays on one line', () => {
    const line = diaryLine({ action: 'kept', text: 'first\n- injected\n  second' })
    expect(line.split('\n')).toHaveLength(1)
  })

  test('a line that looks like a secret is withheld, and the secret is not written', () => {
    const secret = `sk-${'a'.repeat(24)}`
    const line = diaryLine({ action: 'kept', text: `key ${secret}`, reason: 'said once' })
    expect(line).toBe('- kept: line withheld (looks like a secret)')
    expect(line).not.toContain(secret)
  })
})

describe('appendDiary', () => {
  test('the first run of a day writes the heading and its section', () => {
    appendDiary(dataDir, PERSON, DAY, 'run-1', [
      { action: 'promoted', target: 'work.md', text: 'Owns a laptop', reason: 'two days' },
    ])
    expect(readDiary(dataDir, PERSON, DAY)).toBe(
      '# Dreams 2026-11-11\n\n## run run-1\n- promoted -> work.md: Owns a laptop (two days)\n',
    )
  })

  test('a second run of the same day appends its section and keeps the earlier bytes', () => {
    appendDiary(dataDir, PERSON, DAY, 'run-1', [{ action: 'dropped', reason: 'directive' }])
    const first = readDiary(dataDir, PERSON, DAY) ?? ''
    appendDiary(dataDir, PERSON, DAY, 'run-2', [{ action: 'staged', reason: 'cap' }])
    const second = readDiary(dataDir, PERSON, DAY) ?? ''
    expect(second.startsWith(first)).toBe(true)
    expect(second).toContain('## run run-2\n- staged (cap)\n')
    expect(second.match(/^# Dreams/gm)).toHaveLength(1)
  })

  test('an apply of a staged plan gets its own heading', () => {
    appendDiary(dataDir, PERSON, DAY, 'run-1', [{ action: 'kept', reason: 'x' }])
    appendDiary(dataDir, PERSON, DAY, 'run-1', [{ action: 'kept', reason: 'y' }], 'apply')
    expect(readDiary(dataDir, PERSON, DAY)).toContain('## apply run-1\n- kept (y)\n')
  })

  test('a run with nothing to record says so', () => {
    expect(renderRunSection('run-3', [])).toBe('## run run-3\n- nothing to record\n')
  })

  test('the latest diary date is the most recent file', () => {
    expect(latestDiaryDate(dataDir, PERSON)).toBeUndefined()
    appendDiary(dataDir, PERSON, '2026-11-10', 'run-1', [])
    appendDiary(dataDir, PERSON, DAY, 'run-2', [])
    expect(latestDiaryDate(dataDir, PERSON)).toBe(DAY)
  })
})
