import { describe, expect, test } from 'bun:test'
import { CORE_EVENT_NAMES, CORE_EVENT_NAMESPACES, type CoreEventMap, EVENT_NAME_PATTERN } from './events.ts'
import { RESERVED_NAMESPACES } from './plugin.ts'

type EventRow = { name: string; fields: string[]; phase: number }

/** The rows of the "Core events" table: name, the `data` field names (sorted) and the phase. */
async function coreEventRows(): Promise<EventRow[]> {
  const doc = await Bun.file(new URL('../../../docs/contracts/events.md', import.meta.url)).text()
  const rows: EventRow[] = []
  for (const line of doc.split('\n')) {
    const m = /^\| `([a-z_.]+)` \| (.*) \| (\d+) \|\s*$/.exec(line)
    if (!m?.[1] || m[2] === undefined || !m[3]) continue
    const data = /`\{([^`]*)\}`/.exec(m[2])?.[1] ?? ''
    const fields = data
      .split(',')
      .map((f) => /^\s*([a-zA-Z]+)/.exec(f)?.[1])
      .filter((f): f is string => f !== undefined)
      .sort()
    rows.push({ name: m[1], fields, phase: Number(m[3]) })
  }
  return rows
}

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

  test('the catalog matches the rows of events.md', async () => {
    const rows = (await coreEventRows()).map((r) => r.name)
    expect([...rows].sort()).toEqual([...CORE_EVENT_NAMES].sort())
  })

  test('the phase-4 events have the payload fields events.md lists', async () => {
    const rows = await coreEventRows()
    const phase4 = rows.filter((r) => r.phase === 4)
    expect(phase4.map((r) => r.name).sort()).toEqual(['memory.reflected', 'thread.summarized'])
    // Compile-time: the payload types in CoreEventMap have exactly these keys.
    const reflected: Required<CoreEventMap['memory.reflected']> = {
      threadId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
      throughSeq: 1,
      written: 0,
      merged: 0,
      cardsUpdated: 0,
    }
    const summarized: Required<CoreEventMap['thread.summarized']> = {
      threadId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
      throughSeq: 1,
    }
    const byName = new Map(phase4.map((r) => [r.name, r.fields]))
    expect(byName.get('memory.reflected')).toEqual(Object.keys(reflected).sort())
    expect(byName.get('thread.summarized')).toEqual(Object.keys(summarized).sort())
  })

  test('the phase-5 events have the payload fields events.md lists', async () => {
    const rows = await coreEventRows()
    const phase5 = rows.filter((r) => r.phase === 5)
    expect(phase5.map((r) => r.name).sort()).toEqual(['thread.participant_joined', 'thread.participant_left'])
    expect(CORE_EVENT_NAMES).toContain('thread.participant_joined')
    expect(CORE_EVENT_NAMES).toContain('thread.participant_left')
    // Compile-time: the payload types in CoreEventMap have exactly these keys.
    const joined: Required<CoreEventMap['thread.participant_joined']> = {
      threadId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
      personId: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z',
      invitedBy: null,
    }
    const left: Required<CoreEventMap['thread.participant_left']> = {
      threadId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
      personId: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z',
    }
    const byName = new Map(phase5.map((r) => [r.name, r.fields]))
    expect(byName.get('thread.participant_joined')).toEqual(Object.keys(joined).sort())
    expect(byName.get('thread.participant_left')).toEqual(Object.keys(left).sort())
  })

  test('the naming pattern rejects commands and bad casing', () => {
    expect('weather.alert_raised').toMatch(EVENT_NAME_PATTERN)
    expect('Weather.alertRaised').not.toMatch(EVENT_NAME_PATTERN)
    expect('weather').not.toMatch(EVENT_NAME_PATTERN)
  })
})
