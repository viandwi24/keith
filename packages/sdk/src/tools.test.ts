import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { isKeithError, KeithError } from './errors.ts'
import { assertToolName, defineTool, TOOL_NAME_PATTERN } from './tools.ts'

const base = {
  description: 'd',
  input: z.object({}),
  minTier: 'owner' as const,
  run: async () => ({ content: 'ok' }),
}

describe('defineTool', () => {
  test.each(['weather.current', 'task.start', 'memory.recall', 'web.fetch_page', 'a1.b2.c3', 'my_ns.get_x'])(
    'accepts %s',
    (name) => {
      expect(defineTool({ ...base, name }).name).toBe(name)
    },
  )

  test.each([
    ['no namespace', 'current'],
    ['uppercase', 'Weather.current'],
    ['camelCase', 'weather.getCurrent'],
    ['double underscore', 'weather.get__current'],
    ['trailing underscore', 'weather.current_'],
    ['leading digit', 'weather.1current'],
    ['dash', 'weather.get-current'],
    ['empty segment', 'weather..current'],
    ['trailing dot', 'weather.'],
    ['space', 'weather.current now'],
  ])('rejects %s with TOOL_NAME_INVALID', (_why, name) => {
    let error: unknown
    try {
      defineTool({ ...base, name })
    } catch (e) {
      error = e
    }
    expect(isKeithError(error, 'TOOL_NAME_INVALID')).toBe(true)
    expect((error as KeithError).message).toContain(name)
  })

  test('assertToolName uses the same pattern', () => {
    expect(TOOL_NAME_PATTERN.test('weather.current')).toBe(true)
    expect(() => assertToolName('bad')).toThrow(KeithError)
  })

  test('run receives the parsed input type', async () => {
    const tool = defineTool({
      ...base,
      name: 'math.double',
      input: z.object({ n: z.number() }),
      run: async (input) => ({ content: String(input.n * 2) }),
    })
    const result = await tool.run(
      { n: 21 },
      {
        person: { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' },
        participants: [],
        threadId: null,
        taskId: null,
        signal: new AbortController().signal,
        log: { debug() {}, info() {}, warn() {}, error() {}, child: () => base as never },
        services: { get: () => undefined as never, find: () => undefined },
      },
    )
    expect(result).toEqual({ content: '42' })
  })
})
