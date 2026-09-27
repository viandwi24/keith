import { describe, expect, test } from 'bun:test'
import { CORE_EVENT_NAMES, CORE_EVENT_NAMESPACES, EVENT_NAME_PATTERN } from './events.ts'
import { RESERVED_NAMESPACES } from './plugin.ts'

describe('core events', () => {
  test('every core event name follows the naming convention', () => {
    for (const name of CORE_EVENT_NAMES) expect(name).toMatch(EVENT_NAME_PATTERN)
  })

  test('every core event is in a core namespace', () => {
    for (const name of CORE_EVENT_NAMES) {
      expect(CORE_EVENT_NAMESPACES as readonly string[]).toContain(name.split('.')[0] ?? '')
    }
  })

  test('core event namespaces are reserved for plugins', () => {
    for (const ns of CORE_EVENT_NAMESPACES) expect(RESERVED_NAMESPACES as readonly string[]).toContain(ns)
  })

  test('the catalog matches the phase-1 rows of events.md', async () => {
    const doc = await Bun.file(new URL('../../../docs/contracts/events.md', import.meta.url)).text()
    const rows = doc
      .split('\n')
      .filter((l) => l.startsWith('| `') && l.trim().endsWith('| 1 |'))
      .map((l) => /^\| `([a-z_.]+)`/.exec(l)?.[1])
    expect([...rows].sort()).toEqual([...CORE_EVENT_NAMES].sort())
  })

  test('the naming pattern rejects commands and bad casing', () => {
    expect('weather.alert_raised').toMatch(EVENT_NAME_PATTERN)
    expect('Weather.alertRaised').not.toMatch(EVENT_NAME_PATTERN)
    expect('weather').not.toMatch(EVENT_NAME_PATTERN)
  })
})
