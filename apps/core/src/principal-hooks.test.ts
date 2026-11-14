/**
 * Hook level of the principal (ADR-0069, docs/specs/people.md "Isolation"): the person is set when
 * a front session opens, and every hook of every kind of turn reads it as `ctx.principal`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { defineHarnessAgent, definePlugin } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { frontSessionId, frontSessionOptions } from './platform/sessions.ts'

interface Seen {
  hook: string
  session: string
  kind: string | undefined
  person: string | undefined
}

function build(steps: Parameters<typeof scriptedModel>[0]) {
  const seen: Seen[] = []
  const watch = definePlugin({
    name: 'watch',
    setup: () => ({
      tools: {
        ping: tool({ description: 'ping', inputSchema: z.object({}), execute: () => 'pong' }),
      },
      hooks: {
        'turn.prepare': (ctx) => {
          seen.push({
            hook: 'turn.prepare',
            session: ctx.session.id,
            kind: ctx.turn?.kind,
            person: ctx.principal?.id,
          })
        },
        'tool.approve': (ctx) => {
          seen.push({
            hook: 'tool.approve',
            session: ctx.session.id,
            kind: ctx.turn?.kind,
            person: ctx.principal?.id,
          })
          return { type: 'user-approval' as const, reason: 'ask' }
        },
      },
    }),
  })
  const agent = defineHarnessAgent({
    id: 'front',
    model: scriptedModel(steps),
    contextWindow: 100_000,
    plugins: [watch] as never,
  })
  return { agent, seen }
}

const report = (taskId: string) => ({
  name: 'subagent',
  text: `Background subagent ${taskId} finished. Found it.`,
  data: { sessionId: taskId, agent: 'cortex.research', status: 'completed', taskId },
})
const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const close of closers) await close()
})

describe('principal at the hook level', () => {
  test('a wake turn runs under the principal of the session it wakes, never another person', async () => {
    const { agent, seen } = build([{ text: 'for ana' }, { text: 'for bob' }])
    closers.push(() => agent.close())
    const ana = agent.session(
      frontSessionId('ana', 0),
      frontSessionOptions(frontSessionId('ana', 0)),
    )
    const bob = agent.session(
      frontSessionId('bob', 0),
      frontSessionOptions(frontSessionId('bob', 0)),
    )
    // both reports are queued before either wake turn starts
    const a = await ana.inject('eh.event', report('front:ana:agent:c1'), {
      deliver: 'next-turn',
      wake: true,
    })
    const b = await bob.inject('eh.event', report('front:bob:agent:c2'), {
      deliver: 'next-turn',
      wake: true,
    })
    await Promise.all([a.run?.result, b.run?.result])
    const wakes = seen.filter((s) => s.hook === 'turn.prepare')
    expect(wakes.length).toBeGreaterThanOrEqual(2)
    for (const s of wakes) expect(s.person).toBe(s.session === 'front:ana' ? 'ana' : 'bob')
    // a report is stored in the session it belongs to only
    const aText = JSON.stringify(await ana.messages())
    const bText = JSON.stringify(await bob.messages())
    expect(aText).toContain('front:ana:agent:c1')
    expect(aText).not.toContain('front:bob')
    expect(bText).toContain('front:bob:agent:c2')
    expect(bText).not.toContain('front:ana')
  })

  test('a continuation answered by another person keeps the principal of the one who asked', async () => {
    const { agent, seen } = build([
      { toolCalls: [{ toolName: 'ping', toolCallId: 'p1', input: {} }] },
      { text: 'done' },
    ])
    closers.push(() => agent.close())
    const id = frontSessionId('ana', 0)
    const session = agent.session(id, frontSessionOptions(id))
    await session.send('ping please').result
    const pending = await agent.peek(id).pending()
    const approval = pending?.approvals[0]
    expect(approval).toBeDefined()
    // the owner answers for ana
    const run = session.respond({
      approvals: [{ id: approval?.approvalId as string, approved: true, actor: { id: 'owner' } }],
    })
    await run.result
    const after = seen.filter((s) => s.kind === 'respond')
    expect(after.length).toBeGreaterThan(0)
    for (const s of seen) expect(s.person).toBe('ana')
  })

  test('a session stored before principals gets its person at the next open', async () => {
    const { agent, seen } = build([{ text: 'one' }, { text: 'two' }])
    closers.push(() => agent.close())
    const id = frontSessionId('ana', 0)
    await agent.session(id).send('old core').result
    expect(seen.at(-1)?.person).toBeUndefined()
    await agent.closeSession(id)
    await agent.session(id, frontSessionOptions(id)).send('new core').result
    expect(seen.at(-1)?.person).toBe('ana')
  })
})
