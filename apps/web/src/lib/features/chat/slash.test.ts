import { describe, expect, test } from 'bun:test'
import { completion, parseSubmitted, suggestions, WEB_COMMANDS } from './slash.ts'

describe('suggestions', () => {
  test('a draft that starts with a slash lists the commands that start with it', () => {
    expect(suggestions('/').length).toBe(WEB_COMMANDS.length)
    expect(suggestions('/n').map((c) => c.name)).toEqual(['/new', '/new --no-flush'])
    expect(suggestions('/COM').map((c) => c.name)).toEqual(['/compact'])
    expect(suggestions('/zzz')).toEqual([])
  })

  test('plain text and multi-line drafts list nothing', () => {
    expect(suggestions('hello')).toEqual([])
    expect(suggestions('/new\nmore')).toEqual([])
    expect(suggestions('')).toEqual([])
  })

  test('no TUI-only command is offered', () => {
    const names = WEB_COMMANDS.map((c) => c.name)
    for (const tuiOnly of ['/quit', '/mouse', '/busy', '/free', '/presence']) {
      expect(names).not.toContain(tuiOnly)
    }
  })

  test('completion needs exactly one match that is not the draft', () => {
    expect(completion('/comp')).toBe('/compact')
    expect(completion('/compact')).toBeUndefined()
    expect(completion('/n')).toBeUndefined()
  })
})

describe('parseSubmitted', () => {
  test('plain text is a message, trimmed', () => {
    expect(parseSubmitted('  hello there \n')).toEqual({ kind: 'message', text: 'hello there' })
    expect(parseSubmitted('   ')).toEqual({ kind: 'empty' })
  })

  test('/new and /compact use the shared forms', () => {
    expect(parseSubmitted('/new')).toEqual({ kind: 'new', flush: true })
    expect(parseSubmitted('/new --no-flush')).toEqual({ kind: 'new', flush: false })
    expect(parseSubmitted('/compact')).toEqual({ kind: 'compact' })
    expect(parseSubmitted('/compact now').kind).toBe('usage')
    expect(parseSubmitted('/new later').kind).toBe('usage')
  })

  test('screens and replies', () => {
    expect(parseSubmitted('/history')).toEqual({ kind: 'history' })
    expect(parseSubmitted('/whoami')).toEqual({ kind: 'whoami' })
    expect(parseSubmitted('/help')).toEqual({ kind: 'help' })
    expect(parseSubmitted('/tasks')).toEqual({ kind: 'goto', path: '/tasks' })
    expect(parseSubmitted('/continue')).toEqual({ kind: 'continue' })
    expect(parseSubmitted('/retry')).toEqual({ kind: 'retry' })
  })

  test('an unknown command is not sent to the agent', () => {
    expect(parseSubmitted('/quit').kind).toBe('unknown')
  })
})
