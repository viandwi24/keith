// Tests for builtins/memory.ts (the tools live outside this folder; their tests live with the fakes).

import { describe, expect, test } from 'bun:test'
import type { Tool, ToolRunContext } from '@keith/sdk'
import { createMemoryLogger } from '@keith/sdk/testing'
import { createMemoryTools } from '../builtins/memory.ts'
import type { PersonDto, TaskId, ThreadId } from '../shared/types.ts'
import { fixedId } from './testing/fakes.ts'
import { createHousehold, type Household, MISSION, PEPPER, TONY, TONY_MAIN } from './testing/fixture.ts'

function ctx(
  person: PersonDto,
  participants: PersonDto[],
  threadId: ThreadId | null,
  taskId: TaskId | null = null,
): ToolRunContext {
  return {
    person,
    participants,
    threadId,
    taskId,
    signal: new AbortController().signal,
    log: createMemoryLogger(),
    services: {
      get: () => {
        throw new Error('no services in tests')
      },
      find: () => undefined,
    },
  }
}

async function setup(): Promise<{ h: Household; tool: (name: string) => Tool }> {
  const h = await createHousehold()
  const tools = createMemoryTools({ memory: h.memory, persons: h.persons })
  return {
    h,
    tool: (name) => {
      const t = tools.find((x) => x.name === name)
      if (!t) throw new Error(`missing ${name}`)
      return t
    },
  }
}

async function run(tool: Tool, raw: unknown, t: ToolRunContext) {
  return tool.run(tool.input.parse(raw), t)
}

describe('memory tools', () => {
  test('are defined in the reserved memory namespace', async () => {
    const { h } = await setup()
    expect(createMemoryTools({ memory: h.memory, persons: h.persons }).map((t) => t.name)).toEqual([
      'memory.remember',
      'memory.recall',
      'memory.forget',
    ])
  })
})

describe('memory.remember', () => {
  test('direct thread defaults to subject visibility about the speaker', async () => {
    const { h, tool } = await setup()
    const r = await run(
      tool('memory.remember'),
      { content: 'I like espresso.' },
      ctx(h.dto.tony, [h.dto.tony], TONY_MAIN),
    )
    expect(r.error).toBeUndefined()
    const [m] = [...h.memories.rows.values()]
    expect(m).toMatchObject({
      subjectPersonId: TONY,
      visibility: 'subject',
      threadId: TONY_MAIN,
      source: 'stated',
      authorPersonId: TONY,
      pinned: false,
    })
  })

  test('group thread defaults to thread visibility', async () => {
    const { h, tool } = await setup()
    await run(
      tool('memory.remember'),
      { content: 'We meet at the tower.' },
      ctx(h.dto.tony, [h.dto.tony, h.dto.pepper], MISSION),
    )
    expect([...h.memories.rows.values()][0]).toMatchObject({ visibility: 'thread', threadId: MISSION })
  })

  test('a fact about someone else stays in the speaker thread by default', async () => {
    const { h, tool } = await setup()
    await run(
      tool('memory.remember'),
      { content: 'Pepper likes tulips.', subject: 'pepper' },
      ctx(h.dto.tony, [h.dto.tony], TONY_MAIN),
    )
    expect([...h.memories.rows.values()][0]).toMatchObject({
      subjectPersonId: PEPPER,
      visibility: 'thread',
      threadId: TONY_MAIN,
    })
  })

  test('household facts and pinning', async () => {
    const { h, tool } = await setup()
    await run(
      tool('memory.remember'),
      { content: 'Dinner is at eight.', subject: 'none', visibility: 'household', pinned: true },
      ctx(h.dto.pepper, [h.dto.pepper], null),
    )
    expect([...h.memories.rows.values()][0]).toMatchObject({
      subjectPersonId: null,
      visibility: 'household',
      pinned: true,
    })
  })

  test('inside a task the memory is inferred with no author', async () => {
    const { h, tool } = await setup()
    await run(
      tool('memory.remember'),
      { content: 'I prefer rivers.' },
      ctx(h.dto.tony, [h.dto.tony], TONY_MAIN, fixedId('tsk', 1)),
    )
    expect([...h.memories.rows.values()][0]).toMatchObject({ source: 'inferred', authorPersonId: null })
  })

  test.each([
    ['unknown subject', { content: 'x', subject: 'Obadiah' }],
    ['guest writing household', { content: 'x', visibility: 'household' }],
    ['guest writing owner', { content: 'x', visibility: 'owner' }],
    ['subject visibility about nobody', { content: 'x', subject: 'none', visibility: 'subject' }],
  ])('returns a tool error for %s', async (_name, input) => {
    const { h, tool } = await setup()
    const r = await run(tool('memory.remember'), input, ctx(h.dto.happy, [h.dto.happy], null))
    expect(r.error).toBe(true)
    expect(h.memories.rows.size).toBe(0)
  })
})

describe('memory.recall', () => {
  test('I-4: searches only what every participant may see', async () => {
    const { h, tool } = await setup()
    const secret = await h.memory.write({
      content: 'Tony armor schematics.',
      subjectPersonId: TONY,
      visibility: 'subject',
      source: 'stated',
    })
    const shared = await h.memory.write({
      content: 'Household armor polish.',
      subjectPersonId: null,
      visibility: 'household',
      source: 'stated',
    })

    const tony = await run(
      tool('memory.recall'),
      { query: 'armor' },
      ctx(h.dto.tony, [h.dto.tony], TONY_MAIN),
    )
    expect(tony.content).toContain(secret.id)
    expect(tony.content).toContain(shared.id)

    const group = await run(
      tool('memory.recall'),
      { query: 'armor' },
      ctx(h.dto.tony, [h.dto.tony, h.dto.pepper], MISSION),
    )
    expect(group.content).not.toContain(secret.id)
    expect(group.content).toContain(shared.id)

    const none = await run(tool('memory.recall'), { query: 'armor' }, ctx(h.dto.happy, [h.dto.happy], null))
    expect(none.content).toBe('No matching memories.')
  })
})

describe('memory.forget', () => {
  test('by a non-owner, non-subject person returns a tool error', async () => {
    const { h, tool } = await setup()
    const m = await h.memory.write({
      content: 'Tony hates tomatoes.',
      subjectPersonId: TONY,
      visibility: 'household',
      source: 'stated',
    })
    const r = await run(tool('memory.forget'), { id: m.id }, ctx(h.dto.pepper, [h.dto.pepper], null))
    expect(r.error).toBe(true)
    expect(h.memories.rows.has(m.id)).toBe(true)
  })

  test('by the subject deletes the memory', async () => {
    const { h, tool } = await setup()
    const m = await h.memory.write({
      content: 'Pepper likes tulips.',
      subjectPersonId: PEPPER,
      visibility: 'subject',
      source: 'stated',
    })
    const r = await run(tool('memory.forget'), { id: m.id }, ctx(h.dto.pepper, [h.dto.pepper], null))
    expect(r.error).toBeUndefined()
    expect(h.memories.rows.has(m.id)).toBe(false)
  })

  test('by the owner deletes a visible memory about someone else', async () => {
    const { h, tool } = await setup()
    const m = await h.memory.write({
      content: 'Pepper runs the company.',
      subjectPersonId: PEPPER,
      visibility: 'household',
      source: 'stated',
    })
    const r = await run(tool('memory.forget'), { id: m.id }, ctx(h.dto.tony, [h.dto.tony], null))
    expect(r.error).toBeUndefined()
    expect(h.memories.rows.has(m.id)).toBe(false)
  })

  test('I-4: an invisible memory reads as not found, even for the owner', async () => {
    const { h, tool } = await setup()
    const m = await h.memory.write({
      content: 'Pepper secret.',
      subjectPersonId: PEPPER,
      visibility: 'subject',
      source: 'stated',
    })
    const r = await run(tool('memory.forget'), { id: m.id }, ctx(h.dto.tony, [h.dto.tony], null))
    expect(r).toEqual({ content: `No memory ${m.id} is visible here.`, error: true })
    expect(h.memories.rows.has(m.id)).toBe(true)
  })

  test('rejects a malformed id at the schema', async () => {
    const { tool } = await setup()
    expect(tool('memory.forget').input.safeParse({ id: 'nope' }).success).toBe(false)
  })
})
