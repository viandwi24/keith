import { describe, expect, test } from 'bun:test'
import { parseBrainEvent } from '@keith/contracts'
import { migrateDatabase, openDatabase, tasksRepo } from '@keith/db'
import type { HarnessAgent } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import type { Cortex } from '../cortex/index.ts'
import { attentionOptions } from './attention.ts'
import { watchPending } from './pending.ts'
import { APPROVAL_PING_KEY, APPROVAL_TTL_KEY, createApprovalSettings } from './settings.ts'

const DAY_MS = 24 * 3_600_000
const CLOCK = 1_700_000_000_000

const approval = (id: string, toolName = 'motor_remote') => ({
  kind: 'approval',
  id,
  toolCallId: `call-${id}`,
  toolName,
})

async function setup() {
  const inner = inMemoryActivityStore()
  const store = watchPending(inner, undefined, { ttlMs: () => DAY_MS, now: () => CLOCK })
  const pending = (sessionId: string, waiting: unknown[]) =>
    store.append({
      type: 'pending-changed',
      sessionId,
      agentId: 'cortex.general',
      payload: { turnId: 't', waiting, answered: [] },
    })
  const waits = async () => {
    await Bun.sleep(5)
    return (await inner.read({ after: 0, limit: 100 })).filter(
      (e) => e.type === 'brain.amygdala.wait',
    )
  }
  return { store, inner, pending, waits }
}

describe('watchPending', () => {
  test('an approval that starts waiting adds brain.amygdala.wait with the tool, session and count', async () => {
    const { pending, waits } = await setup()
    await pending('front:owner:agent:c1', [approval('a1')])
    const [wait] = await waits()
    expect(wait?.sessionId).toBe('front:owner:agent:c1')
    expect(wait?.agentId).toBe('cortex.general')
    expect(parseBrainEvent(wait as never)).toEqual({
      type: 'brain.amygdala.wait',
      payload: {
        region: 'amygdala',
        personId: 'owner',
        toolName: 'motor_remote',
        sessionId: 'front:owner:agent:c1',
        count: 1,
        approvalId: 'a1',
        expiresAt: CLOCK + DAY_MS,
      },
    })
  })

  test('a snapshot that repeats an announced approval adds nothing; a new one does, with the total', async () => {
    const { pending, waits } = await setup()
    await pending('s1', [approval('a1')])
    await pending('s1', [approval('a1')])
    expect((await waits()).length).toBe(1)
    await pending('s1', [approval('a1'), approval('a2', 'other_tool')])
    await pending('s2', [approval('b1')])
    const events = await waits()
    expect(
      events.map((e) => [
        e.sessionId,
        (e.payload as { toolName: string; count: number }).toolName,
        (e.payload as { count: number }).count,
      ]),
    ).toEqual([
      ['s1', 'motor_remote', 1],
      ['s1', 'other_tool', 2],
      ['s2', 'motor_remote', 3],
    ])
  })

  test('answered and cleared: the count falls, and the same id waiting again would be announced again', async () => {
    const { pending, waits } = await setup()
    await pending('s1', [approval('a1')])
    await pending('s1', [])
    await pending('s2', [approval('b1')])
    const events = await waits()
    expect(events.map((e) => (e.payload as { count: number }).count)).toEqual([1, 1])
    await pending('s1', [approval('a1')])
    expect((await waits()).length).toBe(3)
  })

  test("client tools, external waits and empty snapshots are not the amygdala's", async () => {
    const { pending, waits } = await setup()
    await pending('s1', [
      { kind: 'client-tool', id: 'c', toolCallId: 'c', toolName: 'ask' },
      { kind: 'wait', id: 'w', toolCallId: 'w', toolName: 'agent' },
    ])
    await pending('s1', [])
    expect(await waits()).toEqual([])
  })

  test('every other event passes through untouched and reads are delegated', async () => {
    const { store, inner } = await setup()
    const [record] = await store.append({
      type: 'task-changed',
      sessionId: null,
      agentId: null,
      payload: { a: 1 },
    })
    expect(record?.type).toBe('task-changed')
    expect(await store.lastSeq()).toBe(await inner.lastSeq())
    expect((await store.read({ after: 0, limit: 10 })).length).toBe(1)
    expect(await store.prunedThrough()).toBe(0)
  })

  test('a bad snapshot never breaks the append', async () => {
    const { store, waits } = await setup()
    await store.append({
      type: 'pending-changed',
      sessionId: 's1',
      agentId: null,
      payload: { waiting: 'nonsense' },
    })
    await store.append({
      type: 'pending-changed',
      sessionId: 's1',
      agentId: null,
      payload: null as never,
    })
    expect(await waits()).toEqual([])
  })
})

const OWNER_PERSON = {
  id: 'owner',
  username: 'owner',
  name: 'Owner',
  role: 'owner' as const,
  canLogin: true,
  status: 'active' as const,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
}

describe('attentionOptions', () => {
  function build(approvals?: { ttlMs: () => number }) {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const tasks = tasksRepo(sqlite)
    tasks.upsert({
      id: 'front:owner:agent:c1',
      parentSessionId: 'front:owner',
      agent: 'cortex.general',
      description: 'd',
      status: 'waiting',
      steps: 1,
      summary: null,
      error: null,
      createdAt: 1,
      finishedAt: null,
    })
    tasks.upsert({
      id: 'front:ana:agent:w1',
      parentSessionId: 'front:ana',
      agent: 'cortex.general',
      description: 'ana task',
      status: 'waiting',
      steps: 1,
      summary: null,
      error: null,
      createdAt: 1,
      finishedAt: null,
    })
    const seen: string[] = []
    const agentOf = (name: string) =>
      ({
        peek: (id: string) => {
          seen.push(`${name}:peek:${id}`)
          return { name } as never
        },
        session: (id: string, options?: unknown) => {
          seen.push(
            `${name}:session:${id}:${options === undefined ? '' : JSON.stringify(Object.keys(options as object))}`,
          )
          return { name } as never
        },
      }) as unknown as HarnessAgent
    const cortex = {
      worker: (key: string) => (key === 'cortex.general' ? agentOf('general') : undefined),
    } as unknown as Cortex
    const lock = { acquire: () => undefined } as never
    const options = attentionOptions({
      generations: { current: () => 0 },
      lead: () => agentOf('front'),
      cortex,
      tasks,
      people: {
        list: async () => [OWNER_PERSON],
        get: async () => OWNER_PERSON,
      },
      store: inMemoryActivityStore(),
      lock,
      ...(approvals === undefined ? {} : { approvals }),
    })
    return { options, seen }
  }
  const call = {
    principal: { personId: 'owner', role: 'owner' as const },
    request: new Request('http://x'),
  }

  test('the root is the front session of the person; remember is allowed', async () => {
    const { options } = build()
    expect(await options.roots(call)).toEqual(['front:owner'])
    expect(options.allowRemember).toBe(true)
  })

  test('each session is read and opened on the agent that runs it', async () => {
    const { options, seen } = build()
    await options.peek('front:owner', { parentSessionId: null })
    await options.peek('front:owner:agent:c1', {
      parentSessionId: 'front:owner',
      agent: 'cortex.general',
    })
    // the catalog key falls back to the task row
    await options.peek('front:owner:agent:c1', { parentSessionId: 'front:owner' })
    expect(
      await options.peek('front:owner:agent:zz', {
        parentSessionId: 'front:owner',
        agent: 'cortex.nope',
      }),
    ).toBeUndefined()
    await options.open('front:owner', call)
    await options.open('front:owner:agent:c1', call)
    expect(() => options.open('front:owner:agent:zz', call)).toThrow(/no agent runs session/)
    expect(seen).toEqual([
      'front:peek:front:owner',
      'general:peek:front:owner:agent:c1',
      'general:peek:front:owner:agent:c1',
      'front:session:front:owner:["lock","principal"]',
      'general:session:front:owner:agent:c1:',
    ])
  })

  test('a person answers for their own front session and its workers only', async () => {
    const { options } = build()
    const can = (sessionId: string, personId = 'owner') =>
      options.canAnswer?.({
        ...call,
        principal: { personId, role: 'owner' },
        sessionId,
        attentionId: 'x',
      })
    expect(await can('front:owner')).toBe(true)
    expect(await can('front:owner:agent:c1')).toBe(true)
    expect(await can('front:owner:agent:other')).toBe(false)
    expect(await can('front:guest')).toBe(false)
    expect(await can('front:owner:agent:c1', 'guest')).toBe(false)
  })

  test('the list says how old each approval is, when it expires, and whether "allow for task" applies', async () => {
    const HOUR = 3_600_000
    const { options } = build({ ttlMs: () => 24 * HOUR })
    const decorate = options.decorate as (item: unknown, call: unknown) => Promise<unknown>
    const createdAt = Date.now() - 3 * HOUR
    const item = (sessionId: string, toolName: string) => ({
      kind: 'approval',
      sessionId,
      toolName,
      input: { node: 'nas', capability: 'shell.exec', input: { command: 'ls' } },
      createdAt,
    })
    const owner = await decorate(item('front:owner:agent:c1', 'other_tool'), call)
    expect(owner).toMatchObject({
      scopable: true,
      expiresAt: createdAt + 24 * HOUR,
    })
    expect((owner as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(3 * HOUR)
    // the owner answering a member's shell approval: nothing it answers sets a grant
    const ownerOfMember = await decorate(item('front:ana:agent:w1', 'motor_remote'), call)
    expect(ownerOfMember).toMatchObject({ askedBy: 'owner', scopable: false })
    // a member's own shell approval waits for the owner: read only, no grant either
    const member = await decorate(item('front:ana:agent:w1', 'motor_remote'), {
      ...call,
      principal: { personId: 'ana', role: 'member' },
    })
    expect(member).toMatchObject({ waitingFor: 'owner', scopable: false })
    // no lifetime configured: the item carries no expiry
    const bare = build().options.decorate as (item: unknown, call: unknown) => Promise<unknown>
    expect(await bare(item('front:owner:agent:c1', 'other_tool'), call)).toEqual({
      scopable: true,
    })
  })

  test('the audit event names the agent that decided', () => {
    const { options } = build()
    const agentId = options.agentId as (sessionId: string) => string | undefined
    expect(agentId('front:owner')).toBe('front')
    expect(agentId('front:owner:agent:c1')).toBe('cortex.general')
  })
})

describe('approval trail (the audit reads it)', () => {
  const secret = `keith_${'s'.repeat(24)}`
  const command = `curl -H ${secret} https://example.test/${'a'.repeat(300)}`
  const pendingItem = {
    approvalId: 'ap1',
    toolName: 'motor_remote',
    input: { node: 'laptop', capability: 'shell.exec', input: { command } },
  }
  function build(role: 'owner' | 'member') {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const agent = {
      peek: () => ({ pending: async () => ({ approvals: [pendingItem] }) }),
      session: () => ({}),
    } as unknown as HarnessAgent
    const person = (id: string) => ({
      ...OWNER_PERSON,
      id,
      username: id,
      role: id === 'owner' ? ('owner' as const) : role,
    })
    return attentionOptions({
      generations: { current: () => 0 },
      lead: () => agent,
      cortex: { worker: () => undefined } as unknown as Cortex,
      tasks: tasksRepo(sqlite),
      people: { list: async () => [], get: async (id: string) => person(id) },
      store: inMemoryActivityStore(),
    })
  }
  const item = (sessionId: string) => ({
    id: 'ap1',
    kind: 'approval' as const,
    sessionId,
    toolCallId: 'c',
    toolName: 'motor_remote',
    input: pendingItem.input,
  })

  test('describes the node, capability and a redacted command capped at 200 characters', async () => {
    const options = build('owner')
    const described = await options.describeApproval('front:owner', 'ap1')
    expect(described?.node).toBe('laptop')
    expect(described?.capability).toBe('shell.exec')
    expect(described?.command).toContain('[redacted]')
    expect(described?.command).not.toContain(secret)
    expect(described?.command?.length).toBeLessThanOrEqual(200)
    expect(await options.describeApproval('front:owner', 'gone')).toBeUndefined()
  })

  test("the owner's session grant is kept; a member's is applied as once", async () => {
    const options = build('member')
    const defaultParse = () => ({
      kind: 'approval' as const,
      approved: true,
      remember: 'session' as const,
    })
    await options.parseAnswer?.({ item: item('front:owner'), body: {}, defaultParse })
    expect(options.appliedRemember('front:owner', 'ap1')).toBe('session')
    await options.parseAnswer?.({ item: item('front:member'), body: {}, defaultParse })
    expect(options.appliedRemember('front:member', 'ap1')).toBe('once')
  })
})

describe('approval lifetime setting', () => {
  function memorySettings(initial: Record<string, unknown> = {}) {
    const values = new Map<string, unknown>(Object.entries(initial))
    return {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key: string, value: unknown) => {
        values.set(key, value)
      },
    }
  }

  test('defaults to 24 hours and reads a corrupt stored value as the default', () => {
    expect(createApprovalSettings(memorySettings()).ttlHours()).toBe(24)
    expect(createApprovalSettings(memorySettings({ [APPROVAL_TTL_KEY]: 'x' })).ttlHours()).toBe(24)
    expect(createApprovalSettings(memorySettings({ [APPROVAL_TTL_KEY]: 999 })).ttlHours()).toBe(24)
    expect(createApprovalSettings(memorySettings({ [APPROVAL_TTL_KEY]: 0 })).ttlMs()).toBe(
      24 * 3_600_000,
    )
  })

  test('accepts 1 to 168 hours and refuses anything else without storing it', () => {
    const store = memorySettings()
    const approvals = createApprovalSettings(store)
    approvals.setTtlHours(3)
    expect(approvals.ttlHours()).toBe(3)
    approvals.setTtlHours(168)
    expect(approvals.ttlMs()).toBe(168 * 3_600_000)
    for (const bad of [0, 169, 1.5, Number.NaN]) {
      expect(() => approvals.setTtlHours(bad)).toThrow(RangeError)
    }
    expect(approvals.ttlHours()).toBe(168)
    // at or below the ping in force (default 2) is refused too
    for (const low of [1, 2]) expect(() => approvals.setTtlHours(low)).toThrow(RangeError)
    expect(approvals.ttlHours()).toBe(168)
  })

  test('the ping defaults to 2, stays below the lifetime, and a pair is checked as one step', () => {
    const store = memorySettings()
    const approvals = createApprovalSettings(store)
    expect(approvals.pingBeforeHours()).toBe(2)
    expect(
      createApprovalSettings(memorySettings({ [APPROVAL_PING_KEY]: 'x' })).pingBeforeHours(),
    ).toBe(2)
    expect(() => approvals.setPingBeforeHours(0)).toThrow(RangeError)
    expect(() => approvals.setPingBeforeHours(24)).toThrow(RangeError)
    approvals.setPingBeforeHours(6)
    expect(() => approvals.setTtlHours(6)).toThrow(RangeError)
    approvals.setTtlHours(7)
    expect(approvals.set({ ttlHours: 5, pingBeforeHours: 4 })).toEqual([
      { key: APPROVAL_TTL_KEY, from: 7, to: 5 },
      { key: APPROVAL_PING_KEY, from: 6, to: 4 },
    ])
    // a pair that leaves the ping at the lifetime is refused and writes neither value
    expect(() => approvals.set({ ttlHours: 4, pingBeforeHours: 4 })).toThrow(RangeError)
    expect(approvals.ttlHours()).toBe(5)
    expect(approvals.pingBeforeHours()).toBe(4)
    expect(() => approvals.setTtlHours(4)).toThrow(RangeError)
  })
})
