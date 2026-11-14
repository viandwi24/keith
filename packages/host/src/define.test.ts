import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  defineKeithPlugin,
  defineOperation,
  PluginDefinitionError,
  type PluginManifest,
} from './index.ts'

const op = (name = 'say') =>
  defineOperation({
    name,
    description: 'Say something.',
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
    permission: { capability: 'authenticated' },
    run: (input) => ({ text: input.text }),
  })

const base = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'echo',
  version: '1.0.0',
  apiVersion: 1,
  operations: [op()],
  ...over,
})

const problemsOf = (m: PluginManifest): string[] => {
  try {
    defineKeithPlugin(m)
  } catch (e) {
    if (e instanceof PluginDefinitionError) return [...e.problems]
    throw e
  }
  return []
}

describe('defineKeithPlugin', () => {
  test('resolves operations into the one record', () => {
    const p = defineKeithPlugin(base())
    expect(p.id).toBe('echo')
    const o = p.operation('say')
    expect(o?.toolName).toBe('echo_say')
    expect(o?.route).toBe('/plugins/echo/say')
    expect(o?.audience).toBe('user')
    expect(o?.risk).toBe('write')
    expect(o?.expose).toEqual({ ai: true, http: true, call: true, guest: false })
    expect(Object.isFrozen(p)).toBe(true)
  })

  test('the operation fields are typed from the schema', () => {
    defineOperation({
      name: 'typed',
      description: 'x',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      permission: { capability: 'authenticated' },
      // n is a number here: a type error would fail check-types
      run: (input) => ({ n: input.n + 1 }),
    })
  })

  test.each(['', 'A', 'a', '1x', 'a_b', 'a--b', 'a-', 'x'.repeat(25)])(
    'refuses the id %p',
    (id) => {
      expect(problemsOf(base({ id })).length).toBeGreaterThan(0)
    },
  )

  test.each(['eh', 'app', 'acl', 'shell'])('refuses the reserved id %p', (id) => {
    expect(problemsOf(base({ id })).join()).toContain('reserved')
  })

  test('accepts a 24-character kebab id', () => {
    expect(problemsOf(base({ id: `a${'b'.repeat(10)}-${'c'.repeat(12)}` }))).toEqual([])
  })

  test('apiVersion must be 1', () => {
    expect(problemsOf(base({ apiVersion: 2 })).join()).toContain('apiVersion')
    expect(problemsOf(base({ apiVersion: undefined as never })).join()).toContain('apiVersion')
  })

  test('version must be major.minor.patch', () => {
    expect(problemsOf(base({ version: '1.0' })).join()).toContain('version')
  })

  test('operation names: format, length and duplicates', () => {
    expect(problemsOf(base({ operations: [op('Say')] })).join()).toContain('snake_case')
    expect(problemsOf(base({ operations: [op('x'.repeat(33))] })).join()).toContain('snake_case')
    expect(problemsOf(base({ operations: [op('say'), op('say')] })).join()).toContain('collide')
    expect(problemsOf(base({ operations: [] })).join()).toContain('at least one')
  })

  test('a plugin and an operation whose names join to the same tool name cannot both exist', () => {
    // ids hold no underscore, so `<id>_<op>` splits at the first underscore: the pair is unique
    const a = defineKeithPlugin(base({ id: 'notes', operations: [op('list_all')] }))
    const b = defineKeithPlugin(base({ id: 'notes-list', operations: [op('all')] }))
    expect(a.operations[0]?.toolName).toBe('notes_list_all')
    expect(b.operations[0]?.toolName).toBe('notes-list_all')
  })

  test('a capability must be core, authenticated or declared by the plugin', () => {
    const withCap = (capability: string): PluginManifest =>
      base({
        permissions: [{ id: 'echo.use', description: 'Use echo.' }],
        operations: [{ ...op(), permission: { capability } }],
      })
    expect(problemsOf(withCap('echo.use'))).toEqual([])
    expect(problemsOf(withCap('chat'))).toEqual([])
    expect(problemsOf(withCap('echo.other')).join()).toContain('declared in permissions')
    expect(problemsOf(withCap('nope')).join()).toContain('declared in permissions')
  })

  test('a missing capability fails closed', () => {
    const o = { ...op(), permission: {} as never }
    expect(problemsOf(base({ operations: [o] })).join()).toContain('permission.capability')
  })

  test('permission ids carry the plugin prefix and are not taken', () => {
    expect(
      problemsOf(base({ permissions: [{ id: 'other.use', description: 'x' }] })).join(),
    ).toContain('start with')
    expect(
      problemsOf(
        base({
          permissions: [
            { id: 'echo.use', description: 'x' },
            { id: 'echo.use', description: 'y' },
          ],
        }),
      ).join(),
    ).toContain('taken')
    expect(
      problemsOf(base({ permissions: [{ id: 'chat', description: 'x' }] })).length,
    ).toBeGreaterThan(0)
  })

  test('a resource rule needs a declared kind and valid bits', () => {
    const rule = (kind: string, bits: number): PluginManifest =>
      base({
        resources: { thing: { class: 'leaf' } },
        operations: [
          { ...op(), permission: { capability: 'authenticated', resource: { kind, bits } } },
        ],
      })
    expect(problemsOf(rule('thing', 4))).toEqual([])
    expect(problemsOf(rule('other', 4)).join()).toContain('not declared')
    expect(problemsOf(rule('thing', 9)).join()).toContain('bits')
  })

  test('a bad resource kind is found at definition', () => {
    expect(problemsOf(base({ resources: { 'Bad Kind': { class: 'leaf' } } })).join()).toContain(
      'resource kind',
    )
    expect(
      problemsOf(base({ resources: { wide: { class: 'leaf', defaultMode: 0o644 } } })).join(),
    ).toContain('resource kind')
  })

  test('audience, risk, rate limit and exposure are validated', () => {
    expect(
      problemsOf(base({ operations: [{ ...op(), audience: 'all' as never }] })).join(),
    ).toContain('audience')
    expect(problemsOf(base({ operations: [{ ...op(), risk: 'x' as never }] })).join()).toContain(
      'risk',
    )
    expect(
      problemsOf(base({ operations: [{ ...op(), rateLimit: { max: 0, windowMs: 5000 } }] })).join(),
    ).toContain('rateLimit')
    expect(
      problemsOf(
        base({ operations: [{ ...op(), expose: { ai: false, http: false, call: false } }] }),
      ).join(),
    ).toContain('exposes nothing')
  })

  test('services: format, duplicates, and not both required and provided', () => {
    expect(problemsOf(base({ provides: ['Bad'] })).join()).toContain('service id')
    expect(problemsOf(base({ requires: ['a.b', 'a.b'] })).join()).toContain('twice')
    expect(problemsOf(base({ requires: ['a.b'], provides: ['a.b'] })).join()).toContain('requires')
  })

  test('the tui slot is validated', () => {
    const load = async () => ({ default: () => null })
    const slot = (menu: unknown[], views: Record<string, unknown> = { list: load }) =>
      base({ tui: { menu, views } as never })
    const entry = { id: 'browse', label: 'Notes', view: 'list' }
    expect(problemsOf(slot([entry]))).toEqual([])
    expect(problemsOf(slot([{ ...entry, permission: 'authenticated' }]))).toEqual([])
    expect(problemsOf(slot([{ ...entry, label: '' }])).join()).toContain('tui')
    expect(problemsOf(slot([{ ...entry, view: 'nope' }])).join()).toContain('not in views')
    expect(problemsOf(slot([entry, entry])).join()).toContain('twice')
    expect(problemsOf(slot([{ ...entry, permission: 'x.unknown' }])).join()).toContain('permission')
    expect(problemsOf(slot([{ ...entry, audience: 'public' }])).join()).toContain('tui')
    expect(problemsOf(slot([entry], { list: 'not a function' })).join()).toContain('tui')
    expect(problemsOf(base({ tui: { views: ['list'] } as never })).join()).toContain('tui')
    expect(problemsOf(base({ tui: { extra: 1 } as never })).join()).toContain('tui')
  })

  test('every problem is listed, none comes from input data', () => {
    const problems = problemsOf(base({ id: 'Bad Id', version: 'x', apiVersion: 9, operations: [] }))
    expect(problems.length).toBeGreaterThanOrEqual(4)
  })

  test('garbage in does not throw anything but a PluginDefinitionError', () => {
    expect(() => defineKeithPlugin(null as never)).toThrow(PluginDefinitionError)
    expect(() => defineKeithPlugin({} as never)).toThrow(PluginDefinitionError)
  })
})

describe('expose.guest', () => {
  const guestOp = (over: Record<string, unknown>) =>
    defineOperation({
      name: 'peek_public',
      description: 'Read a public thing.',
      input: z.object({}),
      output: z.object({}),
      permission: { capability: 'authenticated' },
      run: () => ({}),
      ...over,
    })
  test('it needs audience public', () => {
    expect(problemsOf(base({ operations: [guestOp({ expose: { guest: true } })] }))).toEqual([
      expect.stringContaining("expose.guest needs audience: 'public'"),
    ])
    const ok = defineKeithPlugin(
      base({ operations: [guestOp({ audience: 'public', expose: { ai: false, guest: true } })] }),
    )
    expect(ok.operation('peek_public')?.expose).toEqual({
      ai: false,
      http: true,
      call: true,
      guest: true,
    })
  })
  test('a guest-only operation exposes something', () => {
    const p = defineKeithPlugin(
      base({
        operations: [
          guestOp({
            audience: 'public',
            expose: { ai: false, http: false, call: false, guest: true },
          }),
        ],
      }),
    )
    expect(p.operation('peek_public')?.expose.guest).toBe(true)
  })
})
