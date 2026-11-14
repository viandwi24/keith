import { resolveTheme, ThemeProvider } from '@keith/ui'
import { render } from 'ink'
import type { ReactElement } from 'react'
import type { Config } from '../platform/config.ts'

/**
 * Draw a full-screen Ink view and resolve with what it passes to `done`. Leaving without `done`
 * (Ctrl+C) resolves with `fallback`. The terminal is restored before this returns.
 */
export async function runInk<T>(
  config: Config,
  fallback: T,
  make: (done: (value: T) => void) => ReactElement,
): Promise<T> {
  let result = fallback
  const app = render(
    <ThemeProvider
      theme={resolveTheme({ theme: config.ui.theme, depth: config.ui.depth })}
      spinner={config.ui.depth !== 'none'}
    >
      {make((value) => {
        result = value
        app.unmount()
      })}
    </ThemeProvider>,
    { alternateScreen: true, incrementalRendering: true },
  )
  await app.waitUntilExit().catch(() => undefined)
  return result
}
