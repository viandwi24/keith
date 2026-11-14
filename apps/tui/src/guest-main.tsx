import { createGuestClient, type GuestClient } from '@keith/client'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { render, useApp, useWindowSize } from 'ink'
import { GuestScreen } from './features/guest/index.ts'
import { loadConfig } from './platform/config.ts'

/** The whole app of `keith --guest`: the guest screen, and the process ends when the visitor leaves. */
function GuestApp({ client, target }: { client: GuestClient; target: string }) {
  const { exit } = useApp()
  const size = useWindowSize()
  return (
    <GuestScreen
      client={client}
      columns={size.columns}
      rows={size.rows}
      target={target}
      onLeave={() => exit()}
    />
  )
}

/**
 * `keith --guest`: draw the guest screen full screen on the guest listener at `url` and return when the visitor
 * leaves. No login, no config file and no socket: the bearer lives inside the client object, in memory, and the
 * session is ended at the core on the way out (esc, `/quit`, ctrl+c).
 */
export async function runGuestScreen(url: string): Promise<number> {
  const { theme, depth } = loadConfig()
  const client = createGuestClient({ baseUrl: url })
  const app = render(
    <ThemeProvider theme={resolveTheme({ theme, depth })} spinner={depth !== 'none'}>
      <GuestApp client={client} target={url} />
    </ThemeProvider>,
    { alternateScreen: true, incrementalRendering: true },
  )
  try {
    await app.waitUntilExit()
  } finally {
    // ctrl+c exits Ink before the screen could end the chat: end it here (a no-op once ended)
    await Promise.race([client.end(), Bun.sleep(2000)])
  }
  return 0
}
