/**
 * M3 gate, part 2: node policy, system.info without approval, cancel, timeout, output cap,
 * revoke, and the node `core` through the same path. Part 1 (pairing, connection, approvals):
 * `node-pairing.e2e.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { cleanup, tasksOf } from './testing/core-harness.ts'
import {
  answerApproval,
  ask,
  attentionItems,
  baseUrl,
  motorCall,
  pairAndConnect,
  scenario,
  shell,
  TASK_ID,
  waitForAttention,
} from './testing/scenario-harness.ts'
import { sleep, until } from './testing/wait.ts'

afterAll(cleanup)

const done = (s: Awaited<ReturnType<typeof scenario>>) =>
  until(
    'task done',
    () => tasksOf(s.r.client),
    (t) => t[0]?.status === 'done',
  )

/** Ask, wait for the approval item and approve it. */
async function approveOne(s: Awaited<ReturnType<typeof scenario>>): Promise<void> {
  await ask(s.r)
  const [item] = await waitForAttention(s.r)
  await answerApproval(s.r, item as never, { approved: true })
}

describe('M3 node policy and capabilities', () => {
  test('allowShell false: shell is denied at once, the owner is never asked, the node is not reached', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e', allowShell: false }],
      worker: [{ toolCalls: [shell('m1', 'laptop-e', 'echo nope')] }, { text: 'Node refused.' }],
    })
    await ask(s.r)
    await done(s)
    expect(await attentionItems(s.r)).toEqual([])
    expect(s.nodes['laptop-e']?.commands).toEqual([])
    expect(s.workerPrompts().at(-1)).toContain(
      'node laptop-e does not allow shell; rejoin with --allow-shell',
    )
  })

  test('system.info runs with no approval at all', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [
        { toolCalls: [motorCall('m1', 'laptop-e', 'system.info')] },
        { text: 'Mesinnya fake-node.' },
      ],
    })
    await ask(s.r)
    await done(s)
    expect(s.nodes['laptop-e']?.invokes.map((i) => i.capability)).toEqual(['system.info'])
    expect(s.workerPrompts().at(-1)).toContain('fake-node')
    expect(await attentionItems(s.r)).toEqual([])
    const page = await s.r.client.harness.activity.page({ after: 0, limit: 500 })
    expect(page.events.some((e) => e.type === 'brain.amygdala.wait')).toBe(false)
  })

  test('readable results, no throw: unknown node, unknown capability, offline node, bad input', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }, { name: 'gone-node' }],
      worker: [
        {
          toolCalls: [
            motorCall('u1', 'nowhere', 'system.info'),
            motorCall('u2', 'laptop-e', 'camera.snap'),
            motorCall('u3', 'gone-node', 'system.info'),
            motorCall('u4', 'laptop-e', 'shell.exec', { cmd: 'oops' }),
          ],
        },
        { text: 'All failed with a clear message.' },
      ],
    })
    s.nodes['gone-node']?.close()
    await until(
      'gone-node offline',
      async () => (await s.r.client.rpc.nodes.list()).find((n) => n.name === 'gone-node')?.status,
      (status) => status === 'offline',
    )
    await ask(s.r)
    // an unknown capability is denied by policy (never asks); the bad input is a model-visible
    // error only after approval, so approve it when it shows up
    const items = await until(
      'bad-input item',
      () => attentionItems(s.r),
      (i) => i.length >= 1,
      2000,
    ).catch(() => [])
    for (const item of items) await answerApproval(s.r, item, { approved: true })
    await done(s)
    const last = s.workerPrompts().at(-1) ?? ''
    expect(last).toContain('no node \\"nowhere\\" (known: core, laptop-e, gone-node)')
    expect(last).toContain('unknown capability camera.snap')
    expect(last).toContain('node gone-node is offline')
    expect(last).toContain('invalid input for shell.exec: command: ')
    expect(s.nodes['laptop-e']?.invokes).toEqual([])
  })
})

describe('M3 cancel, timeout and limits', () => {
  test('tasks.stop while a long command runs: the node gets cancel and the task is stopped', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [{ toolCalls: [shell('m1', 'laptop-e', 'hang')] }, { text: 'waiting' }],
    })
    await approveOne(s)
    const node = s.nodes['laptop-e']
    await until(
      'command started on the node',
      () => node?.invokes.length,
      (n) => n === 1,
    )
    expect(node?.cancels).toEqual([])
    await s.r.client.rpc.tasks.stop({ id: TASK_ID })
    await until(
      'cancel received',
      () => node?.cancels.length,
      (n) => n === 1,
    )
    expect(node?.cancels[0]).toBe(node?.invokes[0]?.callId)
    const [task] = await tasksOf(s.r.client)
    expect(task?.status).toBe('stopped')
  })

  test('tasks.stop on a task parked on a shell approval denies it: the node never gets the command, the row stays stopped', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-f' }],
      worker: [{ toolCalls: [shell('m9', 'laptop-f', 'rm -rf build')] }, { text: 'after' }],
    })
    await ask(s.r)
    await waitForAttention(s.r)
    await s.r.client.rpc.tasks.stop({ id: TASK_ID })
    await until(
      'the parked approval is gone',
      () => attentionItems(s.r).then((items) => items.length),
      (n) => n === 0,
    )
    // a late turn end of the cancelled worker must not record anything else
    await sleep(100)
    expect(s.nodes['laptop-f']?.invokes).toEqual([])
    const [task] = await tasksOf(s.r.client)
    expect(task?.status).toBe('stopped')
  })

  test('a command past its time limit ends as a timeout result, and the node is told to cancel', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [
        { toolCalls: [shell('m1', 'laptop-e', 'silent', { timeoutMs: 200 })] },
        { text: 'Command timed out.' },
      ],
    })
    await approveOne(s)
    await done(s)
    const node = s.nodes['laptop-e']
    expect(node?.invokes[0]?.timeoutMs).toBe(200)
    expect(node?.cancels).toEqual([node?.invokes[0]?.callId as string])
    expect(s.workerPrompts().at(-1)).toContain('timeout')
  })

  test('big output is capped three ways: the node at 30 000 (15 000 head + 15 000 tail), the agent toolOutput at 20 000, head and tail kept', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [{ toolCalls: [shell('m1', 'laptop-e', 'big')] }, { text: 'Big output.' }],
    })
    await approveOne(s)
    await done(s)
    const last = s.workerPrompts().at(-1) ?? ''
    expect(last).toContain('HEAD')
    expect(last).toContain('TAIL')
    // the agent's own toolOutput cap (20 000) cuts the middle, where the node's marker sat
    expect(last).toContain('originalChars')
    expect(last.length).toBeLessThan(26_000)
  })

  test('progress of a running command is streamed as preliminary output, the last value is the result', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [{ toolCalls: [shell('m1', 'laptop-e', 'progress')] }, { text: 'Done.' }],
    })
    await approveOne(s)
    await done(s)
    expect(s.workerPrompts().at(-1)).toContain('step 2')
    expect(s.workerPrompts().at(-1)).not.toContain('"running":true')
  })
})

describe('M3 revoke', () => {
  test('nodes.revoke closes the socket and the token is no good afterwards', async () => {
    const s = await scenario({ nodes: [{ name: 'laptop-e' }] })
    const node = s.nodes['laptop-e']
    const { id } = (await s.r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e') ?? {
      id: '',
    }
    await expect(s.r.client.rpc.nodes.revoke({ id: 'core' })).rejects.toThrow(/cannot be revoked/)
    await expect(s.r.client.rpc.nodes.revoke({ id: 'nope' })).rejects.toThrow(/no node/)
    await s.r.client.rpc.nodes.revoke({ id })
    expect((await node?.whenClosed())?.code).toBe(4003)
    expect((await s.r.client.rpc.nodes.list()).map((n) => n.name)).toEqual(['core'])
    const response = await fetch(new URL('/nodes/ws', baseUrl(s.r)), {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': btoa('the sample nonce'), // RFC 6455 example key
        'sec-websocket-version': '13',
        authorization: `Bearer ${node?.token}`,
      },
    })
    expect(response.status).toBe(401)
    // the name is free again
    await pairAndConnect(s.r, { name: 'laptop-e' })
    expect((await s.r.client.rpc.nodes.list()).map((n) => n.name)).toEqual(['core', 'laptop-e'])
  })

  test('a call in flight when the node is revoked fails with a readable result', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [{ toolCalls: [shell('m1', 'laptop-e', 'hang')] }, { text: 'Node dicabut.' }],
    })
    await approveOne(s)
    await until(
      'command started',
      () => s.nodes['laptop-e']?.invokes.length,
      (n) => n === 1,
    )
    const node = (await s.r.client.rpc.nodes.list()).find((n) => n.name === 'laptop-e')
    await s.r.client.rpc.nodes.revoke({ id: node?.id ?? '' })
    await done(s)
    expect(s.workerPrompts().at(-1)).toContain('node revoked')
  })

  test('a connection that drops mid-call fails the call with "node disconnected"', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      worker: [{ toolCalls: [shell('m1', 'laptop-e', 'hang')] }, { text: 'Connection lost.' }],
    })
    await approveOne(s)
    await until(
      'command started',
      () => s.nodes['laptop-e']?.invokes.length,
      (n) => n === 1,
    )
    s.nodes['laptop-e']?.close()
    await done(s)
    expect(s.workerPrompts().at(-1)).toContain('node disconnected')
  })
})

describe('M3 the node core', () => {
  test('motor_remote to core works through the same path when shell is allowed', async () => {
    const s = await scenario({
      env: { KEITH_CORE_ALLOW_SHELL: 'true', PATH: process.env.PATH ?? '/usr/bin:/bin' },
      worker: [
        { toolCalls: [motorCall('m0', 'core', 'system.info')] },
        { toolCalls: [shell('m1', 'core', 'echo core-ok')] },
        { text: 'Core menjawab core-ok.' },
      ],
    })
    expect((await s.r.client.rpc.nodes.list())[0]).toMatchObject({
      name: 'core',
      status: 'online',
      allowShell: true,
    })
    await ask(s.r)
    const [item] = await waitForAttention(s.r)
    expect(item?.input).toMatchObject({ node: 'core', capability: 'shell.exec' })
    await answerApproval(s.r, item as never, { approved: true })
    await done(s)
    const last = s.workerPrompts().at(-1) ?? ''
    expect(last).toContain('core-ok')
    expect(last).toContain('memoryTotalBytes')
  })

  test('core refuses shell by default (KEITH_CORE_ALLOW_SHELL off), without asking', async () => {
    const s = await scenario({
      worker: [{ toolCalls: [shell('m1', 'core', 'echo no')] }, { text: 'Core refused.' }],
    })
    await ask(s.r)
    await done(s)
    expect(await attentionItems(s.r)).toEqual([])
    expect(s.workerPrompts().at(-1)).toContain('KEITH_CORE_ALLOW_SHELL')
  })
})

describe('M3 the front agent', () => {
  test('nodes_status shows the machines and their state to the front agent', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e', allowShell: false }],
      front: [
        { toolCalls: [{ toolName: 'nodes_status', toolCallId: 'n1', input: {} }] },
        { text: 'laptop-e online, without shell.' },
      ],
    })
    await ask(s.r, 'which node is online?')
    const prompts = (s.front.models.get('f')?.prompts ?? []).map((p) => JSON.stringify(p))
    const second = prompts[1] ?? ''
    expect(second).toContain('laptop-e')
    expect(second).toContain('online')
    expect(second).toContain('allowShell')
    const tools = (s.front.models.get('f')?.calls[0]?.tools ?? []).map(
      (t) => (t as { name: string }).name,
    )
    expect(tools).toContain('nodes_status')
    expect(tools).not.toContain('motor_remote')
    await sleep(0)
  })
})
