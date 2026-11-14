import { describe, expect, test } from 'bun:test'
import { type CommandEnv, runCommand } from './app-commands.ts'

function env(over: Partial<CommandEnv> = {}) {
  const said: string[][] = []
  const went: string[] = []
  const e: CommandEnv = {
    exit: () => went.push('exit'),
    go: (s) => went.push(s),
    openLogin: () => went.push('login'),
    openLogout: () => went.push('logout'),
    resetManage: () => {},
    openSuccession: () => {},
    toggleBrain: () => went.push('brain'),
    say: (_l, rows) => said.push([...rows]),
    clearNotice: () => {},
    isMember: false,
    identity: { status: 'loading' } as CommandEnv['identity'],
    core: 'unix:/x',
    health: undefined,
    roles: undefined,
    stepUp: {} as CommandEnv['stepUp'],
    room: () => {},
    persona: () => {},
    context: (name, args) => contexts.push([name, args]),
    dream: (args) => dreams.push(args),
    ...over,
  }
  return { e, said, went }
}

/** The `/new` and `/compact` calls the env received, in order. */
const contexts: Array<['new' | 'compact', string]> = []
const dreams: string[] = []

describe('slash commands offline', () => {
  const reason = 'cannot reach the core (unix:/x, connection refused)'
  test.each(['/manage', '/tasks', '/nodes', '/budget', '/stepup'])(
    '%s is refused with the hint',
    (line) => {
      const { e, said, went } = env({ offline: reason })
      runCommand(line, e)
      expect(went).toEqual([])
      expect(said).toEqual([[`offline: ${reason} · [r] retry now`]])
    },
  )

  test.each([
    ['/help', 'help'],
    ['/quit', 'exit'],
    ['/logout', 'logout'],
    ['/brain', 'brain'],
  ])('%s still works', (line, did) => {
    const { e, went } = env({ offline: reason })
    runCommand(line, e)
    expect(went).toEqual([did])
  })

  test('live, /tasks opens its screen', () => {
    const { e, went } = env()
    runCommand('/tasks', e)
    expect(went).toEqual(['tasks'])
  })
})

describe('/dream', () => {
  test('the arguments after the word go to the memory feature; offline it is refused', () => {
    dreams.length = 0
    const { e, said } = env()
    runCommand('/dream', e)
    runCommand('/dream mode propose', e)
    expect(dreams).toEqual(['', 'mode propose'])
    expect(said).toEqual([])
    const offline = env({ offline: 'no core' })
    runCommand('/dream now', offline.e)
    expect(dreams).toEqual(['', 'mode propose'])
    expect(offline.said).toEqual([['offline: no core · [r] retry now']])
  })
})

describe('/new and /compact', () => {
  test('the name and the arguments after it go to the chat context feature', () => {
    contexts.length = 0
    const { e, said } = env()
    runCommand('/new', e)
    runCommand('/new --no-flush', e)
    runCommand('/compact', e)
    expect(contexts).toEqual([
      ['new', ''],
      ['new', '--no-flush'],
      ['compact', ''],
    ])
    expect(said).toEqual([])
  })

  test('offline, /new and /compact are refused with the hint', () => {
    contexts.length = 0
    const reason = 'cannot reach the core (unix:/x, connection refused)'
    const { e, said } = env({ offline: reason })
    runCommand('/new', e)
    runCommand('/compact', e)
    expect(contexts).toEqual([])
    expect(said).toEqual([
      [`offline: ${reason} · [r] retry now`],
      [`offline: ${reason} · [r] retry now`],
    ])
  })
  test('/history opens its screen live; offline it is refused', () => {
    const { e, went, said } = env()
    runCommand('/history', e)
    expect(went).toEqual(['history'])
    const off = env({ offline: 'cannot reach the core (unix:/x, connection refused)' })
    runCommand('/history', off.e)
    expect(off.went).toEqual([])
    expect(off.said[0]?.[0]).toContain('offline:')
    expect(said).toEqual([])
  })
})
