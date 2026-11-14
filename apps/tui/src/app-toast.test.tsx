import { afterEach, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { cleanup, manualScheduler, render } from '@keith/ui/testing'
import { App, type AppProps } from './app.tsx'
import { AppRoot } from './app-root.tsx'
import type { Connection } from './connection.ts'
import { type FakeCore, startFakeCore } from './testing/fake-core.ts'
import { frameUntil } from './testing/ink.ts'

let core: FakeCore | undefined
afterEach(() => {
  cleanup()
  core?.stop()
  core = undefined
})

describe('the sign-in toast', () => {
  test('a swap notice is a toast at the top right, not Home caption, and goes after 5 s', async () => {
    core = startFakeCore({ whoami: { name: 'Ana' } })
    const conn: Connection = { kind: 'http', url: core.url, token: 't', source: 'flag' }
    const sched = manualScheduler()
    let swap: AppProps['switchConnection']
    const Probe = (props: AppProps) => {
      swap = props.switchConnection
      return <App {...props} />
    }
    const view = render(
      <AppRoot
        connection={conn}
        makeClient={(c) => createKeithClient({ baseUrl: (c as { url: string }).url, token: 't' })}
        component={Probe}
        scheduler={sched}
        motion={{ intro: false, idleHideSeconds: 0, reduced: true, orbStatic: false }}
        columns={100}
        rows={30}
      />,
      { columns: 100, rows: 30 },
    )
    await frameUntil(view.lastFrame, (f) => f.includes('K E I T H'))
    swap?.(conn, { notice: 'signed in as Ana' })
    const f = await frameUntil(view.lastFrame, (x) => x.includes('signed in as Ana'))
    const rows = f.split('\n')
    const at = rows.findIndex((r) => r.includes('signed in as Ana'))
    // below the title row, which holds the connection mark
    expect(at).toBe(2)
    const row = rows[at] ?? ''
    expect(row.trimEnd().length).toBeGreaterThan(80)
    expect(f).toContain('✓')
    sched.advance(5100)
    await frameUntil(view.lastFrame, (x) => !x.includes('signed in as Ana'))
    view.unmount()
  })
})
