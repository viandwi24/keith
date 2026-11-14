import { afterEach, describe, expect, test } from 'bun:test'
import { type ConnectionKind, connectionTone } from './connection-mark.tsx'
import { stripAnsi } from './orb/color.ts'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { TitleRow } from './title-row.tsx'

afterEach(cleanup)

const row = async (connection: ConnectionKind, depth: 'none' | '256') =>
  (
    await show(<TitleRow width={60} status={{ connection }} />, { depth, columns: 60, rows: 3 })
  ).frame()

describe('TitleRow connection', () => {
  test('the glyph tone follows the connection: green, yellow, red', () => {
    expect(connectionTone('live')).toBe('success')
    expect(connectionTone('connecting')).toBe('warning')
    expect(connectionTone('reconnecting')).toBe('warning')
    expect(connectionTone('offline')).toBe('danger')
    expect(connectionTone('logged-out')).toBe('danger')
  })

  test('with colour no word is shown in any state: the glyph colour says it', async () => {
    for (const kind of ['live', 'connecting', 'reconnecting', 'offline', 'logged-out'] as const) {
      const f = stripAnsi(await row(kind, '256'))
      expect(f).toContain('✳ K E I T H')
      for (const word of ['online', 'connecting', 'reconnecting', 'offline', 'logged out']) {
        expect(f).not.toContain(word)
      }
    }
  })

  test('without colour every state has its word', async () => {
    expect(await row('live', 'none')).toContain('online')
    expect(await row('offline', 'none')).toContain('offline')
    expect(await row('logged-out', 'none')).toContain('logged out')
    expect(await row('reconnecting', 'none')).toContain('reconnecting')
  })
})
