import { describe, expect, test } from 'bun:test'
import { KeithError } from '@keith/sdk'
import { parseConfig } from './load.ts'

function caught(fn: () => unknown): KeithError {
  try {
    fn()
  } catch (error) {
    if (error instanceof KeithError) return error
    throw error
  }
  throw new Error('expected a throw')
}

describe('[memory.reflect], [memory.summary] and [mind.reminder] (phase 4)', () => {
  test('an empty file gives every default', () => {
    const c = parseConfig({}, { env: {} })
    expect(c.memory).toEqual({
      coreMaxChars: 1_500,
      reflect: { enabled: true, idleMinutes: 20, maxMessages: 200, cardMaxChars: 1_000 },
      summary: { enabled: true, minMessages: 20, maxChars: 2_000 },
    })
    expect(c.mind.reminder).toEqual({ maxPerPerson: 50 })
  })

  test('every key can be set', () => {
    const memory = {
      coreMaxChars: 900,
      reflect: { enabled: false, idleMinutes: 0.25, maxMessages: 50, cardMaxChars: 400 },
      summary: { enabled: false, minMessages: 5, maxChars: 800 },
    }
    const c = parseConfig({ memory, mind: { reminder: { maxPerPerson: 3 } } }, { env: {} })
    expect(c.memory).toEqual(memory)
    expect(c.mind.reminder.maxPerPerson).toBe(3)
  })

  test('KEITH__ overrides reach the new keys, fractions included', () => {
    const c = parseConfig(
      {},
      {
        env: {
          KEITH__MEMORY__REFLECT__IDLEMINUTES: '0.5',
          KEITH__MEMORY__SUMMARY__ENABLED: 'false',
          KEITH__MIND__REMINDER__MAXPERPERSON: '7',
        },
      },
    )
    expect(c.memory.reflect.idleMinutes).toBe(0.5)
    expect(c.memory.summary.enabled).toBe(false)
    expect(c.mind.reminder.maxPerPerson).toBe(7)
  })

  test('idleMinutes = 0 and minMessages = 0 are CONFIG_INVALID', () => {
    const idle = caught(() => parseConfig({ memory: { reflect: { idleMinutes: 0 } } }, { env: {} }))
    expect(idle.code).toBe('CONFIG_INVALID')
    expect(idle.message).toContain('memory.reflect.idleMinutes')
    const min = caught(() => parseConfig({ memory: { summary: { minMessages: 0 } } }, { env: {} }))
    expect(min.code).toBe('CONFIG_INVALID')
    expect(min.message).toContain('memory.summary.minMessages')
  })

  test('unknown keys and invalid values are errors naming the key', () => {
    expect(caught(() => parseConfig({ memory: { reflect: { model: 'x' } } }, { env: {} })).message).toContain(
      'memory.reflect.model',
    )
    expect(
      caught(() => parseConfig({ memory: { summary: { maxChars: 1.5 } } }, { env: {} })).message,
    ).toContain('memory.summary.maxChars')
    expect(
      caught(() => parseConfig({ mind: { reminder: { maxPerPerson: 0 } } }, { env: {} })).message,
    ).toContain('mind.reminder.maxPerPerson')
  })
})
