import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, secretsRepo, tokensRepo } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { testIo } from '../../../testing/cli-io.ts'
import { type CliDeps, configOf } from '../../context.ts'
import { runCoreCli } from '../../program.ts'
import type { Check, DoctorCtx } from '../types.ts'
import { setupCheck } from './setup.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const PIN = '482915'
const BASE = [
  'setup',
  '--non-interactive',
  '--owner-name',
  'Vian',
  '--provider',
  'scripted',
  '--front-model',
  'a',
  '--cortex-model',
  'b',
  '--budget',
  '30',
  '--owner-pin-stdin',
]

/** An installed core with its owner's PIN, built by the real setup command. */
async function installed(): Promise<CliDeps> {
  const dir = mkdtempSync(join(tmpdir(), 'keith-setup-check-'))
  dirs.push(dir)
  const deps: CliDeps = {
    env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'cli' },
    offline: {
      definitions: [scriptedProvider({ models: { a: [{ text: 'a' }], b: [{ text: 'b' }] } })],
      catalogs: { offline: true },
    },
    hasher: { memoryCost: 1024, timeCost: 1 },
  }
  const io = testIo()
  io.send(`${PIN}\n`)
  io.end()
  expect(await runCoreCli(BASE, io, deps)).toBe(0)
  return deps
}

/** The context a doctor run hands the setup check; `net` is what this check sets, so it starts empty. */
const ctxOf = (
  deps: CliDeps,
  checks: Check[] = [{ level: 'ok', name: 'database', hint: 'migrated' }],
): DoctorCtx => ({
  deps,
  config: configOf(deps),
  offline: true,
  checks,
  net: undefined as unknown as DoctorCtx['net'],
})

describe('setupCheck: owner sign-in', () => {
  test('ok with the kinds the owner has, when a PIN is set', async () => {
    const deps = await installed()
    const lines = setupCheck(ctxOf(deps)) as Check[]
    const line = lines.find((c) => c.name === 'owner sign-in')
    expect(line).toEqual({ level: 'ok', name: 'owner sign-in', hint: 'set: pin' })
  })

  test('fails with the setup command when the owner has no secret', async () => {
    const deps = await installed()
    const sqlite = openDatabase(configOf(deps).dbFile)
    secretsRepo(sqlite).clear(tokensRepo(sqlite).owner()?.id ?? '', 'pin')
    sqlite.close()
    const lines = setupCheck(ctxOf(deps)) as Check[]
    const line = lines.find((c) => c.name === 'owner sign-in')
    expect(line?.level).toBe('fail')
    expect(line?.hint).toContain('keith-core setup')
  })

  test('no line at all when the database check did not pass', () => {
    const deps: CliDeps = {
      env: { KEITH_DATA_DIR: mkdtempSync(join(tmpdir(), 'keith-setup-none-')) },
    }
    const checks: Check[] = [{ level: 'fail', name: 'database', hint: 'missing' }]
    expect(setupCheck(ctxOf(deps, checks))).toEqual([])
  })
})
