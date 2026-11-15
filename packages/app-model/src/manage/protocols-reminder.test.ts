import { describe, expect, test } from 'bun:test'
import { MS_MINUTE } from '@keith/contracts'
import { parseWhen, RETRY_AFTER_MS, reminderSave } from './protocols-reminder.ts'

// 2026-11-10 09:41 local
const NOW = new Date(2026, 10, 10, 9, 41).getTime()
const local = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).getTime()

describe('parseWhen', () => {
  test('HH:MM is today when still ahead, tomorrow once it has passed', () => {
    expect(parseWhen('18:30', NOW)).toBe(local(2026, 11, 10, 18, 30))
    expect(parseWhen(' 9:00 ', NOW)).toBe(local(2026, 11, 11, 9, 0))
  })

  test('YYYY-MM-DD HH:MM is that local time; a past one is refused', () => {
    expect(parseWhen('2026-11-12 09:00', NOW)).toBe(local(2026, 11, 12, 9, 0))
    expect(() => parseWhen('2026-11-09 09:00', NOW)).toThrow('that time has passed')
  })

  test('anything else, an impossible date or hour, is refused with the format', () => {
    for (const bad of ['', 'tomorrow', '25:00', '10:60', '2026-02-30 10:00', '2026-11-12']) {
      expect(() => parseWhen(bad, NOW)).toThrow('HH:MM')
    }
  })
})

describe('reminderSave', () => {
  test('a time trigger, a notify to the owner, one wait and one retry on a failed delivery', () => {
    const input = reminderSave({ text: ' Call Bo back ', when: '18:30' }, NOW)
    expect(input.name).toBe('Call Bo back')
    expect(input.definition.trigger).toEqual({ kind: 'time', at: local(2026, 11, 10, 18, 30) })
    const [remind, wait, retry] = input.definition.steps
    expect(remind).toMatchObject({
      id: 'remind',
      kind: 'notify',
      to: 'owner-of-run',
      text: 'Call Bo back',
      branches: [{ when: 'failed', goto: 'retry-wait' }],
    })
    expect(wait).toMatchObject({ kind: 'wait', durationMs: RETRY_AFTER_MS, next: 'retry' })
    expect(RETRY_AFTER_MS).toBe(10 * MS_MINUTE)
    expect(retry).toMatchObject({ id: 'retry', kind: 'notify', text: 'Call Bo back' })
    expect(input.definition.limits.maxRunsPerDay).toBe(3)
  })

  test('an empty text, and a text the contract refuses (a template marker), are refused before any call', () => {
    expect(() => reminderSave({ text: '  ', when: '18:30' }, NOW)).toThrow('enter what to remind')
    expect(() => reminderSave({ text: 'hi {{name}}', when: '18:30' }, NOW)).toThrow()
  })
})
