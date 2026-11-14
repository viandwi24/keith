import { describe, expect, test } from 'bun:test'
import { cells } from '@keith/ui'
import { alertCaption, shortenMiddle } from './home-caption.ts'

const plain = (text: string): string => text.replaceAll('`', '')

describe('alertCaption', () => {
  test('core down: the error alone in danger, no tip row', () => {
    const rows = alertCaption('core-down', 'http://127.0.0.1:7420', 100)
    expect(rows).toEqual([
      { text: '✕ Cannot reach the core at http://127.0.0.1:7420', tone: 'danger' },
    ])
  })

  test('logged out: Signed out, and the key that signs in with the core address', () => {
    const [a, b] = alertCaption('logged-out', 'https://mac.example.ts.net', 100)
    expect(a?.text).toBe('○ Signed out')
    expect(b?.text).toBe('Press `enter` to sign in to https://mac.example.ts.net')
  })

  test.each([60, 70, 80, 100])(
    'never wider than %i columns, at most four rows; logged out is the state row and the action rows',
    (columns) => {
      for (const kind of ['core-down', 'logged-out'] as const) {
        for (const core of [
          'unix:/Users/someone/.keith/core.sock',
          'http://127.0.0.1:7420',
          'https://very-long-machine-name.tailnet-1234.ts.net:7420',
        ]) {
          const rows = alertCaption(kind, core, columns)
          expect(rows.length).toBeGreaterThanOrEqual(kind === 'core-down' ? 1 : 2)
          expect(rows.length).toBeLessThanOrEqual(4)
          for (const r of rows) expect(cells(plain(r.text))).toBeLessThanOrEqual(columns)
        }
      }
    },
  )

  test('a long address wraps under the message: nothing is dropped, the words stay in order', () => {
    const core = 'https://very-long-machine-name.tailnet-1234.ts.net:7420'
    const rows = alertCaption('core-down', core, 60)
    expect(rows.length).toBe(2)
    expect(
      rows
        .map((r) => r.text)
        .join('')
        .replace(/\s/g, ''),
    ).toContain(core)
    expect(rows.at(-1)?.text.endsWith('…')).toBe(false)
  })

  test('the fourth row ends with an ellipsis when the text needs more', () => {
    const core = `https://${'a'.repeat(30)}.${'b'.repeat(30)}.${'c'.repeat(30)}.example:7420`
    const rows = alertCaption('core-down', core, 20)
    expect(rows).toHaveLength(4)
    expect(rows[3]?.text.endsWith('…')).toBe(true)
  })

  test('logged out: the enter key is marked on the row it starts in, the marks stay paired', () => {
    const rows = alertCaption('logged-out', 'https://x.example', 20)
    for (const r of rows) expect(r.text.split('`').length % 2).toBe(1)
  })
})

test('shortenMiddle keeps the ends and the width', () => {
  expect(shortenMiddle('http://127.0.0.1:7420', 30)).toBe('http://127.0.0.1:7420')
  const short = shortenMiddle('http://127.0.0.1:7420', 14)
  expect(cells(short)).toBe(14)
  expect(short.startsWith('http')).toBe(true)
  expect(short.endsWith(':7420')).toBe(true)
})
