import type { ReactElement } from 'react'
import { resolveTheme } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import { render } from './render.ts'

export type Depth = 'none' | '16' | '256' | 'truecolor'

/** Render a component under a theme and give back the frame once layout settled. */
export async function show(
  node: ReactElement,
  {
    depth = 'none',
    columns = 60,
    rows = 30,
    spinner = false,
  }: {
    depth?: Depth
    columns?: number
    rows?: number
    spinner?: boolean
  } = {},
) {
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth })} spinner={spinner}>
      {node}
    </ThemeProvider>,
    { columns, rows },
  )
  await Bun.sleep(40)
  return { ...view, frame: () => view.lastFrame() ?? '' }
}
