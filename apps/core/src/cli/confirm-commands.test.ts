import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError, UsageError } from '@keith/cli'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'
import { askFirst } from './prompt-helpers.ts'

// The destructive commands that ask first (FD13-04, FD13-09). Without a terminal and without --yes they refuse before
// they reach the core, so these tests need no running core: no data folder is opened, nothing is sent.
let dir: string
let deps: CliDeps

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'keith-confirm-'))
  deps = { env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' } }
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** An io that looks like a terminal to the prompt, with the given answer line queued. */
function ttyIo(answer?: string) {
  const io = { ...testIo(), isTTY: true }
  if (answer !== undefined) io.send(answer)
  return io
}

describe('askFirst: the prompt', () => {
  test('y answers yes: the command goes on and the question names the change', async () => {
    const io = ttyIo('y\n')
    await askFirst(io, 'groups delete', 'delete group family?', false)
    expect(io.out()).toContain('delete group family? [y/N]')
  })

  test('n answers no: the command stops with a message and changes nothing', async () => {
    const io = ttyIo('n\n')
    const err = await askFirst(io, 'groups delete', 'delete group family?', false).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).exitCode).toBe(1)
    expect((err as CliError).message).toBe('nothing was changed')
  })

  test('Enter takes the default, which is no', async () => {
    const io = ttyIo('\n')
    await expect(askFirst(io, 'rooms end', 'end room r1?', false)).rejects.toBeInstanceOf(CliError)
  })
})

describe('askFirst: --yes and no terminal', () => {
  test('--yes skips the prompt: nothing is asked or read', async () => {
    const io = testIo()
    await askFirst(io, 'acl chown', 'hand room r1 to ana?', true)
    expect(io.out()).toBe('')
  })

  test('no terminal and no --yes refuses with a usage error (exit 2) and never acts', async () => {
    const io = testIo()
    const err = await askFirst(io, 'guests end', 'end guest session g1?', false).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UsageError)
    expect((err as UsageError).message).toBe(
      'guests end asks first: run it in a terminal or pass --yes',
    )
    expect(io.out()).toBe('')
  })
})

describe('keith-core commands that ask first', () => {
  const commands: string[][] = [
    ['plugin', 'enable', 'reminders'],
    ['plugin', 'disable', 'reminders'],
    ['groups', 'delete', 'family'],
    ['acl', 'chown', 'note', 'n1', 'ana'],
    ['rooms', 'end', 'r1'],
    ['guests', 'end', 'g1'],
  ]

  for (const argv of commands) {
    test(`${argv.join(' ')} without a terminal and without --yes refuses with exit 2`, async () => {
      const io = testIo()
      const code = await runCoreCli(argv, io, deps)
      expect(code).toBe(2)
      expect(io.err()).toContain(`${argv[0]} ${argv[1]} asks first`)
      expect(io.err()).toContain('pass --yes')
    })
  }

  test('a terminal answer no stops the command with exit 1 before the core is reached', async () => {
    const io = ttyIo('n\n')
    const code = await runCoreCli(['groups', 'delete', 'family'], io, deps)
    expect(code).toBe(1)
    expect(io.out()).toContain('delete group family?')
    expect(io.out()).toContain('[y/N]')
    expect(io.err()).toContain('nothing was changed')
  })

  test('--help lists the --yes flag of each command', async () => {
    for (const argv of commands) {
      const io = testIo()
      await runCoreCli([...argv.slice(0, 2), '--help'], io, deps)
      expect(io.out()).toContain('--yes')
    }
  })
})
