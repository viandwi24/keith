// `keith setup` and `keith migrate` respect the KEITH_HOME lock (hardening D1).

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeClock } from '@keith/sdk/testing'
import { acquireHomeLock, LOCK_FILE_NAME } from '../shared/index.ts'
import { type CliIo, runCli, scriptedPrompter } from './index.ts'

const homes: string[] = []
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'keith-cli-lock-'))
  homes.push(home)
  return home
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function io(home: string, answers: string[] = []): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    env: { KEITH_HOME: home },
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    prompter: scriptedPrompter(answers),
    clock: createFakeClock(1_000),
    lines,
    errors,
  }
}

describe('keith commands and the home lock', () => {
  test('migrate fails while another holder has the lock, and works after release', async () => {
    const home = tempHome()
    const lock = await acquireHomeLock(home)
    const cli = io(home)
    expect(await runCli(['migrate'], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain(`pid ${process.pid}`)
    expect(existsSync(join(home, 'keith.db'))).toBe(false)
    await lock.release()
    expect(await runCli(['migrate'], cli)).toBe(0)
    expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(false)
  })

  test('setup fails while another holder has the lock, before asking anything', async () => {
    const home = tempHome()
    const lock = await acquireHomeLock(home)
    const cli = io(home)
    expect(await runCli(['setup'], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('already running')
    expect(existsSync(join(home, 'config.toml'))).toBe(false)
    await lock.release()
  })

  test('setup releases the lock when it finishes', async () => {
    const home = tempHome()
    const cli = io(home, ['1', '', 'n', 'n', '1', 'Tony', 'tony', 'secret-pass', 'secret-pass'])
    expect(await runCli(['setup'], cli)).toBe(0)
    expect(existsSync(join(home, 'config.toml'))).toBe(true)
    expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(false)
  })
})
