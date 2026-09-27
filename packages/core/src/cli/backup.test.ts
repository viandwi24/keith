// `keith backup` (docs/architecture/storage.md#backups).

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEITH_VERSION } from '../bootstrap.ts'
import { LOCK_FILE_NAME } from '../shared/index.ts'
import { openDb } from '../storage/index.ts'
import { knownMigrations, timestamp } from './backup.ts'
import { type Cleanups, cliIo, ownerHome, seed, startKeith, tempDir } from './backup-testing.ts'
import { runCli } from './index.ts'

const cleanups: Cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function onlyBackup(out: string): string {
  const entries = readdirSync(out)
  expect(entries).toHaveLength(1)
  return join(out, entries[0] ?? '')
}

describe('keith backup', () => {
  test('writes the manifest and every item, and no lock, logs or backups', async () => {
    const { home } = await ownerHome(cleanups)
    writeFileSync(join(home, 'persona.md'), 'You are Keith.')
    mkdirSync(join(home, 'files', 'ab'), { recursive: true })
    writeFileSync(join(home, 'files', 'ab', 'f1'), 'file one')
    mkdirSync(join(home, 'plugins', 'weather'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'weather', 'cache.json'), '{}')
    mkdirSync(join(home, 'logs'))
    writeFileSync(join(home, 'logs', 'keith.log'), 'line')
    writeFileSync(join(home, LOCK_FILE_NAME), '{}')
    mkdirSync(join(home, 'backups', 'older'), { recursive: true })
    // A link inside files/ is not followed (and not copied).
    symlinkSync('/etc/hosts', join(home, 'files', 'link'))

    const cli = cliIo(home)
    expect(await runCli(['backup'], cli)).toBe(0)
    const backups = readdirSync(join(home, 'backups')).filter((n) => n !== 'older')
    expect(backups).toEqual([`keith-backup-${timestamp(cli.clock?.now() ?? 0)}`])
    const dir = join(home, 'backups', backups[0] ?? '')

    expect(readdirSync(dir).sort()).toEqual([
      'config.toml',
      'files',
      'keith.db',
      'manifest.json',
      'persona.md',
      'plugins',
    ])
    expect(readFileSync(join(dir, 'files', 'ab', 'f1'), 'utf8')).toBe('file one')
    expect(existsSync(join(dir, 'files', 'link'))).toBe(false)
    expect(readFileSync(join(dir, 'plugins', 'weather', 'cache.json'), 'utf8')).toBe('{}')
    expect(readFileSync(join(dir, 'persona.md'), 'utf8')).toBe('You are Keith.')
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(
      readFileSync(join(home, 'config.toml'), 'utf8'),
    )

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest).toEqual({
      format: 1,
      keithVersion: KEITH_VERSION,
      createdAt: new Date(cli.clock?.now() ?? 0).toISOString(),
      lastMigration: (await knownMigrations()).at(-1),
    })

    const out = cli.lines.join('\n')
    expect(out).toContain(`Backup written to ${dir}`)
    expect(out).toContain('config.toml is copied as it is')
    expect(out).toContain('Skipped symbolic link')
  })

  test('--out picks the parent folder; a second backup in the same second gets a suffix', async () => {
    const { home } = await ownerHome(cleanups)
    const out = join(tempDir(cleanups), 'nested', 'out')
    expect(await runCli(['backup', '--out', out], cliIo(home))).toBe(0)
    expect(await runCli(['backup', '--out', out], cliIo(home))).toBe(0)
    const names = readdirSync(out).sort()
    expect(names).toHaveLength(2)
    expect(names[1]).toBe(`${names[0]}-2`)
    expect(existsSync(join(home, 'backups'))).toBe(false)
  })

  test('refuses an --out inside files/ and a home without a database', async () => {
    const { home } = await ownerHome(cleanups)
    const cli = cliIo(home)
    expect(await runCli(['backup', '--out', join(home, 'files', 'b')], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('would copy itself')

    const empty = tempDir(cleanups)
    const cli2 = cliIo(empty)
    expect(await runCli(['backup'], cli2)).toBe(1)
    expect(cli2.errors.join('\n')).toContain('nothing to back up')
  })

  test('works while a bootstrapped Keith is running, without touching its lock', async () => {
    const { home, owner } = await ownerHome(cleanups)
    const keith = await startKeith(home, cleanups)
    const seeded = await seed(keith, owner)
    const lock = readFileSync(join(home, LOCK_FILE_NAME), 'utf8')

    const out = tempDir(cleanups)
    const cli = cliIo(home)
    expect(await runCli(['backup', '--out', out], cli)).toBe(0)
    expect(readFileSync(join(home, LOCK_FILE_NAME), 'utf8')).toBe(lock)

    const dir = onlyBackup(out)
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false)
    expect(existsSync(join(dir, 'logs'))).toBe(false)
    const copy = openDb(join(dir, 'keith.db'))
    try {
      expect(await copy.repos.messages.get(seeded.messageId)).toMatchObject({
        content: 'Plant the tomatoes in May.',
      })
      expect(await copy.repos.memories.get(seeded.memoryId)).toMatchObject({ content: 'Tony grows tomatoes' })
    } finally {
      copy.close()
    }
    // Keith keeps working after the backup.
    expect((await fetch(`${keith.url}/v1/health`)).status).toBe(200)
  })
})
