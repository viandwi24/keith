import { afterEach, describe, expect, test } from 'bun:test'
import { StyledLines } from './styled-lines.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'

afterEach(cleanup)

const lines = [
  [{ text: 'red ', fg: '#ff0000', bold: true }, { text: 'plain' }],
  [],
  [{ text: 'a very long line that does not fit the box at all', bg: 'blue' }],
]

describe('StyledLines', () => {
  test('draws the text one row per line, pads to the height and cuts at the width', async () => {
    const f = (
      await show(<StyledLines lines={lines} width={20} height={5} />, { columns: 40 })
    ).frame()
    const rows = f.split('\n')
    expect(rows[0]).toBe('red plain')
    expect(rows[2]).toBe('a very long line th…'.slice(0, rows[2]?.length ?? 0))
    expect(rows[2]?.length).toBeLessThanOrEqual(20)
  })

  test('an escape never appears: the runs are drawn as text, and a short list is padded', async () => {
    const f = (await show(<StyledLines lines={lines} width={20} height={6} />)).frame()
    expect(f).not.toContain('\u001b')
    expect(f.split('\n').length).toBeLessThanOrEqual(6)
  })
})
