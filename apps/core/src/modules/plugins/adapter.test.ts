import { afterAll, describe, expect, test } from 'bun:test'
import { echoPlugin, type MemoryHost, memoryHost } from '@keith/host/testing'
import { defineHarnessAgent, definePlugin, type HarnessPlugin } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { compilePlugin } from './adapter.ts'

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const close of closers) await close()
})

function build(steps: Parameters<typeof scriptedModel>[0], extra: HarnessPlugin[] = []) {
  const host = memoryHost({ plugins: [echoPlugin()] })
  host.add('owner', 'owner')
  host.add('ana')
  host.add('bob')
  const compiled = compilePlugin(host.plugin('echo'), {
    guard: host.guard,
    directory: host.directory,
  })
  const agent = defineHarnessAgent({
    id: 'front',
    model: scriptedModel(steps),
    contextWindow: 100_000,
    plugins: [compiled, ...extra] as never,
  })
  closers.push(() => agent.close())
  return { agent, host }
}

const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  toolName: name,
  toolCallId: id,
  input,
})
const toolNames = async (
  agent: ReturnType<typeof build>['agent'],
  sessionId: string,
  person: string,
): Promise<string[]> =>
  (await agent.session(sessionId, { principal: { id: person } }).tools())
    .map((t) => t.name)
    .filter((n) => n.startsWith('echo_'))
    .sort()

describe('compiled plugin', () => {
  test('is one eharness plugin named k-<id>', () => {
    const { host } = build([{ text: 'x' }])
    const compiled = compilePlugin(host.plugin('echo'), {
      guard: host.guard,
      directory: host.directory,
    })
    expect(compiled.name).toBe('k-echo')
  })

  test('the catalog shows each person what their facts allow, not what ACL state says', async () => {
    const { agent, host } = build([{ text: 'x' }])
    const member = await toolNames(agent, 's-ana', 'ana')
    expect(member).toContain('echo_say')
    expect(member).toContain('echo_hello')
    expect(member).not.toContain('echo_admin')
    expect(member).not.toContain('echo_quiet')
    const owner = await toolNames(agent, 's-owner', 'owner')
    expect(owner).toContain('echo_admin')
    expect(owner).not.toContain('echo_quiet')
    // creating and sharing a resource does not move the list
    const { id } = (await host.call('echo', 'put', { text: 'x' }, 'ana')) as { id: string }
    host.acl.setEntry('echoitem', id, { subject: 'user:bob', bits: 4, effect: 'allow' }, 'ana')
    expect(await toolNames(agent, 's-bob', 'bob')).toEqual(await toolNames(agent, 's-ana', 'ana'))
  })

  test('a suspended person and an unknown principal get no plugin tools, and the list follows at once', async () => {
    const { agent, host } = build([{ text: 'x' }])
    expect((await toolNames(agent, 's-ana', 'ana')).length).toBeGreaterThan(0)
    host.suspend('ana')
    expect(await toolNames(agent, 's-ana', 'ana')).toEqual([])
    expect(await toolNames(agent, 's-nobody', 'nobody')).toEqual([])
    host.restore('ana')
    expect((await toolNames(agent, 's-ana', 'ana')).length).toBeGreaterThan(0)
  })

  test('STALENESS: two principals through one session get two actors', async () => {
    const { agent } = build([
      { toolCalls: [call('c1', 'echo_who')] },
      { text: 'one' },
      { toolCalls: [call('c2', 'echo_who')] },
      { text: 'two' },
    ])
    const session = agent.session('shared', { principal: { id: 'ana' } })
    await session.send('who?').result
    await session.send('who now?', { principal: { id: 'bob' } }).result
    const text = JSON.stringify(await session.messages())
    expect(text).toContain('"person":"ana"')
    expect(text).toContain('"person":"bob"')
    // the session facts are the ones of the live turn
    expect(text).toContain('"session":"shared"')
    expect(text).toContain('"kind":"front"')
  })

  test('a person suspended between two turns of one session is refused on the second', async () => {
    const { agent, host } = build([
      { toolCalls: [call('c1', 'echo_say', { text: 'a' })] },
      { text: 'one' },
      { toolCalls: [call('c2', 'echo_say', { text: 'b' })] },
      { text: 'two' },
    ])
    const session = agent.session('shared', { principal: { id: 'ana' } })
    await session.send('say a').result
    host.suspend('ana')
    await session.send('say b').result
    const text = JSON.stringify(await session.messages())
    expect(text).toContain('"output":{"text":"a"}')
    // the second call never reached run: the tool is gone from the catalog at the next turn
    expect(text).not.toContain('"output":{"text":"b"}')
    expect(text).toContain('unavailable tool')
  })

  test('tool.approve: a dangerous operation asks the person first', async () => {
    const { agent } = build([{ toolCalls: [call('w1', 'echo_wipe')] }, { text: 'done' }])
    const session = agent.session('s', { principal: { id: 'ana' } })
    await session.send('wipe').result
    const pending = await agent.peek('s').pending()
    expect(pending?.approvals.map((a) => a.toolName)).toEqual(['echo_wipe'])
  })

  test('tool.approve: a write operation runs without asking', async () => {
    const { agent } = build([
      { toolCalls: [call('p1', 'echo_put', { text: 'x' })] },
      { text: 'done' },
    ])
    const session = agent.session('s', { principal: { id: 'ana' } })
    await session.send('put').result
    expect((await agent.peek('s').pending())?.approvals ?? []).toEqual([])
    expect(JSON.stringify(await session.messages())).toContain('item-')
  })

  test('the model sees the standard text for a refusal and a generic one for a failure', async () => {
    const { agent } = build([
      { toolCalls: [call('b1', 'echo_boom')] },
      { text: 'failed' },
      { toolCalls: [call('g1', 'echo_get', { id: 'item-404' })] },
      { text: 'missing' },
    ])
    const session = agent.session('s', { principal: { id: 'ana' } })
    await session.send('boom').result
    await session.send('get').result
    const text = JSON.stringify(await session.messages())
    expect(text).toContain('the operation failed')
    expect(text).toContain('not found or not permitted')
    expect(text).not.toContain('secret-detail-from-db')
  })

  test('Open verification 5: toolMetadata of a source tool reaches tool.approve', async () => {
    const seen: unknown[] = []
    const spy = definePlugin({
      name: 'spy',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) => {
            if (e.toolName === 'echo_say') seen.push(e.toolMetadata ?? null)
          },
        },
      }),
    }) as unknown as HarnessPlugin
    const { agent } = build(
      [{ toolCalls: [call('s1', 'echo_say', { text: 'hi' })] }, { text: 'ok' }],
      [spy],
    )
    await agent.session('s', { principal: { id: 'ana' } }).send('say').result
    expect(seen).toHaveLength(1)
    // record what 0.12 gives us: the plan assumed `withToolFields` metadata arrives as `toolMetadata`
    expect(seen[0]).toMatchObject({ keithPlugin: 'echo', keithOperation: 'say' })
  })
})

describe('the guard is the only way in', () => {
  test('an operation hidden from the model cannot be called by the model', async () => {
    const { agent } = build([{ toolCalls: [call('q1', 'echo_quiet')] }, { text: 'done' }])
    const session = agent.session('s', { principal: { id: 'ana' } })
    await session.send('quiet').result
    // not in the catalog: the tool call is an unknown tool and never runs
    expect(JSON.stringify(await session.messages())).not.toContain('"ok":true')
  })
})

export type { MemoryHost }
