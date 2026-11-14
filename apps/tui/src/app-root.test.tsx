import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeithClient } from '@keith/client'
import { createKeithClient, writeClientConfig } from '@keith/client'
import { render } from '@keith/ui/testing'
import { App, type AppProps } from './app.tsx'
import { AppRoot } from './app-root.tsx'
import type { Connection, SwitchOptions } from './connection.ts'
import { type FakeCore, startFakeCore } from './testing/fake-core.ts'
import { frameUntil } from './testing/ink.ts'

const cores: FakeCore[] = []
afterEach(() => {
  for (const core of cores.splice(0)) core.stop()
})

const start = (name: string): FakeCore => {
  const core = startFakeCore({
    whoami: { name },
    rpc: {
      'health/get': () => ({ status: 'ok', version: '0.0.0', sha: 'abc1234', boot: 'b' }),
      'models/roles/get': () => ({ front: null, cortex: null }),
      'tasks/list': () => [],
      'nodes/list': () => [],
      'auth/logout': () => ({}),
    },
  })
  cores.push(core)
  return core
}

const conn = (core: FakeCore): Connection => ({
  kind: 'http',
  url: core.url,
  token: 't',
  source: 'flag',
})

const until = async (check: () => boolean, what: string): Promise<void> => {
  const begun = Date.now()
  while (!check()) {
    if (Date.now() - begun > 15_000) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(15)
  }
}

describe('AppRoot', () => {
  test('a swap rebuilds the app on the new client: the old feed stops and nothing of it stays', async () => {
    const a = start('Ana')
    const b = start('Bia')
    const built: string[] = []
    const makeClient = (c: Connection): KeithClient => {
      built.push(c.kind === 'http' ? c.url : c.path)
      return createKeithClient({ baseUrl: (c as { url: string }).url, token: 't' })
    }
    let swap: AppProps['switchConnection']
    const Probe = (props: AppProps) => {
      swap = props.switchConnection
      return <App {...props} />
    }
    const view = render(
      <AppRoot
        connection={conn(a)}
        makeClient={makeClient}
        component={Probe}
        start="home"
        columns={100}
        rows={30}
        brain={{ fadeMs: 400, tickMs: 20 }}
      />,
      { columns: 100, rows: 30 },
    )
    await until(() => a.streams() > 0, 'the first activity stream')
    await until(() => a.seen.includes('POST /rpc/auth/whoami'), 'whoami on the first core')
    expect(built).toEqual([a.url])

    const options: SwitchOptions = { notice: 'signed in as Bia' }
    swap?.(conn(b), options)
    await frameUntil(view.lastFrame, (f) => f.includes('signed in as Bia'))
    expect(built).toEqual([a.url, b.url])
    // the old tree is gone: its feed closed, the new one is open on the other core
    await until(() => a.streams() === 0, 'the old stream to close')
    await until(() => b.streams() > 0, 'the new activity stream')
    await until(() => b.seen.includes('POST /rpc/auth/whoami'), 'whoami on the new core')
    // nothing talks to the old core after the swap
    const seen = a.seen.length
    await Bun.sleep(300)
    expect(a.seen.length).toBe(seen)
    view.unmount()
  })

  describe('quitting', () => {
    const logouts = (core: FakeCore) => core.seen.filter((l) => l === 'POST /rpc/auth/logout')
    const session = (core: FakeCore, token: string): Connection => ({
      kind: 'http',
      url: core.url,
      token,
      source: 'session',
    })
    async function quit(
      core: FakeCore,
      connection: Connection,
      configPath?: string,
    ): Promise<void> {
      const view = render(
        <AppRoot
          connection={connection}
          start="home"
          columns={100}
          rows={30}
          brain={{ fadeMs: 400, tickMs: 20 }}
          {...(configPath === undefined ? {} : { configPath })}
        />,
        { columns: 100, rows: 30 },
      )
      await until(() => core.seen.includes('POST /rpc/auth/whoami'), 'whoami')
      view.unmount()
      await Bun.sleep(300)
    }

    test('a memory-only credential is revoked once on quit', async () => {
      const core = start('Ana')
      const dir = mkdtempSync(join(tmpdir(), 'keith-quit-'))
      await quit(core, session(core, 'memory-only'), join(dir, 'c.json'))
      expect(logouts(core)).toHaveLength(1)
    })

    test('a remembered credential and a flag credential are never revoked', async () => {
      const core = start('Ana')
      const dir = mkdtempSync(join(tmpdir(), 'keith-quit-'))
      const path = join(dir, 'client.json')
      writeClientConfig({ core: core.url, token: 'kept', remember: true }, path)
      await quit(core, session(core, 'kept'), path)
      expect(logouts(core)).toHaveLength(0)
      await quit(core, conn(core), path)
      expect(logouts(core)).toHaveLength(0)
    })
  })
})
