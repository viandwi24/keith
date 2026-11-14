/**
 * M3 gate, part 1 (docs/plans/done/P4-m3-node-motor.md "M3 gate"): pairing, the WebSocket
 * connection and the approval flow of `motor_remote`, on the real core over a real socket with
 * scripted models and a fake node. Part 2 (policy, cancel, limits, revoke, core node):
 * `motor.e2e.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  JoinResponseSchema,
  NodeSchema,
  PairingCodeSchema,
  PROTOCOL_VERSION,
  parseBrainEvent,
} from '@keith/contracts'
import { boot, cleanup, messagesOf, newDir, stop, tasksOf, textOf } from './testing/core-harness.ts'
import {
  answerApproval,
  ask,
  attentionItems,
  baseUrl,
  NODE_TIMING,
  pairAndConnect,
  scenario,
  shell,
  TASK_ID,
  waitForAttention,
} from './testing/scenario-harness.ts'
import { joinNode, manifestOf, pairNode, TestNode } from './testing/test-node.ts'
import { sleep, until } from './testing/wait.ts'

afterAll(cleanup)

const upgradeHeaders = (token?: string): Record<string, string> => ({
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-key': btoa('the sample nonce'), // RFC 6455 example key
  'sec-websocket-version': '13',
  ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
})

describe('M3 pairing', () => {
  test('nodes.pair gives a code for 10 minutes and the join command; /nodes/join needs no token', async () => {
    const r = await boot(newDir(), [], undefined, NODE_TIMING)
    const pair = PairingCodeSchema.parse(await r.client.rpc.nodes.pair())
    expect(pair.expiresAt - Date.now()).toBeGreaterThan(590_000)
    expect(pair.expiresAt - Date.now()).toBeLessThanOrEqual(600_000)
    expect(pair.joinCommand).toBe(
      `bun apps/node/src/main.ts join --core http://localhost:7420 --code ${pair.code}`,
    )
    // a person types the code in any case, with or without the dash
    const response = await joinNode(
      baseUrl(r),
      pair.code.toLowerCase().replace('-', ' '),
      manifestOf('laptop-e'),
    )
    expect(response.status).toBe(200)
    const creds = JoinResponseSchema.parse(await response.json())
    expect(creds.heartbeatMs).toBe(100)
    expect(creds.token).toStartWith('keith_node_')
    const nodes = (await r.client.rpc.nodes.list()).map((n) => NodeSchema.parse(n))
    expect(nodes.map((n) => [n.name, n.status])).toEqual([
      ['core', 'online'],
      ['laptop-e', 'offline'],
    ])
  })

  test('the same code twice is rejected, and so is a code that is not a code', async () => {
    const r = await boot(newDir(), [], undefined, NODE_TIMING)
    const { code } = await r.client.rpc.nodes.pair()
    expect((await joinNode(baseUrl(r), code, manifestOf('node-a'))).status).toBe(200)
    const again = await joinNode(baseUrl(r), code, manifestOf('node-b'))
    expect(again.status).toBe(400)
    expect(await again.text()).toContain('already used')
    const junk = await joinNode(baseUrl(r), 'IIII-OOOO', manifestOf('node-c'))
    expect(junk.status).toBe(400)
    expect((await r.client.rpc.nodes.list()).map((n) => n.name)).toEqual(['core', 'node-a'])
  })

  test('an expired code is rejected', async () => {
    const r = await boot(newDir(), [], undefined, { ...NODE_TIMING, pairingTtlMs: 60 })
    const { code } = await r.client.rpc.nodes.pair()
    await sleep(100)
    const response = await joinNode(baseUrl(r), code, manifestOf('laptop-e'))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('expired')
  })

  test('after 5 failed attempts the 6th is blocked, even with a good code', async () => {
    const r = await boot(newDir(), [], undefined, NODE_TIMING)
    const { code } = await r.client.rpc.nodes.pair()
    for (let i = 0; i < 5; i++) {
      expect((await joinNode(baseUrl(r), 'ABCD-EFGH', manifestOf('laptop-e'))).status).toBe(400)
    }
    const blocked = await joinNode(baseUrl(r), code, manifestOf('laptop-e'))
    expect(blocked.status).toBe(429)
    expect((await r.client.rpc.nodes.list()).length).toBe(1)
  })

  test('a taken name (or "core") is refused without spending the code; at most 3 codes wait', async () => {
    const r = await boot(newDir(), [], undefined, NODE_TIMING)
    const { code } = await r.client.rpc.nodes.pair()
    const reserved = await joinNode(baseUrl(r), code, manifestOf('core'))
    expect(reserved.status).toBe(409)
    expect((await joinNode(baseUrl(r), code, manifestOf('laptop-e'))).status).toBe(200)
    const taken = await r.client.rpc.nodes.pair()
    expect((await joinNode(baseUrl(r), taken.code, manifestOf('laptop-e'))).status).toBe(409)
    // the code of the refused join still works under another name
    expect((await joinNode(baseUrl(r), taken.code, manifestOf('laptop-f'))).status).toBe(200)
    await r.client.rpc.nodes.pair()
    await r.client.rpc.nodes.pair()
    await r.client.rpc.nodes.pair()
    await expect(r.client.rpc.nodes.pair()).rejects.toThrow(/three pairing codes/)
  })
})

describe('M3 connection and heartbeat', () => {
  test('a wrong or missing token is a 401 before any upgrade', async () => {
    const r = await boot(newDir(), [], undefined, NODE_TIMING)
    for (const token of [undefined, 'keith_node_wrong', r.token]) {
      const response = await fetch(new URL('/nodes/ws', r.server.url), {
        headers: upgradeHeaders(token),
      })
      expect(response.status).toBe(401)
    }
    const bad = new TestNode({ baseUrl: baseUrl(r), token: 'keith_node_wrong' })
    await expect(bad.connect()).rejects.toThrow()
  })

  test('a node on an old protocol version is told so and dropped', async () => {
    const r = await boot(newDir(), [], undefined, NODE_TIMING)
    const { code } = await r.client.rpc.nodes.pair()
    const creds = await pairNode(baseUrl(r), code, manifestOf('old-node'))
    const node = new TestNode({
      baseUrl: baseUrl(r),
      token: creds.token,
      name: 'old-node',
      version: 0,
    })
    const welcome = await node.connect()
    expect(welcome.accepted).toBe(false)
    expect(welcome.reason).toContain('below the minimum')
    await node.whenClosed()
    expect((await r.client.rpc.nodes.list()).find((n) => n.name === 'old-node')?.status).toBe(
      'offline',
    )
  })

  test('a connected node is online with its manifest; silence makes it offline; it can come back', async () => {
    const r = await boot(newDir(), [], undefined, NODE_TIMING)
    const node = await pairAndConnect(r, { name: 'laptop-e' })
    expect(node.welcome).toMatchObject({ accepted: true, heartbeatMs: 100 })
    const online = (await r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e')
    expect(online).toMatchObject({
      status: 'online',
      os: 'testos',
      arch: 'x64',
      capabilities: ['system.info', 'shell.exec'],
      allowShell: true,
    })
    // heartbeats keep it alive well past the timeout
    await sleep(900)
    expect((await r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e')?.status).toBe(
      'online',
    )
    node.stopHeartbeats()
    await until(
      'offline after the heartbeat timeout',
      async () => (await r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e')?.status,
      (status) => status === 'offline',
    )
    expect((await node.whenClosed()).code).toBe(4008)
    // the feed carries both changes
    const page = await r.client.harness.activity.page({ after: 0, limit: 500 })
    const states = page.events
      .filter((e) => e.type === 'node-changed')
      .map((e) => (e.payload as { node: { name: string; status: string } }).node)
      .filter((n) => n.name === 'laptop-e')
      .map((n) => n.status)
    expect(states).toEqual(['offline', 'online', 'offline'])
    // the same token reconnects
    const back = new TestNode({ baseUrl: baseUrl(r), token: node.token, name: 'laptop-e' })
    await back.connect()
    expect((await r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e')?.status).toBe(
      'online',
    )
  })

  test('a core restart leaves no node online until it connects again', async () => {
    const config = newDir()
    const r1 = await boot(config, [], undefined, NODE_TIMING)
    await pairAndConnect(r1, { name: 'laptop-e' })
    const token = r1.token
    await stop(r1)
    const r2 = await boot(config, [], token, NODE_TIMING)
    expect((await r2.client.rpc.nodes.list()).map((n) => [n.name, n.status])).toEqual([
      ['core', 'online'],
      ['laptop-e', 'offline'],
    ])
  })
})

describe('M3 approvals: motor_remote shell.exec', () => {
  test('denied: the item shows node and command, the node never receives the call, the model is told', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [
        { toolCalls: [shell('m1', 'laptop-e', 'echo keith-m3')] },
        { text: 'The owner refused the command; it was not run.' },
      ],
    })
    await ask(s.r)
    const [item] = await waitForAttention(s.r)
    expect(item).toMatchObject({
      kind: 'approval',
      toolName: 'motor_remote',
      sessionId: TASK_ID,
      agent: 'cortex.general',
      input: { node: 'laptop-e', capability: 'shell.exec', input: { command: 'echo keith-m3' } },
    })
    expect((await tasksOf(s.r.client))[0]?.status).toBe('waiting')

    await answerApproval(s.r, item as never, { approved: false, reason: 'not now' })
    await until(
      'task done',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'done',
    )
    expect(s.nodes['laptop-e']?.invokes).toEqual([])
    const last = s.workerPrompts().at(-1) ?? ''
    expect(last).toContain('not now')
    expect(last).not.toContain('keith-m3\\n')
    expect(await attentionItems(s.r)).toEqual([])

    const page = await s.r.client.harness.activity.page({ after: 0, limit: 500 })
    const wait = page.events.find((e) => e.type === 'brain.amygdala.wait')
    expect(parseBrainEvent(wait as never)).toMatchObject({
      type: 'brain.amygdala.wait',
      payload: { toolName: 'motor_remote', sessionId: TASK_ID, count: 1 },
    })
    const decide = page.events.filter((e) => e.type === 'brain.amygdala.decide')
    expect(decide.some((e) => (e.payload as { approved: boolean }).approved === false)).toBe(true)
  })

  test('approved: the node runs the command, the output reaches the worker and the report reaches the owner', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [
        { toolCalls: [shell('m1', 'laptop-e', 'echo keith-m3')] },
        { text: 'Result on laptop-e: keith-m3.' },
      ],
    })
    await ask(s.r)
    const [item] = await waitForAttention(s.r)
    expect(s.nodes['laptop-e']?.invokes).toEqual([])
    expect((await answerApproval(s.r, item as never, { approved: true })).status).toBe('resumed')
    await until(
      'task done',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'done',
    )
    const node = s.nodes['laptop-e'] as TestNode
    expect(node.commands).toEqual(['echo keith-m3'])
    expect(node.invokes[0]).toMatchObject({
      v: PROTOCOL_VERSION,
      type: 'invoke',
      capability: 'shell.exec',
    })
    expect(s.workerPrompts().at(-1)).toContain('keith-m3')
    await until('report relayed', async () =>
      (await messagesOf(s.r.client)).some((m) =>
        textOf(m).includes('Done: machine report received.'),
      ),
    )
    const tasks = await tasksOf(s.r.client)
    expect(tasks[0]?.summary).toContain('Result on laptop-e: keith-m3.')
  })

  test('remember for the session: the same node and capability is not asked again, another node is', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }, { name: 'desktop-b' }],
      worker: [
        { toolCalls: [shell('m1', 'laptop-e', 'echo satu')] },
        { toolCalls: [shell('m2', 'laptop-e', 'echo dua')] },
        { toolCalls: [shell('m3', 'desktop-b', 'echo tiga')] },
        { text: 'Done on two machines.' },
      ],
    })
    await ask(s.r)
    const [first] = await waitForAttention(s.r)
    expect(first?.input).toMatchObject({ node: 'laptop-e' })
    await answerApproval(s.r, first as never, { approved: true, remember: 'session' })
    // call 2 (same node, same capability) runs without asking; call 3 (another node) asks
    const [third] = await until(
      'the item of the other node',
      () => attentionItems(s.r),
      (items) =>
        items.length === 1 &&
        (items[0]?.input as { node?: string } | undefined)?.node === 'desktop-b',
    )
    expect(s.nodes['laptop-e']?.commands).toEqual(['echo satu', 'echo dua'])
    expect(s.nodes['desktop-b']?.commands).toEqual([])
    await answerApproval(s.r, third as never, { approved: true })
    await until(
      'task done',
      () => tasksOf(s.r.client),
      (t) => t[0]?.status === 'done',
    )
    expect(s.nodes['desktop-b']?.commands).toEqual(['echo tiga'])
    // the grant is not forever: a next session would ask again (scope is `<node>:<capability>`)
    const grants = JSON.stringify(await s.r.client.harness.activity.page({ after: 0, limit: 500 }))
    expect(grants).toContain('motor_remote')
  })
})
