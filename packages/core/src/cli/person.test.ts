// P5-K1: the `keith person` command surface. P5-A1 replaces the placeholder tests with the
// behavior tests.

import { describe, expect, test } from 'bun:test'
import { runCli } from './index.ts'
import { PERSON_SUBCOMMANDS, PERSON_USAGE } from './person.ts'

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, cli: { env: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

describe('keith person (surface)', () => {
  test('without a subcommand prints the usage with every subcommand', async () => {
    const t = io()
    expect(await runCli(['person'], t.cli)).toBe(0)
    expect(t.out.join('\n')).toBe(PERSON_USAGE)
    for (const sub of PERSON_SUBCOMMANDS) expect(PERSON_USAGE).toContain(`  ${sub} `)
    expect(PERSON_USAGE).toContain('#invite=<code>')
  })

  test('the keith usage lists the person command', async () => {
    const t = io()
    expect(await runCli(['--help'], t.cli)).toBe(0)
    expect(t.out.join('\n')).toContain('person <command>')
  })

  test('an unknown subcommand is a usage error', async () => {
    const t = io()
    expect(await runCli(['person', 'rename'], t.cli)).toBe(2)
    expect(t.err[0]).toBe('Unknown person command: rename')
  })

  const calls: string[][] = [
    ['add', 'Pepper', '--tier', 'guest'],
    ['list'],
    ['invite', 'Pepper'],
    ['tier', 'Pepper', 'member'],
    ['card', 'Pepper', '--tone', 'warm'],
    ['block', 'Pepper', '--from', 'Happy'],
    ['unblock', 'Pepper', '--from', 'Happy'],
    ['remove', 'Pepper', '--yes'],
  ]
  for (const args of calls) {
    test(`keith person ${args.join(' ')} reaches the placeholder`, async () => {
      const t = io()
      expect(await runCli(['person', ...args], t.cli)).toBe(1)
      expect(t.err).toEqual([`keith person ${args[0]} is not implemented yet (P5-A1)`])
    })
  }
})
