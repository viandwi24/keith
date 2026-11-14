import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../platform/config.ts'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'

// `keith-core persona show|template|history` (docs/specs/prefrontal.md "CLI", P33.2.6). show and history read the database
// offline; template changes the persona through the running core and does nothing without --yes.
let b: BootedCore
let db: Sqlite
let deps: CliDeps

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
})

afterAll(async () => {
  db.close()
  await b.stop()
})

async function cli(...argv: string[]) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, out: io.out(), err: io.err() }
}

describe('persona show', () => {
  test('prints the seeded persona: the professional template at version 1, with its text', async () => {
    const shown = await cli('persona', 'show')
    expect(shown.code).toBe(0)
    expect(shown.out).toContain('version: 1')
    expect(shown.out).toContain('template: professional')
    expect(shown.out).toContain('answer failed:')
  })
})

describe('persona template', () => {
  test('without --yes it does nothing: the persona stays as it was', async () => {
    const out = await cli('persona', 'template', 'friend')
    expect(out.code).toBe(0)
    expect(out.out).toContain('nothing changed')
    expect((await b.local.rpc.persona.get()).version).toBe(1)
  })

  test('an unknown template is a usage error and nothing changes', async () => {
    const out = await cli('persona', 'template', 'pirate', '--yes')
    expect(out.code).toBe(2)
    expect(out.err).toContain('no template pirate')
    expect((await b.local.rpc.persona.get()).version).toBe(1)
  })

  test('with --yes the running core switches the template: version 2, and the history lists it', async () => {
    const switched = await cli('persona', 'template', 'friend', '--yes')
    expect(switched.code).toBe(0)
    expect(switched.out).toContain('persona set to friend (version 2)')
    const shown = await cli('persona', 'show')
    expect(shown.out).toContain('template: friend')
    const history = await cli('persona', 'history')
    expect(history.code).toBe(0)
    expect(history.out).toContain('VERSION')
    expect(history.out.split('\n').filter((line) => /^2\s/.test(line))).toHaveLength(1)
  })

  test('a missing id is a usage error', async () => {
    expect((await cli('persona', 'template', '--yes')).code).toBe(2)
  })
})

describe('persona history', () => {
  test('lists every version newest first, with the reason and the template', async () => {
    const history = await cli('persona', 'history')
    const rows = history.out
      .split('\n')
      .slice(1)
      .filter((line) => line.trim() !== '')
    expect(rows[0]).toMatch(/^2\s.*template\s+friend/)
    expect(rows[1]).toMatch(/^1\s.*template\s+professional/)
  })
})

describe('persona in the help', () => {
  test('--help lists show, template and history', async () => {
    const top = await cli('--help')
    expect(top.out).toContain('persona')
    const help = await cli('persona', '--help')
    expect(help.code).toBe(0)
    expect(help.out).toContain('show')
    expect(help.out).toContain('template')
    expect(help.out).toContain('history')
  })
})
