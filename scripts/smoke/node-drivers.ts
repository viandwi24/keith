/**
 * P31.5.6 steps of the smoke test (docs/plans/active/P31-node-drivers-and-sandbox.md, phase 5): a node with the bundled
 * `desktop` driver whose backend is the fake one (`driver add desktop --option backend=fake`: no screen is touched), a
 * second driver folder that announces an unknown capability (`probe.ping`), `driver list`, a read through the front agent
 * (`desktop.info` is a read, so the owner is not asked), and nodes.list showing the refusal while the node stays online.
 *
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. The node is the real `keith-node` from this
 * checkout (`bun apps/node/src/main.ts ...`), started and stopped here. No toast is checked: the TUI is not running at this
 * point of the smoke (P31.5.4 covers the handler in unit tests). The read goes through the fake provider's
 * "desktop info on <node>" script (`scripts/smoke/fake-provider.ts`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeProvider } from './fake-provider.ts'
import { spawnChild, until } from './proc.ts'
import { cleanEnv } from './tui.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface NodeDriversContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  run(cmd: string[], env: Record<string, string>): Promise<Ran>
  tmp: string
  home: string
  coreUrl: string
  nodeBin: string[]
  provider: FakeProvider
  output(): string
}

interface NodeRow {
  name: string
  status: string
  capabilities: string[]
  drivers: Array<{ name: string }>
  refused: Array<{ id: string; reason: string }>
}

const NODE = 'desktop-node'
/** A driver folder whose one capability the core does not know: the core refuses it, the node stays online. */
const PROBE_MANIFEST = {
  manifestVersion: 1,
  name: 'probe',
  version: '0.1.0',
  entry: 'index.js',
  capabilities: [{ id: 'probe.ping', schemaVersion: 1 }],
  platforms: ['darwin', 'linux', 'win32'],
  needs: [],
}
const PROBE_ENTRY = `export default {
  name: 'probe',
  version: '0.1.0',
  capabilities: [{ id: 'probe.ping', schemaVersion: 1 }],
  invoke: async () => ({ ok: false, code: 'failed', message: 'the probe does nothing' }),
}
`

export async function nodeDriversSteps(c: NodeDriversContext): Promise<void> {
  const { coreUrl } = c
  const json = { 'content-type': 'application/json' }
  const bearer = (credential: string) => ({ authorization: `Bearer ${credential}`, ...json })
  const rpcJson = async <T>(
    credential: string,
    path: string,
    input: unknown = null,
  ): Promise<T> => {
    const res = await fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({ json: input }),
    })
    const body = await res.text()
    assert(res.status === 200, `${path} answered ${res.status}: ${body}`)
    return (JSON.parse(body) as { json: T }).json
  }

  const dir = join(c.tmp, 'node-drivers')
  const cfg = join(dir, 'node.json')
  const probeDir = join(dir, 'probe')
  const nodeEnv = cleanEnv({ HOME: c.home })
  const nodeCommand = (...args: string[]) => [...c.nodeBin, ...args, '--config', cfg]
  let owner = ''
  let node: ReturnType<typeof spawnChild> | undefined

  try {
    await c.step(
      'node-drivers driver: pair a node, add desktop (fake backend) and a probe driver',
      async () => {
        mkdirSync(dir, { recursive: true })
        const pairOut = await c.ok(c.admin('pair'), 'pair')
        const code = /pairing code ([A-Z0-9-]+)/.exec(pairOut)?.[1] ?? ''
        assert(code !== '', `no pairing code in:\n${pairOut}`)
        await c.ok(
          c.run(
            [
              ...c.nodeBin,
              'setup',
              '--non-interactive',
              '--core',
              coreUrl,
              '--code',
              code,
              '--name',
              NODE,
              '--workdir',
              join(dir, 'work'),
              '--config',
              cfg,
            ],
            nodeEnv,
          ),
          'desktop node setup',
        )
        const added = await c.ok(
          c.run(
            nodeCommand('driver', 'add', 'desktop', '--option', 'backend=fake', '--yes'),
            nodeEnv,
          ),
          'driver add desktop',
        )
        assert(added.includes('desktop.info'), `desktop add does not offer desktop.info:\n${added}`)
        assert(added.includes('backend=fake'), `the backend option is not recorded:\n${added}`)
        mkdirSync(probeDir, { recursive: true })
        writeFileSync(join(probeDir, 'keith-driver.json'), JSON.stringify(PROBE_MANIFEST))
        writeFileSync(join(probeDir, 'index.js'), PROBE_ENTRY)
        await c.ok(
          c.run(nodeCommand('driver', 'add', probeDir, '--yes'), nodeEnv),
          'driver add probe',
        )
        const listed = await c.ok(c.run(nodeCommand('driver', 'list'), nodeEnv), 'driver list')
        assert(
          listed.includes('desktop') && listed.includes('backend=fake'),
          `driver list:\n${listed}`,
        )
        assert(
          listed.includes('probe') && listed.includes('ok,'),
          `driver list lacks probe:\n${listed}`,
        )
      },
    )

    await c.step(
      'node-drivers node: the node runs the desktop driver and goes online',
      async () => {
        node = spawnChild('desktop-node', nodeCommand('run'), nodeEnv)
        const current = node
        await until(
          async () =>
            (await c.admin('nodes', 'list')).out
              .split('\n')
              .some((line) => line.includes(NODE) && line.includes('online')),
          20_000,
          'the desktop node online',
          () => `node output:\n${current.output()}\ncore output:\n${c.output()}`,
        )
      },
    )

    await c.step(
      'node-drivers refused: nodes.list keeps desktop.info and refuses probe.ping as unknown-capability',
      async () => {
        const token =
          /(keith_s_\S+)/.exec(
            await c.ok(c.admin('token', 'create', '--label', 'node-drivers'), 'token create'),
          )?.[1] ?? ''
        assert(token !== '', 'no owner credential')
        owner = token
        const rows = await rpcJson<NodeRow[]>(owner, 'nodes/list')
        const row = rows.find((r) => r.name === NODE)
        assert(row !== undefined, `the desktop node is not listed: ${JSON.stringify(rows)}`)
        assert(row.status === 'online', `the node is ${row.status}, expected online`)
        assert(
          row.drivers.some((d) => d.name === 'desktop'),
          `the node does not list the desktop driver: ${JSON.stringify(row.drivers)}`,
        )
        assert(
          row.capabilities.includes('desktop.info'),
          `desktop.info is not accepted: ${JSON.stringify(row.capabilities)}`,
        )
        assert(
          row.refused.some((r) => r.id === 'probe.ping' && r.reason === 'unknown-capability'),
          `probe.ping is not refused as unknown-capability: ${JSON.stringify(row.refused)}`,
        )
      },
    )

    await c.step(
      'node-drivers desktop.info: the front agent reads the fake display through the node',
      async () => {
        const who = await rpcJson<{ personId: string }>(owner, 'auth/whoami')
        const mark = c.provider.requests().length
        const res = await fetch(
          `${coreUrl}/sessions/${encodeURIComponent(`front:${who.personId}`)}/chat`,
          {
            method: 'POST',
            headers: bearer(owner),
            body: JSON.stringify({
              id: `front:${who.personId}`,
              trigger: 'submit-message',
              messages: [
                {
                  id: crypto.randomUUID(),
                  role: 'user',
                  parts: [{ type: 'text', text: `desktop info on ${NODE}` }],
                },
              ],
            }),
          },
        )
        assert(res.ok, `chat answered ${res.status}`)
        await res.text()
        // the worker's second model call carries the tool result: the fake backend's info names frontApp
        await until(
          () => c.provider.requests().slice(mark).join('\n').includes('frontApp'),
          15_000,
          'the desktop.info result in the provider requests',
          () => `node output:\n${node?.output()}\ncore output:\n${c.output()}`,
        )
      },
    )
  } finally {
    await node?.stop()
  }
}
