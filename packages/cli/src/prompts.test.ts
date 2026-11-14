import { describe, expect, test } from 'bun:test'
import { PromptCancelled, UsageError } from './errors.ts'
import { ask, askHidden, confirm, select } from './prompts.ts'
import { fakeIo } from './testing/fake-io.ts'

const CHOICES = [
  { value: 'openrouter', label: 'OpenRouter', hint: 'recommended' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'skip', label: 'Skip' },
]

describe('ask', () => {
  test('returns the typed line and shows the default in brackets', async () => {
    const io = fakeIo()
    io.send('Vian\n')
    expect(await ask('Your name', { default: 'owner', io })).toBe('Vian')
    expect(io.out()).toContain('Your name [owner]: ')
  })

  test('Enter accepts the default', async () => {
    const io = fakeIo()
    io.send('\n')
    expect(await ask('Budget', { default: '20', io })).toBe('20')
  })

  test('validate re-asks until the value is fine', async () => {
    const io = fakeIo()
    io.send('abc\n42\n')
    const value = await ask('Budget', {
      io,
      validate: (v) => (/^\d+$/.test(v) ? undefined : 'Enter a number'),
    })
    expect(value).toBe('42')
    expect(io.out()).toContain('Enter a number')
  })

  test('several prompts share one piped stdin', async () => {
    const io = fakeIo()
    io.send('one\ntwo\n')
    expect(await ask('a', { io })).toBe('one')
    expect(await ask('b', { io })).toBe('two')
  })

  test('end of input without a default is a usage error', async () => {
    const io = fakeIo()
    io.end()
    await expect(ask('Your name', { io })).rejects.toBeInstanceOf(UsageError)
  })

  test('terminal: echoes typed characters and handles backspace', async () => {
    const io = fakeIo({ tty: true })
    const p = ask('Name', { io })
    io.send('Viax\u007fn\r')
    expect(await p).toBe('Vian')
    expect(io.rawCalls).toEqual([true, false])
  })
})

describe('askHidden', () => {
  test('terminal: nothing is echoed and raw mode is restored', async () => {
    const io = fakeIo({ tty: true })
    const p = askHidden('API key', { io })
    io.send('sk-secret-value\r')
    expect(await p).toBe('sk-secret-value')
    expect(io.out()).not.toContain('sk-secret')
    expect(io.out()).toContain('API key')
    expect(io.rawCalls).toEqual([true, false])
  })

  test('piped: reads one line without a prompt', async () => {
    const io = fakeIo()
    io.send('sk-piped\nignored\n')
    expect(await askHidden('API key', { io })).toBe('sk-piped')
    expect(io.out()).toBe('')
  })

  test('validate re-asks', async () => {
    const io = fakeIo()
    io.send('short\nlongenough\n')
    const value = await askHidden('Key', {
      io,
      validate: (v) => (v.length < 8 ? 'Too short' : undefined),
    })
    expect(value).toBe('longenough')
    expect(io.out()).toContain('Too short')
  })

  test('Ctrl+C restores the terminal and cancels', async () => {
    const io = fakeIo({ tty: true })
    const p = askHidden('API key', { io })
    io.send('sk-x\u0003')
    await expect(p).rejects.toBeInstanceOf(PromptCancelled)
    expect(io.rawCalls).toEqual([true, false])
    expect(io.out()).toContain('\u001b[?25h')
  })
})

describe('select', () => {
  test('piped: picks by number, shows the numbered list', async () => {
    const io = fakeIo()
    io.send('2\n')
    expect(await select('Provider', CHOICES, { io })).toBe('openai')
    expect(io.out()).toContain('1. OpenRouter (recommended)')
    expect(io.out()).toContain('Type 1-3')
  })

  test('piped: Enter takes the default, bad input re-asks', async () => {
    const io = fakeIo()
    io.send('9\n\n')
    expect(await select('Provider', CHOICES, { default: 'skip', io })).toBe('skip')
    expect(io.out()).toContain('Enter a number from 1 to 3')
  })

  test('terminal: arrow keys move and Enter picks', async () => {
    const io = fakeIo({ tty: true })
    const p = select('Provider', CHOICES, { io })
    io.send('\u001b[B\u001b[B\u001b[A')
    io.send('\r')
    expect(await p).toBe('openai')
    expect(io.rawCalls).toEqual([true, false])
  })

  test('terminal: wraps from the first choice upwards', async () => {
    const io = fakeIo({ tty: true })
    const p = select('Provider', CHOICES, { io })
    io.send('\u001b[A\r')
    expect(await p).toBe('skip')
  })

  test('terminal: Ctrl+C cancels and restores', async () => {
    const io = fakeIo({ tty: true })
    const p = select('Provider', CHOICES, { io })
    io.send('\u0003')
    await expect(p).rejects.toBeInstanceOf(PromptCancelled)
    expect(io.rawCalls).toEqual([true, false])
  })
})

describe('confirm', () => {
  test('piped: y, n, default and re-ask', async () => {
    const io = fakeIo()
    io.send('y\nno\n\nmaybe\nn\n')
    expect(await confirm('Go?', { default: false, io })).toBe(true)
    expect(await confirm('Go?', { default: true, io })).toBe(false)
    expect(await confirm('Go?', { default: true, io })).toBe(true)
    expect(await confirm('Go?', { default: true, io })).toBe(false)
    expect(io.out()).toContain('Answer y or n')
  })

  test('terminal: a single key answers', async () => {
    const io = fakeIo({ tty: true })
    const p = confirm('Go?', { default: true, io })
    io.send('n')
    expect(await p).toBe(false)
    expect(io.out()).toContain('no\n')
  })
})

describe('askHidden keeps secrets as typed', () => {
  test('a trailing space survives piped input; only the line ending goes', async () => {
    const io = fakeIo()
    io.send('pass phrase \r\n')
    expect(await askHidden('Secret', { io })).toBe('pass phrase ')
  })
})
