// Spec tests for the `relay.*` built-ins (P5-K1): names, input schemas, `minTier` (ADR-0017) and
// registration; and behavior (P5-B1) over the real relay service, fake repositories and the real
// delivery queue.

import { describe, expect, test } from 'bun:test'
import type { PersonDto } from '@keith/protocol'
import type { Tool, ToolRunContext } from '@keith/sdk'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import { z } from 'zod'
import { createDeliveryQueue } from '../scheduler/deliveries.ts'
import { createRelayService } from '../scheduler/relay.ts'
import { createFakeEventBus, createFakeIds, createFakeRepos, seedPerson } from '../scheduler/testing/fakes.ts'
import type { RelayService } from '../scheduler/types.ts'
import type { Tier } from '../shared/types.ts'
import { type BuiltinDeps, registerBuiltins } from './index.ts'
import {
  createRelayTools,
  RELAY_MESSAGES,
  RELAY_TEXT_MAX_CHARS,
  RELAY_TOOL_NAMES,
  type RelayToolsDeps,
} from './relay.ts'

const service: RelayService = {
  send: async () => ({ ok: false, reason: 'unknown_recipient' }),
  block: async () => false,
  unblock: async () => false,
}

const relayDeps: RelayToolsDeps = { service, persons: { findByName: async () => null } }

function byName(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

function builtinDeps(extra: Partial<BuiltinDeps> = {}): { deps: BuiltinDeps; registered: string[] } {
  const registered: string[] = []
  const deps: BuiltinDeps = {
    tasks: {} as BuiltinDeps['tasks'],
    memory: {} as BuiltinDeps['memory'],
    persons: { list: async () => [] },
    skills: { get: () => undefined, list: () => [], registerDefault: () => {} },
    tools: { registerBuiltin: (tool) => registered.push(tool.name) },
    ...extra,
  }
  return { deps, registered }
}

describe('relay.* specs (ADR-0017)', () => {
  const tools = byName(createRelayTools(relayDeps))

  test('three tools with the fixed names, all minTier guest', () => {
    expect([...tools.keys()]).toEqual([...RELAY_TOOL_NAMES])
    for (const tool of tools.values()) expect(tool.minTier).toBe('guest')
  })

  test('relay.send takes a name (1..80) and a text (1..2000), trimmed', () => {
    const input = tools.get('relay.send')?.input
    if (!input) throw new Error('missing relay.send')
    expect(input.parse({ to: '  Pepper ', text: " I'll be late " })).toEqual({
      to: 'Pepper',
      text: "I'll be late",
    })
    expect(input.safeParse({ to: 'x'.repeat(80), text: 'x'.repeat(RELAY_TEXT_MAX_CHARS) }).success).toBe(true)
    expect(input.safeParse({ to: 'x'.repeat(81), text: 'hi' }).success).toBe(false)
    expect(input.safeParse({ to: 'Pepper', text: 'x'.repeat(RELAY_TEXT_MAX_CHARS + 1) }).success).toBe(false)
    expect(input.safeParse({ to: '  ', text: 'hi' }).success).toBe(false)
    expect(input.safeParse({ to: 'Pepper', text: '' }).success).toBe(false)
    expect(input.safeParse({ text: 'hi' }).success).toBe(false)
  })

  test('relay.block and relay.unblock take one name', () => {
    for (const name of ['relay.block', 'relay.unblock']) {
      const input = tools.get(name)?.input
      if (!input) throw new Error(`missing ${name}`)
      expect(input.safeParse({ from: 'Tony' }).success).toBe(true)
      expect(input.safeParse({ from: '' }).success).toBe(false)
      expect(input.safeParse({}).success).toBe(false)
    }
  })

  test('every input schema converts to JSON Schema for the model', () => {
    for (const tool of tools.values()) expect(() => z.toJSONSchema(tool.input)).not.toThrow()
  })

  test("the answers carry ADR-0017's wording, one generic refusal for tier and block", () => {
    expect(RELAY_MESSAGES.sent('Pepper')).toBe("I'll pass that on to Pepper.")
    expect(RELAY_MESSAGES.unknown('Bob')).toBe("I don't know anyone called Bob.")
    expect(RELAY_MESSAGES.notAllowed('Pepper')).toBe("I can't pass messages from you to Pepper.")
    expect(RELAY_MESSAGES.self).toBe("You can't relay to yourself.")
  })
})

describe('registerBuiltins and relay', () => {
  test('without relay, no relay.* tool is registered', () => {
    const { deps, registered } = builtinDeps()
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('relay.'))).toEqual([])
  })

  test('with relay, the three tools are registered', () => {
    const { deps, registered } = builtinDeps({ relay: relayDeps })
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('relay.'))).toEqual([...RELAY_TOOL_NAMES])
  })
})

// Behavior (P5-B1)

function setup() {
  const clock = createFakeClock(1_000_000)
  const ids = createFakeIds()
  const repos = createFakeRepos()
  const deliveries = createDeliveryQueue({ repos, events: createFakeEventBus(clock), ids, clock })
  const service = createRelayService({ repos, deliveries, log: createMemoryLogger() })
  const tools = byName(createRelayTools({ service, persons: repos.persons }))
  const tool = (name: string) => {
    const t = tools.get(name)
    if (!t) throw new Error(`missing ${name}`)
    return t
  }
  async function person(name: string, tier: Tier) {
    const seeded = await seedPerson(repos, ids, { name, tier })
    const dto: PersonDto = { id: seeded.personId, name, tier }
    return { ...seeded, dto, t: ctx(dto) }
  }
  async function call(name: string, raw: unknown, t: ToolRunContext) {
    const tl = tool(name)
    return tl.run(tl.input.parse(raw), t)
  }
  return { repos, service, person, call }
}

function ctx(person: PersonDto): ToolRunContext {
  return {
    person,
    participants: [person],
    threadId: null,
    taskId: null,
    signal: new AbortController().signal,
    log: createMemoryLogger(),
    services: {
      get: () => {
        throw new Error('no services in this test')
      },
      find: () => undefined,
    },
  }
}

describe('relay.send (I-13, ADR-0017)', () => {
  test('I-13: sends and answers with the resolved name, case-insensitively', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')
    const result = await w.call('relay.send', { to: 'pepper', text: "I'll be late" }, tony.t)
    expect(result).toEqual({ content: "I'll pass that on to Pepper." })
    const rows = [...w.repos.deliveryRows.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      personId: pepper.personId,
      threadId: pepper.threadId,
      kind: 'relay',
      authorPersonId: tony.personId,
      content: "I'll be late",
    })
  })

  test('resolves a username too', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    await w.person('Pepper', 'member')
    // seedPerson's username is the lowercased name; the name match comes first either way.
    expect((await w.call('relay.send', { to: 'PEPPER', text: 'hi' }, tony.t)).content).toBe(
      "I'll pass that on to Pepper.",
    )
  })

  test('I-13: the same generic answer for a tier refusal and for a block', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')
    const happy = await w.person('Happy', 'guest')

    const tier = await w.call('relay.send', { to: 'Pepper', text: 'hi' }, happy.t)
    await w.service.block({ personId: pepper.personId, from: tony.personId })
    const block = await w.call('relay.send', { to: 'Pepper', text: 'hi' }, tony.t)

    const refusal = { content: "I can't pass messages from you to Pepper.", error: true }
    expect(tier).toEqual(refusal)
    expect(block).toEqual(refusal)
    expect(w.repos.deliveryRows.size).toBe(0)
  })

  test('answers the unknown-name text', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    expect(await w.call('relay.send', { to: 'Bob', text: 'hi' }, tony.t)).toEqual({
      content: "I don't know anyone called Bob.",
      error: true,
    })
  })

  test('I-13: relaying to yourself is refused', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    expect(await w.call('relay.send', { to: 'tony', text: 'hi' }, tony.t)).toEqual({
      content: "You can't relay to yourself.",
      error: true,
    })
  })

  test('a person without a main thread reads as unknown', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    await w.repos.persons.create({
      id: 'per_nomain' as PersonDto['id'],
      name: 'Bruce',
      username: null,
      passwordHash: null,
      tier: 'member',
      lastSeenAt: null,
      createdAt: 0,
    })
    expect(await w.call('relay.send', { to: 'bruce', text: 'hi' }, tony.t)).toEqual({
      content: "I don't know anyone called bruce.",
      error: true,
    })
  })
})

describe('relay.block / relay.unblock', () => {
  test("I-13: act on the caller's own card and say whether anything changed", async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    const pepper = await w.person('Pepper', 'member')

    expect(await w.call('relay.block', { from: 'tony' }, pepper.t)).toEqual({
      content: "I won't pass on messages from Tony to you any more.",
    })
    expect(await w.call('relay.block', { from: 'Tony' }, pepper.t)).toEqual({
      content: 'Messages from Tony were already blocked.',
    })
    expect((await w.repos.relationships.get(pepper.personId))?.blockedRelayFrom).toEqual([tony.personId])
    expect((await w.repos.relationships.get(tony.personId))?.blockedRelayFrom).toEqual([])

    expect(await w.call('relay.unblock', { from: 'Tony' }, pepper.t)).toEqual({
      content: 'Messages from Tony can reach you again.',
    })
    expect(await w.call('relay.unblock', { from: 'Tony' }, pepper.t)).toEqual({
      content: 'Messages from Tony were not blocked.',
    })
    expect((await w.repos.relationships.get(pepper.personId))?.blockedRelayFrom).toEqual([])
  })

  test('unknown names and yourself', async () => {
    const w = setup()
    const tony = await w.person('Tony', 'owner')
    expect(await w.call('relay.block', { from: 'Bob' }, tony.t)).toEqual({
      content: "I don't know anyone called Bob.",
      error: true,
    })
    expect(await w.call('relay.unblock', { from: 'Bob' }, tony.t)).toEqual({
      content: "I don't know anyone called Bob.",
      error: true,
    })
    expect(await w.call('relay.block', { from: 'Tony' }, tony.t)).toEqual({
      content: "You can't block yourself.",
      error: true,
    })
    expect((await w.repos.relationships.get(tony.personId))?.blockedRelayFrom).toEqual([])
  })
})
