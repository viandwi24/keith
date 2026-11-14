/**
 * P26.4 steps of the smoke test (docs/plans/active/P26-data-lifecycle.md, phase 4): a node that floods the core is
 * rate limited (`node.rate_limited` in the audit log), a node token older than `KEITH_NODE_ROTATE_MS` is rotated at the
 * node's next connection (the node's config file changes, mode 0600), the old token is refused, and the node daemon
 * keeps working with the new token (it is online and an owner-approved shell command runs on it).
 *
 * Plain `fetch`, Bun's WebSocket and the real CLIs only: scripts import no workspace package. Tokens are never printed.
 *
 * What this cannot prove: the 201st message is not seen dropped directly (the audit row shows the budget was hit; the
 * exact count is in `rate-limit.test.ts`), and the 30 s overload close (4008) is not waited for (`gateway.test.ts`).
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './proc.ts'
import { FRESH_PIN } from './sign-in.ts'
import { cleanEnv } from './tui.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface NodeLimitsContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  run(cmd: string[], env: Record<string, string>, opts?: { stdin?: string }): Promise<Ran>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  tmp: string
  home: string
  coreUrl: string
  nodeBin: string[]
  /** The daemon of the smoke node (`smoke-node`) writes its rotated token here. */
  nodeConfig: string
  nodeName: string
  /** Stops the core, starts it again with `base` plus `extra`, and waits for /health. */
  restartCore(extra: Record<string, string>): Promise<void>
  context(fn: () => string): void
  output(): string
}

type WsCtor = new (url: string, options: { headers: Record<string, string> }) => WebSocket

interface Frame {
  type?: string
  accepted?: boolean
}

/** Opens a node socket with `token`; undefined when the core refuses the upgrade. */
async function openWith(
  url: string,
  token: string,
): Promise<{ ws: WebSocket; frames: Frame[] } | undefined> {
  const Socket = WebSocket as unknown as WsCtor
  const ws = new Socket(url, { headers: { Authorization: `Bearer ${token}` } })
  const frames: Frame[] = []
  ws.onmessage = (event) => {
    try {
      frames.push(JSON.parse(String(event.data)) as Frame)
    } catch {
      // not JSON: ignored
    }
  }
  const opened = await Promise.race([
    new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      ws.onerror = () => resolve(false)
      ws.onclose = () => resolve(false)
    }),
    Bun.sleep(5_000).then(() => false),
  ])
  if (!opened) {
    ws.close()
    return undefined
  }
  return { ws, frames }
}

export async function nodeLimitsSteps(c: NodeLimitsContext): Promise<void> {
  const { coreUrl } = c
  const wsUrl = `${coreUrl.replace(/^http/, 'ws')}/nodes/ws`
  const nodeEnv = cleanEnv({ HOME: c.home })
  const readToken = (): string | undefined => {
    try {
      return (JSON.parse(readFileSync(c.nodeConfig, 'utf8')) as { token?: string }).token
    } catch {
      return undefined
    }
  }
  const attention = async (credential: string) =>
    (
      (await (
        await fetch(`${coreUrl}/attention`, {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).json()) as {
        items: Array<{ id: string; sessionId: string; toolName?: string; kind: string }>
      }
    ).items
  const online = async (): Promise<boolean> =>
    (await c.admin('nodes', 'list')).out
      .split('\n')
      .some((line) => line.includes(c.nodeName) && line.includes('online'))

  await c.step(
    'flood: a node sending 260 messages in a burst is rate limited (audit node.rate_limited)',
    async () => {
      const floodConfig = join(c.tmp, 'flood.json')
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
            'smoke-flood',
            '--workdir',
            join(c.tmp, 'flood-work'),
            '--config',
            floodConfig,
          ],
          nodeEnv,
        ),
        'flood node setup',
      )
      const token = (JSON.parse(readFileSync(floodConfig, 'utf8')) as { token: string }).token
      const socket = await openWith(wsUrl, token)
      assert(socket !== undefined, 'the flood node could not open its socket')
      const { ws, frames } = socket
      ws.send(
        JSON.stringify({
          v: 2,
          type: 'hello',
          manifest: {
            name: 'smoke-flood',
            os: 'darwin',
            arch: 'arm64',
            version: 'smoke',
            capabilities: ['system.info'],
            policy: { allowShell: false },
          },
        }),
      )
      await until(
        () => frames.some((f) => f.type === 'welcome' && f.accepted === true),
        5_000,
        'welcome',
      )
      const heartbeat = JSON.stringify({ v: 2, type: 'heartbeat', at: Date.now() })
      for (let i = 0; i < 260; i++) ws.send(heartbeat)
      await until(
        async () => (await c.admin('audit', '--limit', '300')).out.includes('node.rate_limited'),
        15_000,
        'the node.rate_limited audit row',
        c.output,
      )
      ws.close()
    },
  )

  let before = ''
  await c.step(
    'rotation: a token older than KEITH_NODE_ROTATE_MS is replaced after the welcome',
    async () => {
      before = readToken() ?? ''
      assert(
        before.startsWith('keith_node_'),
        'the smoke node has no node token in its config file',
      )
      await c.restartCore({ KEITH_NODE_ROTATE_MS: '2000' })
      await until(
        () => {
          const now = readToken()
          return now !== undefined && now !== before
        },
        40_000,
        'the node config file to hold a new token',
        c.output,
      )
      assert(
        (statSync(c.nodeConfig).mode & 0o777) === 0o600,
        'the rotated node.json is not mode 0600',
      )
      await until(online, 20_000, 'the node online after the rotation', c.output)
      assert(readToken() !== before, 'the rotated token is the old one')
    },
  )

  await c.step(
    'rotation: the old token is refused, the node keeps working with the new one',
    async () => {
      // the old hash stops matching when core commits the rotation (on `rotated`, a moment after the file changes)
      await until(
        async () => {
          const socket = await openWith(wsUrl, before)
          if (socket === undefined) return true
          socket.ws.close()
          return false
        },
        15_000,
        'the old token to be refused',
        c.output,
      )
      assert(await online(), 'the node is not online after the rotation')
      // a fresh owner credential: the identity-access offline password setup revoked the older one
      const created = /(keith_s_\S+)/.exec(
        await c.ok(c.admin('token', 'create', '--label', 'node-limits'), 'token create'),
      )?.[1]
      assert(created !== undefined, 'no owner credential')
      const owner = created
      // an owner-approved shell command runs on the node through the socket it opened with the new token
      // the owner PIN was changed by sign-in (FRESH_PIN); identity-access steps up with it too
      const stepped = await fetch(`${coreUrl}/auth/step-up`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
        body: JSON.stringify({ pin: FRESH_PIN }),
      })
      assert(stepped.status === 200, `step-up of the owner token answered ${stepped.status}`)
      const headers = {
        authorization: `Bearer ${owner}`,
        'content-type': 'application/json',
      }
      const chat = await fetch(`${coreUrl}/sessions/${encodeURIComponent('front:owner')}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'front:owner',
          trigger: 'submit-message',
          messages: [
            {
              id: crypto.randomUUID(),
              role: 'user',
              parts: [{ type: 'text', text: `run echo smoke on ${c.nodeName}` }],
            },
          ],
        }),
      })
      assert(chat.ok, `chat answered ${chat.status}`)
      await chat.text()
      let item: { id: string; sessionId: string } | undefined
      await until(
        async () => {
          item = (await attention(owner)).find((i) => i.kind === 'approval')
          return item !== undefined
        },
        25_000,
        'an approval for the shell command',
        c.output,
      )
      const answer = await fetch(`${coreUrl}/attention/${item?.id}/answer`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: item?.sessionId,
          answer: { kind: 'approval', approved: true },
        }),
      })
      if (!answer.ok)
        throw new Error(`approve answered HTTP ${answer.status} ${await answer.text()}`)
      await until(
        async () => (await attention(owner)).length === 0,
        15_000,
        'the approval to leave /attention',
        c.output,
      )
      // the approval reached the core for the rotated node: the audit row names the node and the command
      // (P23.3.4); the command's output sits in a worker session that the smoke cannot read back, so the
      // proof that the node runs it is the live socket below (the approved call left /attention and the node is online)
      const audit = (await c.ok(c.admin('audit', '--limit', '300'), 'audit')).split('\n')
      assert(
        audit.some(
          (line) =>
            line.includes('approval.answered') &&
            line.includes(c.nodeName) &&
            line.includes('echo smoke'),
        ),
        `no approval.answered audit row names ${c.nodeName} and "echo smoke"`,
      )
      const nodes = (await c.ok(c.admin('nodes', 'list'), 'nodes list')).split('\n')
      assert(
        nodes.some((line) => line.includes(c.nodeName) && line.includes('online')),
        `the node ${c.nodeName} is not online after the approved command`,
      )
    },
  )
}
