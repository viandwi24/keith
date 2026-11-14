import { afterEach, describe, expect, test } from 'bun:test'
import { VRule } from './footer.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'
import { resolveTheme } from './theme.ts'

afterEach(cleanup)

const draw = async (depth: 'none' | '256' | 'truecolor') =>
  (await show(<VRule height={3} />, { depth, columns: 5, rows: 4 })).frame()

describe('VRule', () => {
  test('one column of │, as high as asked', async () => {
    const lines = (await draw('none')).split('\n').filter((l) => l !== '')
    expect(lines).toEqual(['│', '│', '│'])
  })

  test('NO_COLOR: no escape code at all', async () => {
    expect(await draw('none')).not.toContain('\u001b')
  })

  // the component passes `theme.fg('border')` as the colour props: assert what each depth gives
  test('colour: the border token of the frames (never the text colour)', () => {
    expect(resolveTheme({ theme: 'dark', depth: 'truecolor' }).fg('border')).toEqual({
      color: '#363b47',
    })
    expect(resolveTheme({ theme: 'dark', depth: '256' }).fg('border')).toEqual({
      color: 'ansi256(237)',
    })
    expect(resolveTheme({ theme: 'light', depth: '256' }).fg('border')).toEqual({
      color: 'ansi256(252)',
    })
  })

  test('NO_COLOR: the border token gives no colour prop', () => {
    expect(resolveTheme({ theme: 'dark', depth: 'none' }).fg('border')).toEqual({})
  })
})
